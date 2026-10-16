/**
 * The entity and table-field writers against the element shapes shipped metadata really has:
 * entities with Modules / CountryRegionCodes / IsObsolete, fields with AssetClassification /
 * FeatureClass / CountryRegionCodes. A property inserted on the wrong side of an element the
 * order table does not know is dropped by the deserializer without an error.
 *
 * Fixtures are minimal documents in the shipped shape (not copies of shipped files). The last
 * describe checks the order tables themselves against a real install when
 * D365FO_SHIPPED_METADATA points at a PackagesLocalDirectory; it is skipped otherwise.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ENTITY_TOP_LEVEL_ORDER, ENTITY_SCALAR_PROPERTIES, upsertDataEntityProperty,
} from '../../src/tools/xml/dataEntityViewEdit';
import { upsertTableFieldProperty, FIELD_ELEMENT_ORDER } from '../../src/tools/xml/tableFieldPropertyEdit';
import { buildAxDataEntityXml, findIgnoredEntityProperties, stagingTableNote } from '../../src/tools/xml/dataEntityXml';
import { directXmlModifyProperty } from '../../src/tools/write/directXmlWriters';

const topLevel = (xml: string) => [...xml.matchAll(/^\t<(\w+)[ />]/gm)].map(m => m[1]);

/** An entity in the shipped shape, with the given optional top-level elements between Label and PrimaryKey. */
const entity = (extra: Record<string, string> = {}) => {
  const el = (n: string) => (extra[n] !== undefined ? `\t<${n}>${extra[n]}</${n}>\n` : '');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
    '\t<Name>E</Name>\n\t<SourceCode>\n\t\t<Declaration><![CDATA[\npublic class E extends common\n{\n}\n]]></Declaration>\n\t\t<Methods />\n\t</SourceCode>\n' +
    el('CountryRegionCodes') + '\t<Label>@X:E</Label>\n' + el('IsObsolete') + el('Tags') +
    '\t<EntityCategory>Master</EntityCategory>\n\t<IsPublic>Yes</IsPublic>\n' + el('Modules') +
    '\t<PrimaryKey>EntityKey</PrimaryKey>\n\t<PublicCollectionName>Es</PublicCollectionName>\n\t<PublicEntityName>E</PublicEntityName>\n' +
    '\t<Fields />\n\t<Keys />\n\t<Mappings />\n\t<Ranges />\n\t<Relations />\n\t<ViewMetadata />\n</AxDataEntityView>\n'
  );
};

describe('entity property insertion next to elements shipped entities carry', () => {
  it('IsReadOnly goes before Modules', () => {
    const x = upsertDataEntityProperty(entity({ Modules: 'HRM' }), 'IsReadOnly', 'Yes').xml!;
    const o = topLevel(x);
    expect(o.indexOf('IsReadOnly')).toBeGreaterThan(o.indexOf('IsPublic'));
    expect(o.indexOf('IsReadOnly')).toBeLessThan(o.indexOf('Modules'));
  });
  it('ConfigurationKey goes before CountryRegionCodes', () => {
    const x = upsertDataEntityProperty(entity({ CountryRegionCodes: 'BR' }), 'ConfigurationKey', 'Asset').xml!;
    const o = topLevel(x);
    expect(o.indexOf('ConfigurationKey')).toBeLessThan(o.indexOf('CountryRegionCodes'));
    expect(o.indexOf('ConfigurationKey')).toBeGreaterThan(o.indexOf('SourceCode'));
  });
  it('PrimaryCompanyContext goes after Modules and before PrimaryKey', () => {
    const o = topLevel(upsertDataEntityProperty(entity({ Modules: 'HRM' }), 'PrimaryCompanyContext', 'DataAreaId').xml!);
    expect(o.indexOf('PrimaryCompanyContext')).toBeGreaterThan(o.indexOf('Modules'));
    expect(o.indexOf('PrimaryCompanyContext')).toBeLessThan(o.indexOf('PrimaryKey'));
  });
  it('every writable property lands where the order table puts it, in a document holding all the others', () => {
    const rank = (n: string) => (ENTITY_TOP_LEVEL_ORDER as readonly string[]).indexOf(n);
    const valueFor = (p: string) =>
      p === 'EntityCategory' ? 'Reference'
        : /^(Is|Allow|Auto|Enable|Supports|Valid|DataManagementEnabled)/.test(p) && !/Staging|Public(Coll|Ent)/.test(p) ? 'Yes' : 'x';
    for (const prop of ENTITY_SCALAR_PROPERTIES) {
      const others = [...ENTITY_SCALAR_PROPERTIES].filter(p => p !== prop);
      let xml = entity();
      for (const p of others) xml = upsertDataEntityProperty(xml, p, valueFor(p)).xml!;
      const before = topLevel(xml).filter(n => rank(n) >= 0);
      expect(before, `document before ${prop}`).toEqual([...before].sort((a, b) => rank(a) - rank(b)));
      const after = topLevel(upsertDataEntityProperty(xml, prop, valueFor(prop)).xml!)
        .filter(n => rank(n) >= 0);
      expect(after, `after inserting ${prop}`).toEqual([...after].sort((a, b) => rank(a) - rank(b)));
    }
  });
  it('a property the writer does not accept is refused with the supported list', () => {
    const r = upsertDataEntityProperty(entity(), 'Modules', 'HRM');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Supported:');
  });
});

