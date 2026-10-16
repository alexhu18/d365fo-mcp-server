/**
 * Table fields: enumType alone makes an AxTableFieldEnum, and AllowEdit / IgnoreEDTRelation can
 * be set on create fields[] and modify-field, in canonical element order.
 */
import { describe, it, expect } from 'vitest';
import { normalizeFieldSpecsForBridge } from '../../src/tools/write/createD365File';
import { buildAxTableFieldsXml } from '../../src/tools/xml/tableXml';
import { upsertTableFieldProperty, fieldPropertiesFromSpecs } from '../../src/tools/xml/tableFieldPropertyEdit';

describe('enumType alone means an enum field', () => {
  it('bridge payload gets type=Enum when only enumType is given', () => {
    const [f] = normalizeFieldSpecsForBridge([{ name: 'Status', enumType: 'NoYes' }]);
    expect(f.type).toBe('Enum');
    expect(f.enumType).toBe('NoYes');
  });
  it('an explicit type still wins', () => {
    const [f] = normalizeFieldSpecsForBridge([{ name: 'Status', enumType: 'NoYes', fieldType: 'AxTableFieldEnum' }]);
    expect(f.type).toBe('Enum');
  });
  it('a plain field is untouched', () => {
    const [f] = normalizeFieldSpecsForBridge([{ name: 'Note', edt: 'Description' }]);
    expect(f.type).toBeUndefined();
  });
  it('the template builder takes the ignoreEDTRelation spelling too', () => {
    // fieldPropertiesFromSpecs (the bridge path) accepts both; the template path
    // read only ignoreEdtRelation and dropped the other without a word.
    expect(buildAxTableFieldsXml([{ name: 'Ref', edt: 'Name', ignoreEDTRelation: true } as any]))
      .toContain('<IgnoreEDTRelation>Yes</IgnoreEDTRelation>');
  });
  it('XML builder emits AxTableFieldEnum for enumType alone', () => {
    expect(buildAxTableFieldsXml([{ name: 'Status', enumType: 'NoYes' } as any])).toContain('i:type="AxTableFieldEnum"');
  });
});

const TABLE = `<AxTable>
\t<Name>T</Name>
\t<Fields>
\t\t<AxTableField xmlns=""
\t\t\ti:type="AxTableFieldString">
\t\t\t<Name>AssetId</Name>
\t\t\t<ExtendedDataType>AssetId</ExtendedDataType>
\t\t\t<Label>@X:L</Label>
\t\t\t<Mandatory>Yes</Mandatory>
\t\t</AxTableField>
\t\t<AxTableField xmlns=""
\t\t\ti:type="AxTableFieldString">
\t\t\t<Name>Other</Name>
\t\t\t<ExtendedDataType>Name</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
</AxTable>`;

describe('upsertTableFieldProperty', () => {
  it('AllowEdit goes right after Name, before ExtendedDataType', () => {
    const r = upsertTableFieldProperty(TABLE, 'AssetId', 'AllowEdit', 'No');
    expect(r.ok).toBe(true);
    expect(r.xml).toMatch(/<Name>AssetId<\/Name>\s*<AllowEdit>No<\/AllowEdit>\s*<ExtendedDataType>/);
  });
  it('IgnoreEDTRelation goes after ExtendedDataType, before Label', () => {
    const r = upsertTableFieldProperty(TABLE, 'AssetId', 'IgnoreEDTRelation', 'Yes');
    expect(r.xml).toMatch(/<ExtendedDataType>AssetId<\/ExtendedDataType>\s*<IgnoreEDTRelation>Yes<\/IgnoreEDTRelation>\s*<Label>/);
  });
  it('only the named field changes; a second call replaces, never duplicates', () => {
    const a = upsertTableFieldProperty(TABLE, 'AssetId', 'AllowEdit', 'No').xml!;
    const b = upsertTableFieldProperty(a, 'AssetId', 'AllowEdit', 'Yes').xml!;
    expect(b.match(/<AllowEdit>/g)).toHaveLength(1);
    expect(b).toContain('<AllowEdit>Yes</AllowEdit>');
    expect(b.slice(b.indexOf('<Name>Other</Name>'))).not.toContain('AllowEdit');
  });
  it('appends after the last element when nothing later exists', () => {
    const r = upsertTableFieldProperty(TABLE, 'Other', 'IgnoreEDTRelation', 'Yes');
    expect(r.xml).toMatch(/<Name>Other<\/Name>\s*<ExtendedDataType>Name<\/ExtendedDataType>\s*<IgnoreEDTRelation>Yes/);
  });
  it('a space-indented table (about 2% of shipped metadata) is edited at its own indentation', () => {
    const spaced = TABLE.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length));
    const r = upsertTableFieldProperty(spaced, 'AssetId', 'AllowEdit', 'No');
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('\n      <Name>AssetId</Name>\n      <AllowEdit>No</AllowEdit>\n      <ExtendedDataType>');
    expect(r.xml).not.toContain('\t');
    expect(r.xml!.slice(r.xml!.indexOf('<Name>Other</Name>'))).not.toContain('AllowEdit');
  });
  it('unknown field / property refused', () => {
    expect(upsertTableFieldProperty(TABLE, 'Nope', 'AllowEdit', 'No').ok).toBe(false);
    expect(upsertTableFieldProperty(TABLE, 'AssetId', 'Mandatory2', 'No').ok).toBe(false);
  });
  it('fieldPropertiesFromSpecs reads allowEdit / ignoreEdtRelation from create fields[]', () => {
    expect(fieldPropertiesFromSpecs([
      { name: 'A', allowEdit: false, ignoreEdtRelation: true },
      { name: 'B', edt: 'X' },
      { name: 'C', allowEdit: 'No' },
    ])).toEqual([
      { field: 'A', prop: 'AllowEdit', value: 'No' },
      { field: 'A', prop: 'IgnoreEDTRelation', value: 'Yes' },
      { field: 'C', prop: 'AllowEdit', value: 'No' },
    ]);
  });
});

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { directXmlSetTableFieldProperties } from '../../src/tools/write/directXmlWriters';

describe('writers', () => {
  it('XML builder writes AllowEdit / IgnoreEDTRelation in order', () => {
    const xml = buildAxTableFieldsXml([
      { name: 'AssetId', edt: 'AssetId', label: '@X:L', mandatory: true, allowEdit: false, ignoreEdtRelation: true },
    ]);
    expect(xml).toMatch(/<Name>AssetId<\/Name>\s*<AllowEdit>No<\/AllowEdit>\s*<ExtendedDataType>AssetId<\/ExtendedDataType>\s*<IgnoreEDTRelation>Yes<\/IgnoreEDTRelation>\s*<Label>/);
  });
  it('modify-field writer patches a real (CRLF) file and keeps CRLF', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-prop-'));
    try {
      const file = path.join(dir, 'T.xml');
      await fs.writeFile(file, TABLE.replace(/\n/g, '\r\n'));
      const r = await directXmlSetTableFieldProperties(file, 'AssetId', { AllowEdit: 'No', IgnoreEDTRelation: 'Yes' });
      expect(r?.success).toBe(true);
      const out = await fs.readFile(file, 'utf-8');
      expect(out).toContain('\r\n');
      expect(out.replace(/\r\n/g, '\n')).toMatch(/<AllowEdit>No<\/AllowEdit>[\s\S]*<IgnoreEDTRelation>Yes<\/IgnoreEDTRelation>/);
      const bad = await directXmlSetTableFieldProperties(file, 'Nope', { AllowEdit: 'No' });
      expect(bad?.success).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
