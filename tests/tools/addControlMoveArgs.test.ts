/**
 * add-control on a control the file ALREADY defines, through modify_d365fo_file.
 *
 * Such a call moves the control (or finds it already there) and creates nothing, so:
 *  - the creation arguments it carries (controlType, controlDataSource, controlDataField,
 *    controlLabel) are named as not applied, instead of reading "✅ moved" over a type
 *    or binding that was silently dropped;
 *  - the DataGroup / sub-pattern pre-flights, which judge a NEW control by exactly those
 *    arguments, do not refuse the move;
 *  - "already on the form" says where the control is when that is not the parent named;
 *  - a placement that throws after the bridge saved a new control reports the control
 *    as added (at the end), not ❌.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddControl, store } = vi.hoisted(() => ({
  mockBridgeAddControl: vi.fn(),
  store: { xml: '', failNextWrite: false },
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddControl: mockBridgeAddControl,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

// The pre-flights read the form (and an extension's base form) through here.
vi.mock('../../src/utils/baseObjectXml', () => ({
  findBaseFormXml: vi.fn(async () => store.xml),
  findBaseObjectXml: vi.fn(async () => store.xml),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return store.xml;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    if (!String(p).includes('ConDemoMoveForm')) return;
    if (store.failNextWrite) {
      store.failNextWrite = false;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    store.xml = String(data);
  }),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => null),
    getMicrosoftPackagesPath: vi.fn(async () => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (m: string) => ({ packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({ packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const field = (name: string, indent = '\t\t\t') => [
  `${indent}<AxFormControl xmlns="" i:type="AxFormStringControl">`,
  `${indent}\t<Name>${name}</Name>`,
  `${indent}\t<Type>String</Type>`,
  `${indent}\t<FormControlExtension i:nil="true" />`,
  `${indent}</AxFormControl>`,
];

/** Design: a group rendering field group Overview (holding A, B), then Subject and Body. */
const form = (topLevel: string[] = ['Subject', 'Body']) => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>ConDemoMoveForm</Name>`,
  `\t<SourceCode>`,
  `\t\t<Methods xmlns="" />`,
  `\t</SourceCode>`,
  `\t<DataSources />`,
  `\t<Design>`,
  `\t\t<Controls xmlns="">`,
  `\t\t\t<AxFormControl xmlns="" i:type="AxFormGroupControl">`,
  `\t\t\t\t<Name>Grp</Name>`,
  `\t\t\t\t<Type>Group</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t\t<Controls>`,
  ...field('A', '\t\t\t\t\t'),
  ...field('B', '\t\t\t\t\t'),
  `\t\t\t\t</Controls>`,
  `\t\t\t\t<DataGroup>Overview</DataGroup>`,
  `\t\t\t\t<DataSource>CustTable</DataSource>`,
  `\t\t\t</AxFormControl>`,
  ...topLevel.flatMap(n => field(n)),
  `\t\t</Controls>`,
  `\t</Design>`,
  `</AxForm>`,
  '',
].join('\n');

const extension = () => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>ConDemoMoveForm.Ext</Name>`,
  `\t<ControlModifications />`,
  `\t<Controls>`,
  `\t\t<AxFormExtensionControl xmlns="">`,
  `\t\t\t<Name>FormExtensionControlabc</Name>`,
  `\t\t\t<FormControl xmlns="" i:type="AxFormStringControl">`,
  `\t\t\t\t<Name>MyField</Name>`,
  `\t\t\t\t<Type>String</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t</FormControl>`,
  `\t\t\t<Parent>HeaderGroup</Parent>`,
  `\t\t</AxFormExtensionControl>`,
  `\t</Controls>`,
  `\t<DataSourceModifications />`,
  `\t<DataSources />`,
  `\t<Parts />`,
  `\t<PropertyModifications />`,
  `</AxFormExtension>`,
].join('\n');

const names = (xml: string) =>
  [...xml.matchAll(/<Name>(\w+)<\/Name>/g)].map(m => m[1]).filter(n => n !== 'ConDemoMoveForm');

