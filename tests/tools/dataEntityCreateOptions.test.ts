/**
 * Data-entity create: opt-in properties are written in element order, keys the generator does
 * not read are reported, and a staging-table reference without a table is called out.
 */
import { describe, it, expect } from 'vitest';
import { buildAxDataEntityXml, findIgnoredEntityProperties, stagingTableNote } from '../../src/tools/xml/dataEntityXml';

const props = (extra: Record<string, unknown> = {}) => ({
  primaryTable: 'AssetTrans', fields: [{ name: 'AssetId' }], ...extra,
});
const order = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);

describe('create honours the properties modify-property supports', () => {
  it('writes IsReadOnly, Tags, ConfigurationKey, PrimaryCompanyContext in canonical order', () => {
    const xml = buildAxDataEntityXml('E1', props({
      label: '@X:E', isReadOnly: true, tags: 'TAG-1', configurationKey: 'Asset',
      primaryCompanyContext: 'DataAreaId',
    }));
    expect(xml).toContain('<IsReadOnly>Yes</IsReadOnly>');
    expect(xml).toContain('<Tags>TAG-1</Tags>');
    expect(xml).toContain('<ConfigurationKey>Asset</ConfigurationKey>');
    expect(xml).toContain('<PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>');
    const o = order(xml);
    const idx = (n: string) => o.indexOf(n);
    expect(idx('ConfigurationKey')).toBeLessThan(idx('Label'));
    expect(idx('Label')).toBeLessThan(idx('Tags'));
    expect(idx('IsPublic')).toBeLessThan(idx('IsReadOnly'));
    expect(idx('IsReadOnly')).toBeLessThan(idx('PrimaryCompanyContext'));
    expect(idx('PrimaryCompanyContext')).toBeLessThan(idx('PrimaryKey'));
  });
  it('surrogateKey uses SourceKey (DataField RecId) as EntityKey', () => {
    const xml = buildAxDataEntityXml('E2', props({ surrogateKey: true }));
    expect(xml).toMatch(/<Name>SourceKey<\/Name>\s*<DataField>RecId<\/DataField>\s*<DataSource>AssetTrans<\/DataSource>/);
    expect(xml).toMatch(/<AxDataEntityViewKey>\s*<Name>EntityKey<\/Name>\s*<Fields>\s*<AxDataEntityViewKeyField>\s*<DataField>SourceKey<\/DataField>/);
  });
  it('defaults are unchanged when none of the new properties is passed', () => {
    const xml = buildAxDataEntityXml('E3', props());
    for (const t of ['IsReadOnly', 'Tags', 'ConfigurationKey', 'PrimaryCompanyContext']) {
      expect(xml).not.toContain(`<${t}>`);
    }
  });
  it('lists properties the generator does not read', () => {
    expect(findIgnoredEntityProperties(props({ isReadOnly: true, tags: 'x', bogusThing: 1, fieldz: [] })))
      .toEqual(['bogusThing', 'fieldz']);
  });
});

describe('staging table is not generated — say so', () => {
  it('names the missing staging table and how to create it', () => {
    const note = stagingTableNote('E4', props({ dataManagementEnabled: true }));
    expect(note).toContain('E4Staging');
    expect(note).toMatch(/does NOT create/i);
    expect(note).toMatch(/TableGroup=Staging|Staging/);
  });
  it('honours dataManagementStagingTable and is silent when data management is off', () => {
    expect(stagingTableNote('E5', props({ dataManagementEnabled: true, dataManagementStagingTable: 'MyStg' }))).toContain('MyStg');
    expect(stagingTableNote('E6', props())).toBe('');
  });
});
