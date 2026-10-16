/**
 * Editing an existing AxDataEntityView in place: entity properties inserted in canonical
 * order, an outer-joined embedded datasource, and a mapped field.
 */
import { describe, it, expect } from 'vitest';
import {
  upsertDataEntityProperty,
  addDataEntityDataSource,
  addDataEntityMappedField,
} from '../../src/tools/xml/dataEntityViewEdit';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';

const base = () => buildAxDataEntityXml('ContosoThingEntity', {
  label: '@X:Y', primaryTable: 'AssetTrans', dynamicFields: true,
  fields: [{ name: 'AssetId' }, { name: 'DefaultDimension' }], isReadOnly: true,
});
const order = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);

describe('upsertDataEntityProperty', () => {
  it('inserts PrimaryCompanyContext between IsPublic and PrimaryKey', () => {
    const r = upsertDataEntityProperty(base(), 'PrimaryCompanyContext', 'DataAreaId');
    expect(r.ok).toBe(true);
    const o = order(r.xml!);
    expect(o.indexOf('PrimaryCompanyContext')).toBe(o.indexOf('IsPublic') + 1 + (o.includes('IsReadOnly') ? 1 : 0));
    expect(o.indexOf('PrimaryCompanyContext')).toBeLessThan(o.indexOf('PrimaryKey'));
    expect(r.xml).toContain('<PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>');
  });
  it('inserts ConfigurationKey before Label (after SourceCode)', () => {
    const r = upsertDataEntityProperty(base(), 'ConfigurationKey', 'Asset');
    const o = order(r.xml!);
    expect(o.indexOf('ConfigurationKey')).toBeLessThan(o.indexOf('Label'));
    expect(o.indexOf('ConfigurationKey')).toBeGreaterThan(o.indexOf('Name'));
  });
  it('replaces an existing value instead of duplicating', () => {
    const once = upsertDataEntityProperty(base(), 'ConfigurationKey', 'Asset').xml!;
    const twice = upsertDataEntityProperty(once, 'ConfigurationKey', 'Ledger');
    expect(twice.xml!.match(/<ConfigurationKey>/g)).toHaveLength(1);
    expect(twice.xml).toContain('<ConfigurationKey>Ledger</ConfigurationKey>');
  });
  it('refuses a property that is not an AxDataEntityView property', () => {
    expect(upsertDataEntityProperty(base(), 'Bogus', 'x').ok).toBe(false);
  });
  it('refuses a non-entity document', () => {
    expect(upsertDataEntityProperty('<AxTable><Name>T</Name></AxTable>', 'ConfigurationKey', 'A').ok).toBe(false);
  });
});

describe('addDataEntityDataSource', () => {
  it('adds an outer-joined embedded datasource under the root with a relation', () => {
    const r = addDataEntityDataSource(base(), {
      name: 'DefaultDimensionDAVS', table: 'DimensionSetEntity', joinMode: 'OuterJoin',
      joinField: 'DefaultDimension', relatedField: 'RecId', readOnly: true,
    });
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('<AxQuerySimpleEmbeddedDataSource>');
    expect(r.xml).toMatch(/<Name>DefaultDimensionDAVS<\/Name>\s*<DynamicFields>Yes<\/DynamicFields>\s*<IsReadOnly>Yes<\/IsReadOnly>\s*<Table>DimensionSetEntity<\/Table>/);
    expect(r.xml).toContain('<JoinMode>OuterJoin</JoinMode>');
    expect(r.xml).toMatch(/<Field>DefaultDimension<\/Field>\s*<JoinDataSource>AssetTrans<\/JoinDataSource>\s*<RelatedField>RecId<\/RelatedField>/);
    // nested inside the root datasource's own <DataSources>, not the ViewMetadata one
    expect(r.xml).toMatch(/<AxQuerySimpleRootDataSource>[\s\S]*<DataSources>\s*<AxQuerySimpleEmbeddedDataSource>/);
  });
  it('a second datasource is appended, and a duplicate name is refused', () => {
    const a = addDataEntityDataSource(base(), { name: 'A', table: 'T1', joinField: 'F', relatedField: 'RecId' });
    const b = addDataEntityDataSource(a.xml!, { name: 'B', table: 'T2', joinField: 'G', relatedField: 'RecId' });
    expect(b.xml!.match(/<AxQuerySimpleEmbeddedDataSource>/g)).toHaveLength(2);
    expect(addDataEntityDataSource(b.xml!, { name: 'A', table: 'T1', joinField: 'F', relatedField: 'RecId' }).ok).toBe(false);
  });
  it('refuses an unknown join parent and a missing relation', () => {
    expect(addDataEntityDataSource(base(), { name: 'A', table: 'T', joinSource: 'Nope', joinField: 'F', relatedField: 'R' }).ok).toBe(false);
    expect(addDataEntityDataSource(base(), { name: 'A', table: 'T' }).ok).toBe(false);
  });
});

