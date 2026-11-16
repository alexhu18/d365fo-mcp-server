import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  compareWithRuntime,
  extractODataActionNames,
  findODataExtendsRuntime,
  parseODataExtendsRuntime,
  scanODataActions,
} from '../../src/tools/sdlc/odataActionGuard';

// --- ODataExtends.runtime, in the shape xppc writes it (captured on a CHE box, fields trimmed) ---
const ARRAYS = 'xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays"';
const field = (name: string) =>
  `<a:KeyValueOfstringAxODataFieldLjh4bohd><a:Key>${name}</a:Key><a:Value><Name>${name}</Name><Mandatory>false</Mandatory>` +
  `<XppType>String</XppType><IsKey>false</IsKey></a:Value></a:KeyValueOfstringAxODataFieldLjh4bohd>`;
const action = (name: string, method: string, binding = 'BoundToEntitySet', collection = '<Items/>') =>
  `<a:KeyValueOfstringAxODataActionLjh4bohd><a:Key>${name}</a:Key><a:Value><Name>${name}</Name>` +
  `<BindingKind>${binding}</BindingKind><CollectionAttributes>${collection}</CollectionAttributes>` +
  `<FieldLookupName i:nil="true"/><MethodName>${method}</MethodName></a:Value></a:KeyValueOfstringAxODataActionLjh4bohd>`;
const entry = (entity: string, actions: string[], fields: string[] = ['dataAreaId']) =>
  `${entity}\t<AxODataResource xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${entity}</Name>` +
  `<Actions>${actions.length ? `<Items ${ARRAYS}>${actions.join('')}</Items>` : `<Items ${ARRAYS}/>`}</Actions>` +
  `<CollectionName>${entity}s</CollectionName><ConfigurationKey/><Fields><Items ${ARRAYS}>${fields.map(field).join('')}</Items></Fields>` +
  `<IsReadOnly>true</IsReadOnly><PublicEntityName>${entity}</PublicEntityName></AxODataResource>`;
const runtimeFile = (...lines: string[]) => `﻿${lines.map(l => `${l}\r\n`).join('')}`;

