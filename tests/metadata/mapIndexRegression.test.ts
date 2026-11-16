import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { readIndexedMethodSource } from '../../src/utils/indexedMethodSource';

const dirs: string[] = [];
const indexes: XppSymbolIndex[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-index-')); dirs.push(dir); return dir; };
afterEach(() => {
  for (const index of indexes.splice(0)) index.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AxMap indexing regressions', () => {
  it('serves method bodies from SQLite when XML is unavailable', () => {
    const dir = temp();
    const source = 'public void run() { info("map"); }';
    fs.writeFileSync(path.join(dir, 'TestMap.json'), JSON.stringify({ name: 'TestMap', methods: [
      { name: 'run', returnType: 'void', parameters: [], source, sourceSnippet: source },
    ] }));
    const index = new XppSymbolIndex(':memory:', ':memory:'); indexes.push(index);
    (index as any).indexMaps(dir, 'Test');
    expect(readIndexedMethodSource(index.getReadDb() as any, 'TestMap', 'run')?.source).toBe(source);
  });

  it('migrates duplicate bindings and enforces their natural key', () => {
    const dir = temp();
    const dbPath = path.join(dir, 'index.db');
    const labels = path.join(dir, 'labels.db');
    const first = new XppSymbolIndex(dbPath, labels); first.close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`DROP INDEX idx_mm_binding;
      INSERT INTO map_mappings (map_name, mapping_table, field_connections, model) VALUES ('Map', 'Table', 1, 'M'), ('Map', 'Table', 2, 'M');`);
    legacy.close();
    const index = new XppSymbolIndex(dbPath, labels); indexes.push(index);
    const db = index.getReadDb();
    expect(db.prepare('SELECT field_connections FROM map_mappings').all()).toEqual([{ field_connections: 2 }]);
    expect(() => (index as any).db.prepare('INSERT INTO map_mappings (map_name, mapping_table, model) VALUES (?, ?, ?)').run('Map', 'Table', 'M')).toThrow();
  });

  it('backfills across different package/model names, repeats safely and removes stale bindings', async () => {
    const dir = temp();
    const dbPath = path.join(dir, 'index.db');
    const index = new XppSymbolIndex(dbPath, path.join(dir, 'labels.db'));
    index.addSymbol({ name: 'TestMap', type: 'map', model: 'TestModel', filePath: 'missing.xml' });
    index.close();
    const packages = path.join(dir, 'packages');
    const tables = path.join(packages, 'DifferentPackage', 'TestModel', 'AxTable');
    fs.mkdirSync(tables, { recursive: true });
    const tablePath = path.join(tables, 'Table.xml');
    const write = (mappings: string) => fs.writeFileSync(tablePath, `<AxTable><Name>Table</Name>${mappings}</AxTable>`);
    write('<Mappings><AxTableMapping><MappingTable>TestMap</MappingTable><Connections><AxTableMappingConnection><MapField>A</MapField><MapFieldTo>B</MapFieldTo></AxTableMappingConnection></Connections></AxTableMapping></Mappings>');
    // A binding the MAP declares, in the same model as the table, as indexMaps stores it.
    // 86 of 147 shipped map-side bindings are shaped like this one.
    const maps = path.join(packages, 'DifferentPackage', 'TestModel', 'AxMap');
    fs.mkdirSync(maps, { recursive: true });
    fs.writeFileSync(path.join(maps, 'SiblingMap.xml'), '<AxMap><Name>SiblingMap</Name><Mappings><AxTableMapping><MappingTable>Table</MappingTable></AxTableMapping></Mappings></AxMap>');
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO map_mappings (map_name, mapping_table, field_connections, model) VALUES ('SiblingMap', 'Table', 3, 'TestModel')").run();
    db.close();
    const count = () => {
      const d = new DatabaseSync(dbPath);
      try { return d.prepare('SELECT map_name FROM map_mappings ORDER BY map_name').all().map(r => r.map_name); } finally { d.close(); }
    };
    // @ts-expect-error standalone maintenance script has no declaration file
    const { backfillMapMappings } = await import('../../scripts/backfill-map-mappings.mjs');
    await backfillMapMappings(dbPath, packages, ['TestModel']);
    await backfillMapMappings(dbPath, packages, ['TestModel']);
    expect(count()).toEqual(['SiblingMap', 'TestMap']);
    // A malformed file must roll back the earlier table updates as well.
    write('');
    fs.writeFileSync(path.join(tables, 'ZBroken.xml'), '<AxTable>');
    await expect(backfillMapMappings(dbPath, packages)).rejects.toThrow();
    expect(count()).toEqual(['SiblingMap', 'TestMap']);
    fs.unlinkSync(path.join(tables, 'ZBroken.xml'));
    await backfillMapMappings(dbPath, packages);
    // The stale table-side binding goes; the one the map declares stays.
    expect(count()).toEqual(['SiblingMap']);
  });
});