/** A table with one field carrying the given child elements, in shipped order. */
const table = (children: string[]) =>
  '<AxTable>\n\t<Name>T</Name>\n\t<Fields>\n\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n' +
  children.map(c => `\t\t\t${c}\n`).join('') + '\t\t</AxTableField>\n\t</Fields>\n</AxTable>\n';
const fieldOrder = (xml: string) => [...xml.matchAll(/^\t\t\t<(\w+)[ />]/gm)].map(m => m[1]);

describe('table-field property insertion next to elements shipped fields carry', () => {
  const shipped = table([
    '<Name>F</Name>', '<AssetClassification>Customer content</AssetClassification>',
    '<ConfigurationKey>Ledger</ConfigurationKey>', '<CountryRegionCodes>BR</CountryRegionCodes>',
    '<ExtendedDataType>Name</ExtendedDataType>', '<FeatureClass>Feature</FeatureClass>',
    '<GroupPrompt>@X:G</GroupPrompt>', '<Label>@X:L</Label>', '<StringSize>20</StringSize>',
  ]);
  it('IgnoreEDTRelation goes after ExtendedDataType and before FeatureClass / GroupPrompt / Label', () => {
    const o = fieldOrder(upsertTableFieldProperty(shipped, 'F', 'IgnoreEDTRelation', 'Yes').xml!);
    expect(o.indexOf('IgnoreEDTRelation')).toBeGreaterThan(o.indexOf('ExtendedDataType'));
    expect(o.indexOf('IgnoreEDTRelation')).toBeGreaterThan(o.indexOf('AssetClassification'));
    expect(o.indexOf('IgnoreEDTRelation')).toBeGreaterThan(o.indexOf('GroupPrompt'));
    expect(o.indexOf('IgnoreEDTRelation')).toBeLessThan(o.indexOf('Label'));
  });
  it('AllowEdit goes before AssetClassification', () => {
    const o = fieldOrder(upsertTableFieldProperty(shipped, 'F', 'AllowEdit', 'No').xml!);
    expect(o.indexOf('AllowEdit')).toBe(1);
  });
  it('a field with AssetClassification followed by ExtendedDataType keeps EDT before the new property', () => {
    const t = table(['<Name>F</Name>', '<AssetClassification>Customer content</AssetClassification>', '<ExtendedDataType>Name</ExtendedDataType>']);
    const o = fieldOrder(upsertTableFieldProperty(t, 'F', 'IgnoreEDTRelation', 'Yes').xml!);
    expect(o).toEqual(['Name', 'AssetClassification', 'ExtendedDataType', 'IgnoreEDTRelation']);
  });
});

