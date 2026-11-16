/**
 * Backfill table-to-map bindings from native XML into an existing symbol index.
 * Stop the MCP server before running. Paths are explicit; no user-specific defaults.
 * Usage: node scripts/backfill-map-mappings.mjs --db <file> --packages <root> [--models ModelA,ModelB]
 */
import { DatabaseSync } from 'node:sqlite';
import { Parser } from 'xml2js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export async function backfillMapMappings(dbPath, packagesRoot, models = []) {
  // Do not create a new empty database when the supplied path is wrong.
  if (!fs.statSync(dbPath).isFile()) throw new Error('Database path must be an existing file');
  if (!fs.statSync(packagesRoot).isDirectory()) throw new Error('Packages path must be a directory');
  const selected = new Set(models.map(m => m.toLowerCase()));
  const directories = [];
  const mapDirectories = [];
  for (const pkg of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const packagePath = path.join(packagesRoot, pkg.name);
    for (const model of fs.readdirSync(packagePath, { withFileTypes: true })) {
      if (!model.isDirectory() || (selected.size && !selected.has(model.name.toLowerCase()))) continue;
      const dir = path.join(packagePath, model.name, 'AxTable');
      if (fs.existsSync(dir)) directories.push({ model: model.name, dir });
      const mapDir = path.join(packagePath, model.name, 'AxMap');
      if (fs.existsSync(mapDir)) mapDirectories.push({ model: model.name, dir: mapDir });
    }
  }
  if (!directories.length) throw new Error('No matching Package/Model/AxTable directories found');
  const parser = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  const db = new DatabaseSync(dbPath);
  let scanned = 0, inserted = 0;
  try {
    // Validate the existing index before beginning any writes.
    const maps = new Set(db.prepare("SELECT name FROM symbols WHERE type = 'map'").all().map(r => r.name.toLowerCase()));
    db.prepare('SELECT map_name, mapping_table, field_connections, model FROM map_mappings LIMIT 0').all();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        DELETE FROM map_mappings WHERE id NOT IN (
          SELECT MAX(id) FROM map_mappings GROUP BY map_name, mapping_table, model
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_binding ON map_mappings(map_name, mapping_table, model);
      `);
      // A binding is declared on EITHER side: 56 shipped maps list tables in their own <Mappings>,
      // and those rows carry the map's model, which is often the table's model too (86 of 147).
      // Rows do not record their side, so the map-side ones are read back from the maps' XML and
      // never removed here; only a table-side binding the table no longer declares is stale.
      const mapSide = new Set();
      for (const { model, dir } of mapDirectories) {
        for (const file of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml'))) {
          const parsed = await parser.parseStringPromise(fs.readFileSync(path.join(dir, file), 'utf8'));
          const map = parsed?.AxMap;
          if (!map?.Name) throw new Error(`Not a named AxMap: ${path.join(dir, file)}`);
          const raw = map.Mappings?.AxTableMapping;
          for (const mapping of Array.isArray(raw) ? raw : raw ? [raw] : []) {
            if (mapping.MappingTable) mapSide.add(`${map.Name}|${mapping.MappingTable}|${model}`.toLowerCase());
          }
        }
      }
      const existing = db.prepare('SELECT id, map_name FROM map_mappings WHERE mapping_table = ? AND model = ?');
      const remove = db.prepare('DELETE FROM map_mappings WHERE id = ?');
      const insert = db.prepare(`INSERT INTO map_mappings (map_name, mapping_table, field_connections, model)
        VALUES (?, ?, ?, ?) ON CONFLICT(map_name, mapping_table, model)
        DO UPDATE SET field_connections = excluded.field_connections`);
      for (const { model, dir } of directories) {
        for (const file of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml'))) {
          // Fail and roll back on unreadable/malformed XML rather than leave a partial result.
          const parsed = await parser.parseStringPromise(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (!parsed?.AxTable?.Name) throw new Error(`Not a named AxTable: ${path.join(dir, file)}`);
          scanned++;
          const table = parsed.AxTable;
          const raw = table.Mappings?.AxTableMapping;
          const declared = new Set((Array.isArray(raw) ? raw : raw ? [raw] : [])
            .map(m => (m.MappingTable || '').toLowerCase()).filter(Boolean));
          for (const row of existing.all(table.Name, model)) {
            const name = row.map_name.toLowerCase();
            if (!declared.has(name) && !mapSide.has(`${name}|${table.Name}|${model}`.toLowerCase())) remove.run(row.id);
          }
          for (const mapping of Array.isArray(raw) ? raw : raw ? [raw] : []) {
            if (!mapping.MappingTable || !maps.has(mapping.MappingTable.toLowerCase())) continue;
            const connections = mapping.Connections?.AxTableMappingConnection;
            const count = Array.isArray(connections) ? connections.length : connections ? 1 : 0;
            inserted += Number(insert.run(mapping.MappingTable, table.Name, count, model).changes);
          }
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { scanned, inserted };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { db: { type: 'string' }, packages: { type: 'string' }, models: { type: 'string' } } });
    if (!values.db || !values.packages) throw new Error('Usage: node scripts/backfill-map-mappings.mjs --db <existing.db> --packages <root> [--models ModelA,ModelB]');
    const models = (values.models || '').split(',').map(m => m.trim()).filter(Boolean);
    console.log(await backfillMapMappings(values.db, values.packages, models));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
