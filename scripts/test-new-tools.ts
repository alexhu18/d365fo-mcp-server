/**
 * Targeted end-to-end test for map / config-key / security-policy / macro
 * indexing + their get_*_info tools. Extracts a handful of real standard objects
 * into a temp metadata dir, indexes into a temp SQLite DB, then calls each tool.
 *
 * Run: ./node_modules/.bin/tsx scripts/test-new-tools.ts
 */
import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { XppMetadataParser } from '../src/metadata/xmlParser.js';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { getMapInfoTool } from '../src/tools/mapInfo.js';
import { getConfigKeyInfoTool } from '../src/tools/configKeyInfo.js';
import { getSecurityPolicyInfoTool } from '../src/tools/securityPolicyInfo.js';
import { getMacroInfoTool } from '../src/tools/macroInfo.js';

const PKG = process.env.D365FO_PACKAGE_PATH || 'K:\\AOSService\\PackagesLocalDirectory';
const parser = new XppMetadataParser();

interface Spec { model: string; axDir: string; outDir: string; type: string; parse: (f: string) => Promise<any>; limit?: number; }

const SPECS: Spec[] = [
  { model: 'ApplicationFoundation', axDir: 'AxMap',               outDir: 'maps',                type: 'map',               parse: f => parser.parseMapFile(f), limit: 50 },
  { model: 'ApplicationFoundation', axDir: 'AxLicenseCode',       outDir: 'license-codes',       type: 'license-code',      parse: f => parser.parseLicenseCodeFile(f) },
  { model: 'ApplicationFoundation', axDir: 'AxSecurityPolicy',    outDir: 'security-policies',   type: 'security-policy',   parse: f => parser.parseSecurityPolicyFile(f), limit: 50 },
  { model: 'ApplicationPlatform',   axDir: 'AxConfigurationKey',  outDir: 'configuration-keys',  type: 'configuration-key', parse: f => parser.parseConfigurationKeyFile(f), limit: 100 },
  { model: 'ApplicationPlatform',   axDir: 'AxMacroDictionary',   outDir: 'macros',              type: 'macro',             parse: f => parser.parseMacroFile(f), limit: 30 },
];

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'newtools-'));
  const metaDir = path.join(tmp, 'meta');

  for (const s of SPECS) {
    const dir = path.join(PKG, s.model, s.model, s.axDir);
    let files: string[];
    try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.xml')); } catch { console.log(`(skip ${s.axDir} — not found)`); continue; }
    if (s.limit) files = files.slice(0, s.limit);
    const out = path.join(metaDir, s.model, s.outDir);
    await fs.mkdir(out, { recursive: true });
    let ok = 0;
    for (const f of files) {
      const r = await s.parse(path.join(dir, f));
      if (r.success && r.data) { await fs.writeFile(path.join(out, `${r.data.name}.json`), JSON.stringify({ ...r.data, model: s.model, type: s.type }, null, 2)); ok++; }
    }
    console.log(`extracted ${ok} ${s.type}`);
  }

  const idx = new XppSymbolIndex(path.join(tmp, 'test.db'), path.join(tmp, 'labels.db'));
  for (const m of ['ApplicationFoundation', 'ApplicationPlatform']) await idx.indexMetadataDirectory(metaDir, m);

  const db = idx.getReadDb();
  for (const t of ['map', 'license-code', 'security-policy', 'configuration-key', 'macro']) {
    const c = (db.prepare(`SELECT COUNT(*) c FROM symbols WHERE type=?`).get(t) as any).c;
    console.log(`  symbols[${t}] = ${c}`);
  }
  console.log(`  map_mappings=${(db.prepare(`SELECT COUNT(*) c FROM map_mappings`).get() as any).c}, security_policies=${(db.prepare(`SELECT COUNT(*) c FROM security_policies`).get() as any).c}, macro_defines=${(db.prepare(`SELECT COUNT(*) c FROM macro_defines`).get() as any).c}\n`);

  const ctx: any = { symbolIndex: idx };
  const call = async (tool: any, args: any) => (await tool({ params: { name: 't', arguments: args } }, ctx)).content[0].text;

  // Pick representative names from the DB
  const aMap = (db.prepare(`SELECT name FROM symbols WHERE type='map' AND name='LogMap'`).get() as any)?.name
            || (db.prepare(`SELECT name FROM symbols WHERE type='map' LIMIT 1`).get() as any)?.name;
  const aPolicy = (db.prepare(`SELECT policy_name FROM security_policies LIMIT 1`).get() as any)?.policy_name;
  const aKey = (db.prepare(`SELECT name FROM symbols WHERE type='configuration-key' AND signature IS NOT NULL LIMIT 1`).get() as any)?.name;
  const aLic = (db.prepare(`SELECT name FROM symbols WHERE type='license-code' LIMIT 1`).get() as any)?.name;
  const aMacro = (db.prepare(`SELECT name FROM symbols WHERE type='macro' AND name='AOT'`).get() as any)?.name
              || (db.prepare(`SELECT name FROM symbols WHERE type='macro' LIMIT 1`).get() as any)?.name;

  for (const [tool, args] of [
    [getMapInfoTool, { mapName: aMap }],
    [getSecurityPolicyInfoTool, { policyName: aPolicy }],
    [getConfigKeyInfoTool, { name: aKey }],
    [getConfigKeyInfoTool, { name: aLic }],
    [getMacroInfoTool, { macroName: aMacro, filter: 'Path' }],
  ] as any[]) {
    console.log('─'.repeat(70));
    console.log(await call(tool, args));
  }

  idx.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