const FORM_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ConDemoMoveForm.xml';
const EXT_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxFormExtension\\ConDemoMoveForm.Ext.xml';

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form',
      objectName: 'ConDemoMoveForm',
      operation: 'add-control',
      parentControl: 'Design',
      filePath: FORM_PATH,
      ...args,
    },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text as string;

describe('add-control on a control the file already defines', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddControl.mockReset();
    store.failNextWrite = false;
  });

  it('names the creation arguments a move does not apply (form)', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({
      controlName: 'Body', positionType: 'Begin',
      controlType: 'Real', controlDataSource: 'CustTable', controlDataField: 'CreditMax', controlLabel: '@SYS1',
    }), ctx);
    expect(r.isError).toBeFalsy();
    expect(names(store.xml)).toEqual(['Body', 'Grp', 'A', 'B', 'Subject']);
    const reply = text(r);
    expect(reply).toContain('Not applied');
    for (const arg of ['controlType="Real"', 'controlDataSource="CustTable"', 'controlDataField="CreditMax"', 'controlLabel="@SYS1"']) {
      expect(reply).toContain(arg);
    }
    expect(mockBridgeAddControl).not.toHaveBeenCalled();
  });

  it('says nothing about arguments when the move carries none', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({ controlName: 'Body', positionType: 'Begin' }), ctx);
    expect(text(r)).not.toContain('Not applied');
  });

  it('does not refuse a move inside a DataGroup parent over a controlDataField it never uses', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({
      controlName: 'B', parentControl: 'Grp', positionType: 'Begin', controlDataField: 'AccountNum',
    }), ctx);
    expect(text(r)).not.toContain('add-control blocked');
    expect(r.isError).toBeFalsy();
    expect(names(store.xml)).toEqual(['Grp', 'B', 'A', 'Subject', 'Body']);
  });

  it('still refuses a NEW control there', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({
      controlName: 'C', parentControl: 'Grp', positionType: 'Begin', controlDataField: 'AccountNum',
    }), ctx);
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain('add-control blocked');
    expect(mockBridgeAddControl).not.toHaveBeenCalled();
  });

  it('says where the control is when it is not under the parent named', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({ controlName: 'B', parentControl: 'Design' }), ctx);
    expect(text(r)).toContain("already on the form (in 'Grp', not 'Design')");
    expect(mockBridgeAddControl).not.toHaveBeenCalled();
  });

  it('does not name a parent when the control is under a design-root name of the one asked', async () => {
    store.xml = form();
    const r = await modifyD365FileTool(call({ controlName: 'Body', parentControl: 'FormDesign' }), ctx);
    expect(text(r)).toContain('already on the form — nothing added');
  });

  it('names the creation arguments a move does not apply (form extension)', async () => {
    store.xml = extension();
    const r = await modifyD365FileTool(call({
      objectType: 'form-extension', objectName: 'ConDemoMoveForm.Ext', filePath: EXT_PATH,
      controlName: 'MyField', parentControl: 'HeaderGroup', positionType: 'Begin', controlDataField: 'Amount',
    }), ctx);
    expect(r.isError).toBeFalsy();
    expect(store.xml).toContain('<PositionType>Begin</PositionType>');
    expect(text(r)).toContain('Not applied: controlDataField="Amount"');
  });

  it('reports a new control as added when placing it throws after the bridge saved it', async () => {
    store.xml = form();
    mockBridgeAddControl.mockImplementation(async () => {
      store.xml = form(['Subject', 'Body', 'Notes']);
      store.failNextWrite = true; // the placement write that follows
      return { success: true, message: "✅ Control 'Notes' added to 'Design'" };
    });
    const r = await modifyD365FileTool(call({ controlName: 'Notes', previousSibling: 'Subject' }), ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Added at the END of 'Design' — it could not be positioned");
    expect(text(r)).toContain('EBUSY');
    expect(names(store.xml)).toEqual(['Grp', 'A', 'B', 'Subject', 'Body', 'Notes']);
  });
});