describe('data-entity create reply', () => {
  it('does not claim sourceCode was dropped — it is read one level up', () => {
    expect(findIgnoredEntityProperties({ sourceCode: 'public class E extends common {}' })).toEqual([]);
  });
  it('staging advice names DefinitionGroup + ExecutionId + the entity key fields, not RecIdSystem', () => {
    const n = stagingTableNote('E', { dataManagementEnabled: true });
    expect(n).toContain('DefinitionGroup, ExecutionId');
    expect(n).toMatch(/key fields/i);
    expect(n).not.toContain('RecIdSystem');
  });
  it('surrogateKey maps the RecId field under the shipped name SourceKey', () => {
    const x = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], surrogateKey: true });
    expect(x).toMatch(/<Name>SourceKey<\/Name>\s*<DataField>RecId<\/DataField>/);
    expect(x).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>SourceKey<\/DataField>/);
    expect(x).not.toContain('RecIdSystem');
  });
});

describe('entity modify-property with a dotted path', () => {
  let dir: string; let file: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'entity-dotted-'));
    file = path.join(dir, 'E.xml');
    await fsp.writeFile(file, entity());
  });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('refuses Fields.MyField.Label instead of rewriting the entity label', async () => {
    const r = await directXmlModifyProperty(file, 'Fields.MyField.Label', 'Hijacked', 'test');
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/one property|dotted|nested/i);
    expect(await fsp.readFile(file, 'utf-8')).toContain('<Label>@X:E</Label>');
  });
  it('still accepts a plain property name', async () => {
    const r = await directXmlModifyProperty(file, 'ConfigurationKey', 'Asset', 'test');
    expect(r?.success).toBe(true);
  });
});

const SHIPPED = process.env.D365FO_SHIPPED_METADATA;
describe.skipIf(!SHIPPED || !fs.existsSync(SHIPPED ?? ''))('order tables against a real install', () => {
  const listFiles = (folder: string): string[] => {
    const out: string[] = [];
    for (const pkg of fs.readdirSync(SHIPPED!, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      for (const model of fs.readdirSync(path.join(SHIPPED!, pkg.name), { withFileTypes: true })) {
        const dir = path.join(SHIPPED!, pkg.name, model.name, folder);
        if (model.isDirectory() && fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) if (f.endsWith('.xml')) out.push(path.join(dir, f));
        }
      }
    }
    return out;
  };
  const consistent = (seq: string[], order: readonly string[]) => {
    const r = seq.map(n => order.indexOf(n)).filter(i => i >= 0);
    return r.every((v, i) => i === 0 || r[i - 1] <= v);
  };

  it('entity order matches at least 99% of shipped entities, and every top-level element is known', () => {
    const files = listFiles('AxDataEntityView');
    let bad = 0; const unknown = new Set<string>();
    for (const f of files) {
      const seq = topLevel(fs.readFileSync(f, 'utf-8'));
      seq.forEach(n => { if (!(ENTITY_TOP_LEVEL_ORDER as readonly string[]).includes(n)) unknown.add(n); });
      if (!consistent(seq, ENTITY_TOP_LEVEL_ORDER)) bad++;
    }
    expect([...unknown]).toEqual([]);
    expect(bad / files.length).toBeLessThan(0.01);
  });

  it('field order matches at least 99.9% of shipped table fields, and every child element is known', () => {
    let fields = 0; let bad = 0; const unknown = new Set<string>();
    for (const f of listFiles('AxTable')) {
      const xml = fs.readFileSync(f, 'utf-8').replace(/\r\n/g, '\n');
      for (const m of xml.matchAll(/^\t\t<AxTableField\b[^>]*>\n([\s\S]*?)^\t\t<\/AxTableField\w*>/gm)) {
        const seq = [...new Set([...m[1].matchAll(/^\t\t\t<(\w+)[ />]/gm)].map(x => x[1]))];
        seq.forEach(n => { if (!(FIELD_ELEMENT_ORDER as readonly string[]).includes(n)) unknown.add(n); });
        fields++;
        if (!consistent(seq, FIELD_ELEMENT_ORDER)) bad++;
      }
    }
    expect([...unknown]).toEqual([]);
    expect(bad / fields).toBeLessThan(0.001);
  });
});