const entitySource = (methods: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
  `\t<Name>E</Name>\n\t<SourceCode>\n\t\t<Methods>\n\t\t\t<Method>\n\t\t\t\t<Name>m</Name>\n\t\t\t\t<Source><![CDATA[\n${methods}\n]]></Source>\n` +
  `\t\t\t</Method>\n\t\t</Methods>\n\t</SourceCode>\n</AxDataEntityView>\n`;

describe('parseODataExtendsRuntime', () => {
  it("reads each entity's action names, keyed by the AOT name before the tab", () => {
    const parsed = parseODataExtendsRuntime(
      runtimeFile(
        entry('ProbeEntity', [action('ExistingAction', 'existingAction')], ['dataAreaId', 'ProbeId', 'Name']),
        entry('PlainEntity', []),
      ),
    );
    expect([...parsed]).toEqual([
      ['ProbeEntity', ['ExistingAction']],
      ['PlainEntity', []],
    ]);
  });

  it('never takes a field or a collection attribute for an action', () => {
    const lookup = action(
      'BudgetRuleLookup',
      'lookupBudgetTransferRule',
      'BoundToEntitySet',
      '<Items><a:KeyValueOfstringAxODataCollectionAttributeLjh4bohd><a:Key>_fields</a:Key><a:Value><Name>_fields</Name>' +
        '</a:Value></a:KeyValueOfstringAxODataCollectionAttributeLjh4bohd></Items>',
    );
    const instance = action('GetProjectTypes', 'GetProjectTypes', 'BoundToEntityInstance');
    const parsed = parseODataExtendsRuntime(runtimeFile(entry('BudgetEntity', [lookup, instance], ['ExistingAction'])));
    expect(parsed.get('BudgetEntity')).toEqual(['BudgetRuleLookup', 'GetProjectTypes']);
  });

  it('reads a package without entities — a bare BOM — as empty', () => {
    expect(parseODataExtendsRuntime('﻿').size).toBe(0);
  });

  it('accepts LF line endings and no BOM', () => {
    const parsed = parseODataExtendsRuntime(`${entry('A', [action('X', 'x')])}\n${entry('B', [])}\n`);
    expect(parsed.get('A')).toEqual(['X']);
    expect(parsed.get('B')).toEqual([]);
  });
});

describe('extractODataActionNames', () => {
  it("takes the attribute's first argument, not the method name", () => {
    const src = entitySource(
      `[SysODataActionAttribute('ExistingAction', false)]\npublic static str existingAction(str _id) { return ''; }`,
    );
    expect(extractODataActionNames(src)).toEqual(['ExistingAction']);
  });

  it('accepts double quotes, the suffix-less form and a combined attribute list', () => {
    const src = entitySource(
      [
        '[SysODataActionAttribute("First", true)]',
        "[SysODataAction('Second', false)]",
        '[Hookable(false), SysODataActionAttribute( "Third" , true)]',
      ].join('\n'),
    );
    expect(extractODataActionNames(src)).toEqual(['First', 'Second', 'Third']);
  });

  it('ignores commented-out actions and names that are not literals', () => {
    const src = entitySource(
      [
        "// [SysODataActionAttribute('Old', true)]",
        "/* [SysODataActionAttribute('Older', true)] */",
        '[SysODataActionAttribute(#ActionName, true)]',
        "[SysODataActionAttribute('Live', true)]",
      ].join('\n'),
    );
    expect(extractODataActionNames(src)).toEqual(['Live']);
  });
});

describe('compareWithRuntime', () => {
  it('reports only the declared actions an entry lacks, ignoring case', () => {
    const missing = compareWithRuntime(
      new Map([
        ['ProbeEntity', ['ExistingAction', 'NewAction']],
        ['Other', ['run']],
      ]),
      new Map([
        ['probeentity', ['existingaction']],
        ['Other', ['Run']],
      ]),
    );
    expect(missing).toEqual([{ entity: 'ProbeEntity', actions: ['NewAction'] }]);
  });

  it('skips an entity with no entry — a non-public entity has none', () => {
    expect(compareWithRuntime(new Map([['Private', ['Act']]]), new Map())).toEqual([]);
  });
});

// --- the package on disk ---------------------------------------------------------------------
const PKG = 'MyPkg';
const MODEL = 'MyModel';
const OLD = new Date('2026-01-01T00:00:00Z');
const NEWER = new Date('2026-02-01T00:00:00Z');

let root: string;
const src = (type: string, name: string) => path.join(root, PKG, MODEL, type, `${name}.xml`);
const meta = (type: string, name: string) => path.join(root, PKG, 'XppMetadata', MODEL, type, `${name}.xml`);
const bin = (name = `Dynamics.AX.${PKG}.ODataExtends.runtime`) => path.join(root, PKG, 'bin', name);

function write(file: string, content: string, mtime = OLD) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtime, mtime);
}
/** An element compiled after its last edit: metadata newer than source. */
function compiled(type: string, name: string, source: string) {
  write(src(type, name), source, OLD);
  write(meta(type, name), '<x/>', NEWER);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'odata-guard-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findODataExtendsRuntime', () => {
  it('matches the assembly name case-insensitively and skips the extensions file', async () => {
    write(bin(`Dynamics.AX.${PKG.toUpperCase()}.ODataExtends.runtime`), '﻿');
    write(bin(`Dynamics.AX.${PKG}.ODataExtensionsExtends.runtime`), '﻿');
    expect(await findODataExtendsRuntime(path.join(root, PKG, 'bin'), PKG)).toBe(
      bin(`Dynamics.AX.${PKG.toUpperCase()}.ODataExtends.runtime`),
    );
  });

  it('falls back to the only ODataExtends.runtime when the assembly is named otherwise', async () => {
    write(bin('Dynamics.AX.OtherName.ODataExtends.runtime'), '﻿');
    expect(await findODataExtendsRuntime(path.join(root, PKG, 'bin'), PKG)).toBe(
      bin('Dynamics.AX.OtherName.ODataExtends.runtime'),
    );
  });

  it('is null without a bin folder', async () => {
    expect(await findODataExtendsRuntime(path.join(root, PKG, 'bin'), PKG)).toBeNull();
  });
});

