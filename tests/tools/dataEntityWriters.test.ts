/**
 * The direct-XML writers on real files (no bridge): entity properties, an outer-joined
 * datasource, and a mapped field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as writers from '../../src/tools/write/directXmlWriters';
import { buildAxDataEntityXml } from '../../src/tools/xml/dataEntityXml';

let dir: string; let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-modify-'));
  file = path.join(dir, 'E.xml');
  await fs.writeFile(file, buildAxDataEntityXml('E', {
    primaryTable: 'AssetTrans', dynamicFields: true, fields: [{ name: 'AssetId' }, { name: 'DefaultDimension' }],
  }).replace(/\n/g, '\r\n'));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const order = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);
const read = async () => (await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n');

describe('modify-property on a data entity', () => {
  it('ConfigurationKey is inserted (previously: null → "Unknown AxDataEntityView property")', async () => {
    const r = await writers.directXmlModifyProperty(file, 'ConfigurationKey', 'Asset', 'test');
    expect(r?.success).toBe(true);
    const o = order(await read());
    expect(o.indexOf('ConfigurationKey')).toBeLessThan(o.indexOf('Label'));
  });
  it('PrimaryCompanyContext lands before PrimaryKey', async () => {
    const r = await writers.directXmlModifyProperty(file, 'PrimaryCompanyContext', 'DataAreaId', 'test');
    expect(r?.success).toBe(true);
    const o = order(await read());
    expect(o.indexOf('PrimaryCompanyContext')).toBeLessThan(o.indexOf('PrimaryKey'));
    expect(o.indexOf('PrimaryCompanyContext')).toBeGreaterThan(o.indexOf('IsPublic'));
  });
  it('an unknown entity property is refused with a reason, not silently null', async () => {
    const r = await writers.directXmlModifyProperty(file, 'Bogus', 'x', 'test');
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/not a scalar AxDataEntityView property/);
  });
});

describe('add-data-source / add-field on a data entity', () => {
  it('adds the outer-joined datasource, then its mapped field', async () => {
    const ds = await writers.directXmlAddDataEntityDataSource(file, {
      name: 'DefaultDimensionDAVS', table: 'DimensionSetEntity', joinMode: 'OuterJoin',
      joinField: 'DefaultDimension', relatedField: 'RecId', readOnly: true,
    });
    expect(ds?.success).toBe(true);
    const f = await writers.directXmlAddDataEntityField(file, {
      name: 'DefaultDimensionDisplayValue', dataField: 'DisplayValue', dataSource: 'DefaultDimensionDAVS',
    });
    expect(f?.success).toBe(true);
    const xml = await read();
    expect(xml).toContain('<JoinMode>OuterJoin</JoinMode>');
    expect(xml).toContain('<DataSource>DefaultDimensionDAVS</DataSource>');
    // CRLF restored on write
    expect((await fs.readFile(file, 'utf-8'))).toContain('\r\n');
  });
  it('add-field refuses a datasource the entity does not have', async () => {
    const f = await writers.directXmlAddDataEntityField(file, {
      name: 'X', dataField: 'F', dataSource: 'NoSuchSource',
    });
    expect(f?.success).toBe(false);
    expect(f?.message).toMatch(/NoSuchSource/);
  });
});