describe('addDataEntityMappedField', () => {
  it('appends an AxDataEntityViewMappedField bound to a datasource', () => {
    const r = addDataEntityMappedField(base(), {
      name: 'DefaultDimensionDisplayValue', dataField: 'DisplayValue', dataSource: 'DefaultDimensionDAVS',
    });
    expect(r.ok).toBe(true);
    expect(r.xml).toMatch(/<Name>DefaultDimensionDisplayValue<\/Name>\s*<DataField>DisplayValue<\/DataField>\s*<DataSource>DefaultDimensionDAVS<\/DataSource>/);
  });
  it('is idempotent on the field name', () => {
    const a = addDataEntityMappedField(base(), { name: 'X', dataField: 'F', dataSource: 'AssetTrans' });
    expect(addDataEntityMappedField(a.xml!, { name: 'X', dataField: 'F', dataSource: 'AssetTrans' }).ok).toBe(false);
  });
  // fieldMandatory is a boolean on the tool surface and arrives as String(bool): "true" is not
  // a NoYes value (shipped entities carry only Yes / No).
  it('writes Mandatory as Yes / No, whatever boolean spelling it is given', () => {
    const yes = addDataEntityMappedField(base(), { name: 'X', dataField: 'F', dataSource: 'AssetTrans', mandatory: String(true) });
    expect(yes.xml).toContain('<Mandatory>Yes</Mandatory>');
    expect(yes.xml).not.toContain('<Mandatory>true</Mandatory>');
    const no = addDataEntityMappedField(base(), { name: 'X', dataField: 'F', dataSource: 'AssetTrans', mandatory: 'false' });
    expect(no.xml).toContain('<Mandatory>No</Mandatory>');
    expect(addDataEntityMappedField(base(), { name: 'X', dataField: 'F', dataSource: 'AssetTrans', mandatory: 'maybe' }).ok).toBe(false);
  });
});

describe('EntityCategory on the XML path', () => {
  it('normalises a known value and refuses one outside the enum', () => {
    const ok = upsertDataEntityProperty(base(), 'EntityCategory', 'reference');
    expect(ok.xml).toContain('<EntityCategory>Reference</EntityCategory>');
    const bad = upsertDataEntityProperty(base(), 'EntityCategory', 'Masterr');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('Master, Configuration, Transaction, Reference, Document, Parameters');
  });
});

// About 2% of shipped metadata is indented with two spaces instead of tabs.
describe('space-indented documents', () => {
  const spaced = () => base().replace(/^\t+/gm, tabs => '  '.repeat(tabs.length));
  const spacedOrder = (xml: string) => [...xml.matchAll(/^ {2}<(\w+)[ />]/gm)].map(m => m[1]);

  it('inserts an entity property at one indent unit, in canonical order', () => {
    const r = upsertDataEntityProperty(spaced(), 'PrimaryCompanyContext', 'DataAreaId');
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('\n  <PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>\n');
    const o = spacedOrder(r.xml!);
    expect(o.indexOf('PrimaryCompanyContext')).toBeLessThan(o.indexOf('PrimaryKey'));
    expect(r.xml).not.toContain('\t');
  });
  it('adds a datasource under the root datasource and a mapped field to the top-level Fields', () => {
    const ds = addDataEntityDataSource(spaced(), {
      name: 'DefaultDimensionDAVS', table: 'DimensionSetEntity', joinMode: 'OuterJoin',
      joinField: 'DefaultDimension', relatedField: 'RecId',
    });
    expect(ds.ok).toBe(true);
    expect(ds.xml).toMatch(/\n {6}<AxQuerySimpleRootDataSource>[\s\S]*\n {8}<DataSources>\n {10}<AxQuerySimpleEmbeddedDataSource>\n {12}<Name>DefaultDimensionDAVS<\/Name>/);
    const f = addDataEntityMappedField(ds.xml!, { name: 'DisplayValue', dataField: 'DisplayValue', dataSource: 'DefaultDimensionDAVS' });
    expect(f.ok).toBe(true);
    expect(f.xml).toMatch(/\n {4}<AxDataEntityViewField xmlns=""\n {6}i:type="AxDataEntityViewMappedField">\n {6}<Name>DisplayValue<\/Name>/);
    expect(f.xml).not.toContain('\t');
  });
});
