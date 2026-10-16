/**
 * Robustness of the entity and table-field writers: a failed bridge half is not masked by the
 * XML half, unknown field elements do not break ordering, Yes/No values are validated, and
 * dataManagementEnabled accepts the spellings its warning does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { bridgeModifyField } = vi.hoisted(() => ({ bridgeModifyField: vi.fn() }));
vi.mock('../../src/bridge/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/bridge/index.js')>()),
  bridgeModifyField,
}));

import { modifyFieldOp } from '../../src/tools/write/dataEntityOps';
import { upsertTableFieldProperty } from '../../src/tools/xml/tableFieldPropertyEdit';
import { upsertDataEntityProperty } from '../../src/tools/xml/dataEntityViewEdit';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';

const TABLE = [
  '<AxTable>', '\t<Name>T</Name>', '\t<Fields>',
  '\t\t<AxTableField xmlns=""', '\t\t\ti:type="AxTableFieldString">',
  '\t\t\t<Name>F</Name>', '\t\t\t<ExtendedDataType>Name</ExtendedDataType>',
  '\t\t\t<CountryRegionCodes>FI</CountryRegionCodes>', '\t\t</AxTableField>',
  '\t</Fields>', '</AxTable>', '',
].join('\n');

describe('modify-field with a failed bridge half', () => {
  let dir: string; let file: string;
  beforeEach(async () => {
    bridgeModifyField.mockReset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r1-'));
    file = path.join(dir, 'T.xml');
    await fs.writeFile(file, TABLE);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('does not write the XML half or claim success when the label change failed', async () => {
    bridgeModifyField.mockResolvedValue(null);
    const r = await modifyFieldOp({} as any, 'T', file, { fieldName: 'F', fieldLabel: '@X:L', fieldAllowEdit: false });
    expect(r === null || r.success === false).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe(TABLE);
  });
  it('still applies the XML-only properties when nothing else was asked for', async () => {
    const r = await modifyFieldOp({} as any, 'T', file, { fieldName: 'F', fieldAllowEdit: false });
    expect(r?.success).toBe(true);
    expect(bridgeModifyField).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf-8')).toContain('<AllowEdit>No</AllowEdit>');
  });
  it('applies both when the bridge half succeeds', async () => {
    bridgeModifyField.mockResolvedValue({ success: true, message: 'ok' });
    const r = await modifyFieldOp({} as any, 'T', file, { fieldName: 'F', fieldLabel: '@X:L', fieldAllowEdit: false });
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('ok');
    expect(await fs.readFile(file, 'utf-8')).toContain('<AllowEdit>No</AllowEdit>');
  });
});

describe('field element order with an element outside the measured list', () => {
  it('a new property goes before it, since unmeasured elements rank last', () => {
    const t = TABLE.replace('\t\t\t<CountryRegionCodes>FI</CountryRegionCodes>\n', '\t\t\t<SomethingNew>x</SomethingNew>\n');
    const x = upsertTableFieldProperty(t, 'F', 'IgnoreEDTRelation', 'Yes').xml!;
    expect(x.indexOf('<IgnoreEDTRelation>')).toBeGreaterThan(x.indexOf('<ExtendedDataType>'));
    expect(x.indexOf('<IgnoreEDTRelation>')).toBeLessThan(x.indexOf('<SomethingNew>'));
  });
});

describe('entity NoYes properties', () => {
  const base = () => buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
  it('normalises true/false to Yes/No', () => {
    expect(upsertDataEntityProperty(base(), 'IsReadOnly', 'true').xml).toContain('<IsReadOnly>Yes</IsReadOnly>');
    expect(upsertDataEntityProperty(base(), 'AllowRetention', 'false').xml).toContain('<AllowRetention>No</AllowRetention>');
  });
  it('rejects a value that is neither', () => {
    const r = upsertDataEntityProperty(base(), 'IsReadOnly', 'maybe');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Yes or No/);
  });
  it('leaves free-text properties alone', () => {
    expect(upsertDataEntityProperty(base(), 'ConfigurationKey', 'true').xml).toContain('<ConfigurationKey>true</ConfigurationKey>');
  });
});

describe('dataManagementEnabled spelling', () => {
  it('the string "true" enables it, matching the warning that says it did', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], dataManagementEnabled: 'true' });
    expect(xml).toContain('<DataManagementEnabled>Yes</DataManagementEnabled>');
  });
});

// Release review 1.20.0: X++ names are case-insensitive, and so is the bridge's
// ModifyField. The XML half matched the field name exactly, so a wrongly cased
// name failed it AFTER the bridge had written the label — reported as "nothing
// was written".
describe('modify-field with a differently cased field name', () => {
  let dir: string; let file: string;
  beforeEach(async () => {
    bridgeModifyField.mockReset();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r1-'));
    file = path.join(dir, 'T.xml');
    await fs.writeFile(file, TABLE);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('applies the XML half to the field the bridge modified', async () => {
    bridgeModifyField.mockResolvedValue({ success: true, message: 'ok' });
    const r = await modifyFieldOp({} as any, 'T', file, { fieldName: 'f', fieldLabel: '@X:L', fieldAllowEdit: false });
    expect(r?.success).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toContain('<AllowEdit>No</AllowEdit>');
  });
});

// Shipped entities mix indentation (a tab line in a two-space file). Looking for
// the property only at the detected unit inserted a second copy of it.
describe('entity property at a different indentation', () => {
  it('is replaced, not duplicated', () => {
    const base = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
    expect(base).toContain('\t<Label>E</Label>\n');
    expect(base).not.toContain('<IsObsolete>');
    const mixed = base.replace('\t<Label>E</Label>\n', '\t<Label>E</Label>\n  <IsObsolete>No</IsObsolete>\n');
    const r = upsertDataEntityProperty(mixed, 'IsObsolete', 'Yes');
    expect(r.ok).toBe(true);
    expect(r.xml!.match(/<IsObsolete>/g)).toHaveLength(1);
    expect(r.xml).toContain('  <IsObsolete>Yes</IsObsolete>');
  });
});
