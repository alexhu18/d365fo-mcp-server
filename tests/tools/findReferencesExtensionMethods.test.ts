/**
 * find_references — methods added by [ExtensionOf] classes, and bare method names.
 *
 * DYNAMICSXREFDB records a method an extension class adds to a table or class
 * under the EXTENSION class only: on a live database "PurchLine.myDeliveryNote" has 5
 * callers, all on "/Classes/MyPurchLine_Extension/Methods/myDeliveryNote", and
 * "/Tables/PurchLine/Methods/myDeliveryNote" does not exist. "Owner.method" used to
 * query only the owner's path and report 0. A bare method name reached the bridge
 * as a bare name, which it expands to type paths — matching nothing for a method.
 */
import { describe, expect, it, vi } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

interface FakeIndex {
  /** name -> symbol type ('table', 'class', …) for object symbols */
  types: Record<string, string>;
  /** method name -> declaring parents */
  methods: Record<string, string[]>;
  /** class-extension rows */
  extensions: Array<{ extension_name: string; base_object_name: string; added_methods: string[] }>;
}

/** A read DB that answers the three queries find_references makes, by their SQL. */
function fakeDb(index: FakeIndex) {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: (arg: string) => {
        if (sql.includes('FROM extension_metadata')) {
          return index.extensions
            .filter(e => e.base_object_name.toLowerCase() === arg.toLowerCase())
            .map(e => ({ extension_name: e.extension_name, added_methods: JSON.stringify(e.added_methods) }));
        }
        if (sql.includes('SELECT DISTINCT parent_name')) {
          return (index.methods[arg] ?? []).map(parent_name => ({ parent_name }));
        }
        if (sql.includes('SELECT DISTINCT type, model')) {
          return index.types[arg] ? [{ type: index.types[arg], model: 'M' }] : [];
        }
        return [];
      },
    }),
  };
}

function context(index: FakeIndex, refsByPath: Record<string, number>) {
  const bridge = {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async (path: string) => {
      const n = refsByPath[path] ?? 0;
      return {
        objectPath: path, count: n,
        references: Array.from({ length: n }, (_, i) => ({
          sourcePath: `/Classes/Caller${i}/Methods/run`, sourceModule: 'M', line: 10 + i, column: 1,
          referenceType: 'call', callerClass: `Caller${i}`, callerMethod: 'run',
        })),
      };
    }),
  };
  const db = fakeDb(index);
  return {
    bridge,
    ctx: { symbolIndex: { getReadDb: () => db, db }, bridge } as any,
  };
}

const run = async (args: Record<string, unknown>, ctx: any) =>
  (await findReferencesTool({ method: 'tools/call', params: { name: 'find_references', arguments: args } } as any, ctx))
    .content[0].text as string;

const INDEX: FakeIndex = {
  types: { PurchLine: 'table', MyPurchLine_Extension: 'class', CustTable: 'table', MyHelper: 'class' },
  methods: {
    myDeliveryNote: ['MyPurchLine_Extension'],
    uniqueHelperMethod: ['MyHelper'],
    find: Array.from({ length: 40 }, (_, i) => `Table${i}`),
  },
  extensions: [
    { extension_name: 'MyPurchLine_Extension', base_object_name: 'PurchLine', added_methods: ['myDeliveryNote', 'myQtyConverter'] },
    { extension_name: 'OtherPurchLine_Extension', base_object_name: 'PurchLine', added_methods: ['somethingElse'] },
  ],
};

describe('find_references — methods added by an extension class', () => {
  it('finds "Owner.method" callers recorded under the [ExtensionOf] class', async () => {
    const { ctx, bridge } = context(INDEX, { '/Classes/MyPurchLine_Extension/Methods/myDeliveryNote': 5 });
    const text = await run({ targetName: 'PurchLine.myDeliveryNote', targetType: 'method' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('/Tables/PurchLine/Methods/myDeliveryNote');
    expect(bridge.findReferences).toHaveBeenCalledWith('/Classes/MyPurchLine_Extension/Methods/myDeliveryNote');
    // Only the extension that declares the method, not every extension of the owner.
    expect(bridge.findReferences).not.toHaveBeenCalledWith('/Classes/OtherPurchLine_Extension/Methods/myDeliveryNote');
    expect(text).toContain('**Total:** 5 reference(s) found');
  });

  it('matches the extension method case-insensitively, as X++ does', async () => {
    const { ctx, bridge } = context(INDEX, {});
    await run({ targetName: 'purchline.myqtyconverter', targetType: 'method' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('/Classes/MyPurchLine_Extension/Methods/myqtyconverter');
  });

  it('lists the extension path among the resolved ones when nothing calls it', async () => {
    const { ctx } = context(INDEX, {});
    const text = await run({ targetName: 'PurchLine.myDeliveryNote', targetType: 'method' }, ctx);
    expect(text).toContain('scoped to the declaring type');
    expect(text).toContain('/Classes/MyPurchLine_Extension/Methods/myDeliveryNote');
  });
});

describe('find_references — a bare method name', () => {
  it('queries the types that declare it instead of a bare name', async () => {
    const { ctx, bridge } = context(INDEX, { '/Classes/MyPurchLine_Extension/Methods/myDeliveryNote': 5 });
    const text = await run({ targetName: 'myDeliveryNote', targetType: 'method' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('/Classes/MyPurchLine_Extension/Methods/myDeliveryNote');
    expect(bridge.findReferences).not.toHaveBeenCalledWith('myDeliveryNote');
    expect(text).toContain('**Total:** 5 reference(s) found');
  });

  it('also resolves a bare name without targetType when it is not a type name', async () => {
    const { ctx, bridge } = context(INDEX, { '/Classes/MyHelper/Methods/uniqueHelperMethod': 2 });
    await run({ targetName: 'uniqueHelperMethod' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('/Classes/MyHelper/Methods/uniqueHelperMethod');
  });

  it('keeps a type name a type lookup', async () => {
    const { ctx, bridge } = context(INDEX, { CustTable: 3 });
    await run({ targetName: 'CustTable' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('CustTable');
  });

  it('keeps an EDT or enum name a type lookup, even when a method has that name', async () => {
    // EDTs and enums own no members, so they are not xref member containers — but a
    // bare name that is one is still a type, not a method.
    const index: FakeIndex = {
      ...INDEX,
      types: { ...INDEX.types, MyAmountEdt: 'edt', MyStatusEnum: 'enum' },
      methods: { ...INDEX.methods, MyAmountEdt: ['MyHelper'], MyStatusEnum: ['MyHelper'] },
    };
    for (const name of ['MyAmountEdt', 'MyStatusEnum']) {
      const { ctx, bridge } = context(index, {});
      await run({ targetName: name }, ctx);
      expect(bridge.findReferences).toHaveBeenCalledWith(name);
      expect(bridge.findReferences).not.toHaveBeenCalledWith(`/Classes/MyHelper/Methods/${name}`);
    }
  });

  it('stays a bare-name lookup when too many types declare the method', async () => {
    const { ctx, bridge } = context(INDEX, {});
    await run({ targetName: 'find', targetType: 'method' }, ctx);
    expect(bridge.findReferences).toHaveBeenCalledWith('find');
    expect(bridge.findReferences).toHaveBeenCalledTimes(1);
  });
});