describe('scanODataActions', () => {
  const withAction = entitySource(
    `[SysODataActionAttribute('ExistingAction', false)]\npublic static str existingAction() { return ''; }`,
  );
  const withoutAction = entitySource('public void insert() { super(); }');

  it('flags a changed entity with actions — the case that lost ExistingAction', async () => {
    write(meta('AxDataEntityView', 'ProbeEntity'), '<x/>', OLD);
    write(src('AxDataEntityView', 'ProbeEntity'), withAction, NEWER);
    write(bin(), runtimeFile(entry('ProbeEntity', [action('ExistingAction', 'existingAction')])));

    const r = await scanODataActions(root, root, PKG);

    expect(r.recompiled).toEqual(['AxDataEntityView/ProbeEntity']);
    expect(r.missing).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('does not call an action just added to a changed entity "already missing"', async () => {
    write(meta('AxDataEntityView', 'ProbeEntity'), '<x/>', OLD);
    write(src('AxDataEntityView', 'ProbeEntity'), entitySource([
      "[SysODataActionAttribute('ExistingAction', false)]",
      "[SysODataActionAttribute('NewAction', false)]",
    ].join('\n')), NEWER);
    write(bin(), runtimeFile(entry('ProbeEntity', [action('ExistingAction', 'existingAction')])));

    const r = await scanODataActions(root, root, PKG);

    expect(r.recompiled).toEqual(['AxDataEntityView/ProbeEntity']);
    expect(r.missing).toEqual([]);
  });

  it('flags an entity with actions that was never compiled', async () => {
    write(src('AxDataEntityView', 'NewEntity'), withAction, NEWER);
    expect((await scanODataActions(root, root, PKG)).recompiled).toEqual(['AxDataEntityView/NewEntity']);
  });

  it('reports actions an earlier incremental build already dropped, though nothing changed', async () => {
    compiled('AxDataEntityView', 'ProbeEntity', withAction);
    write(bin(), runtimeFile(entry('ProbeEntity', [])));

    const r = await scanODataActions(root, root, PKG);

    expect(r.recompiled).toEqual([]);
    expect(r.missing).toEqual([{ entity: 'ProbeEntity', actions: ['ExistingAction'] }]);
    expect(r.runtimeFile).toBe(bin());
  });

  it('finds nothing when compiled entities and their entries agree', async () => {
    compiled('AxDataEntityView', 'ProbeEntity', withAction);
    compiled('AxDataEntityView', 'PlainEntity', withoutAction);
    write(
      bin(),
      runtimeFile(entry('ProbeEntity', [action('ExistingAction', 'existingAction')]), entry('PlainEntity', [])),
    );

    expect(await scanODataActions(root, root, PKG)).toMatchObject({ recompiled: [], missing: [], errors: [] });
  });

  it('ignores a changed entity, extension or class without actions', async () => {
    write(src('AxDataEntityView', 'PlainEntity'), withoutAction, NEWER);
    write(src('AxDataEntityViewExtension', 'CustomersV3.Ext'), '<AxDataEntityViewExtension/>', NEWER);
    write(src('AxClass', 'Helper'), '<AxClass><Source><![CDATA[class Helper {}]]></Source></AxClass>', NEWER);
    expect((await scanODataActions(root, root, PKG)).recompiled).toEqual([]);
  });

  it('flags a changed extension class that adds an action', async () => {
    write(
      src('AxClass', 'CustCustomerV3Entity_Extension'),
      '<AxClass><Source><![CDATA[[ExtensionOf(tableStr(CustCustomerV3Entity))]\nfinal class X {\n' +
        "[SysODataActionAttribute('Ping', false)] public static str ping() { return ''; } }]]></Source></AxClass>",
      NEWER,
    );
    compiled(
      'AxClass',
      'Unchanged',
      "<AxClass><Source><![CDATA[[SysODataActionAttribute('Old', false)]]]></Source></AxClass>",
    );
    expect((await scanODataActions(root, root, PKG)).recompiled).toEqual(['AxClass/CustCustomerV3Entity_Extension']);
  });

  it('with checkRecompile off, only compares entities against the deployed file', async () => {
    write(src('AxDataEntityView', 'ProbeEntity'), withAction, NEWER);
    write(bin(), runtimeFile(entry('ProbeEntity', [])));

    const r = await scanODataActions(root, root, PKG, { checkRecompile: false });

    expect(r.recompiled).toEqual([]);
    expect(r.missing).toEqual([{ entity: 'ProbeEntity', actions: ['ExistingAction'] }]);
  });

  it('reports a missing package folder as an error rather than throwing', async () => {
    const r = await scanODataActions(root, root, 'NoSuchPkg');
    expect(r.recompiled).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});
