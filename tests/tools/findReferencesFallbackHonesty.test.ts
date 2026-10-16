/**
 * find_references — the name-based fallback, when the xref bridge cannot answer.
 *
 * Two ways its number misled, found on a traditional VM:
 *   - the declaring method's own declaration ("public void foo(") counted as a
 *     call to foo;
 *   - a table target got a number with no word that its declarative references
 *     (form data sources, relations, entity mappings) are not in it, while an EDT
 *     target already says "inconclusive".
 */
import { describe, expect, it } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

interface MethodRow { name: string; parent_name: string; source: string }

/** A read DB for the fallback: FTS method rows, and object types by name. */
function fakeDb(methods: MethodRow[], types: Record<string, string>) {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: (arg: string) => {
        if (sql.includes('symbols_fts')) {
          return methods.map(m => ({ ...m, file_path: `K:\\\\${m.parent_name}.xml`, model: 'M', source_snippet: m.source }));
        }
        if (sql.includes('SELECT DISTINCT type, model')) return types[arg] ? [{ type: types[arg], model: 'M' }] : [];
        return [];
      },
    }),
  };
}

const run = async (args: Record<string, unknown>, db: any) =>
  (await findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: { getReadDb: () => db, db } } as any,
  )).content[0].text as string;

describe('find_references fallback — a method is not its own caller', () => {
  const methods: MethodRow[] = [
    // The declaring method: its body opens with the declaration.
    { name: 'calcTotal', parent_name: 'MyCalc', source: 'public real calcTotal(real _qty)\n{\n    return _qty * 2;\n}' },
    // A real caller.
    { name: 'run', parent_name: 'MyJob', source: 'public void run()\n{\n    real t = calc.calcTotal(3);\n}' },
  ];

  it('counts the caller and not the declaration', async () => {
    const text = await run({ targetName: 'calcTotal', targetType: 'method' }, fakeDb(methods, {}));
    expect(text).toContain('**Total References Found:** 1');
    expect(text).toContain('MyJob.run');
    expect(text).not.toContain('MyCalc.calcTotal');
  });

  it('skips a declaration with a default parameter value, and still counts an assignment', async () => {
    const withDefault: MethodRow[] = [
      { name: 'calcTotal', parent_name: 'MyCalc', source: 'public real calcTotal(real _qty = 1)\n{\n    return _qty * 2;\n}' },
      // Recursive call written as an assignment inside the declaring method.
      { name: 'calcTotal', parent_name: 'MyCalc2', source: 'public real calcTotal()\n{\n    real t = this.calcTotal();\n    return t;\n}' },
    ];
    const text = await run({ targetName: 'calcTotal', targetType: 'method' }, fakeDb(withDefault, {}));
    expect(text).toContain('**Total References Found:** 1');
    expect(text).toContain('MyCalc2.calcTotal');
    expect(text).not.toContain('MyCalc.calcTotal');
  });

  it('still counts a recursive call inside the declaring method', async () => {
    const recursive: MethodRow[] = [
      { name: 'walk', parent_name: 'Tree', source: 'public void walk(Node _n)\n{\n    if (_n) this.walk(_n.next());\n}' },
    ];
    const text = await run({ targetName: 'walk', targetType: 'method' }, fakeDb(recursive, {}));
    expect(text).toContain('**Total References Found:** 1');
    expect(text).toContain('Tree.walk');
  });
});

describe('find_references fallback — a table target says what it leaves out', () => {
  it('warns that metadata references are not counted for targetType table', async () => {
    const text = await run({ targetName: 'CustTable', targetType: 'table' }, fakeDb([], {}));
    expect(text).toContain('For a table this counts X++ code only');
    expect(text).toContain('form data sources');
  });

  it('warns too when a bare name resolves to a table', async () => {
    const text = await run({ targetName: 'CustTable' }, fakeDb([], { CustTable: 'table' }));
    expect(text).toContain('For a table this counts X++ code only');
  });

  it('says nothing of the kind for a class', async () => {
    const text = await run({ targetName: 'MyCalc' }, fakeDb([], { MyCalc: 'class' }));
    expect(text).not.toContain('For a table this counts');
  });
});

describe('find_references fallback — an enum value', () => {
  // Without the bridge, "Enum::Value" used to search for "Value::" (the member name
  // alone) and so found nothing: a false 0 for every enum value.
  const methods: MethodRow[] = [
    { name: 'post', parent_name: 'MyPosting', source: 'public void post()\n{\n    if (salesTable.SalesStatus == SalesStatus::Invoiced) { return; }\n}' },
    { name: 'ship', parent_name: 'MyShipping', source: 'public void ship()\n{\n    salesTable.SalesStatus = SalesStatus::Delivered;\n}' },
    { name: 'other', parent_name: 'MyOther', source: 'public void other()\n{\n    x = SalesStatus::InvoicedPartly;\n}' },
  ];

  it('finds "Enum::Value" and only that value', async () => {
    for (const targetName of ['SalesStatus::Invoiced', 'SalesStatus.Invoiced']) {
      const text = await run({ targetName, targetType: 'enum' }, fakeDb(methods, { SalesStatus: 'enum' }));
      expect(text).toContain('**Total References Found:** 1');
      expect(text).toContain('MyPosting.post');
      expect(text).not.toContain('MyShipping.ship');
      expect(text).not.toContain('MyOther.other');
    }
  });
});
