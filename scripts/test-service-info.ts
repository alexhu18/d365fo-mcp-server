/**
 * Targeted end-to-end test for the service indexing + get_service_info pipeline.
 * Extracts AxService/AxServiceGroup from one standard model into a temp metadata
 * dir, indexes it into a temp SQLite DB, then calls getServiceInfoTool.
 *
 * Run: ./node_modules/.bin/tsx scripts/test-service-info.ts
 */
import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { XppMetadataParser } from '../src/metadata/xmlParser.js';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { getServiceInfoTool } from '../src/tools/serviceInfo.js';

const PKG = process.env.D365FO_PACKAGE_PATH || 'K:\\AOSService\\PackagesLocalDirectory';
const MODEL = 'ApplicationFoundation';
const MODEL_DIR = path.join(PKG, MODEL, MODEL);

async function main() {
  const parser = new XppMetadataParser();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-test-'));
  const metaDir = path.join(tmp, 'meta');
  const svcOut = path.join(metaDir, MODEL, 'services');
  const grpOut = path.join(metaDir, MODEL, 'service-groups');
  await fs.mkdir(svcOut, { recursive: true });
  await fs.mkdir(grpOut, { recursive: true });

  // Extract services
  const svcDir = path.join(MODEL_DIR, 'AxService');
  for (const f of (await fs.readdir(svcDir)).filter(f => f.endsWith('.xml'))) {
    const r = await parser.parseServiceFile(path.join(svcDir, f));
    if (r.success && r.data) {
      await fs.writeFile(path.join(svcOut, `${r.data.name}.json`), JSON.stringify({ ...r.data, model: MODEL, type: 'service' }, null, 2));
    }
  }
  // Extract service groups
  const grpDir = path.join(MODEL_DIR, 'AxServiceGroup');
  for (const f of (await fs.readdir(grpDir)).filter(f => f.endsWith('.xml'))) {
    const r = await parser.parseServiceGroupFile(path.join(grpDir, f));
    if (r.success && r.data) {
      await fs.writeFile(path.join(grpOut, `${r.data.name}.json`), JSON.stringify({ ...r.data, model: MODEL, type: 'service-group' }, null, 2));
    }
  }
  console.log(`Extracted services + groups to ${metaDir}`);

  // Index into temp DB
  const dbPath = path.join(tmp, 'test.db');
  const idx = new XppSymbolIndex(dbPath, path.join(tmp, 'labels.db'));
  await idx.indexMetadataDirectory(metaDir, MODEL);

  const db = idx.getReadDb();
  const svcCount = (db.prepare(`SELECT COUNT(*) c FROM symbols WHERE type='service'`).get() as any).c;
  const grpCount = (db.prepare(`SELECT COUNT(*) c FROM symbols WHERE type='service-group'`).get() as any).c;
  const opCount = (db.prepare(`SELECT COUNT(*) c FROM service_operations`).get() as any).c;
  const memCount = (db.prepare(`SELECT COUNT(*) c FROM service_group_members`).get() as any).c;
  console.log(`\nIndexed: ${svcCount} services, ${grpCount} groups, ${opCount} operations, ${memCount} group-members\n`);

  // Query a service that is a member of DMFService group
  const ctx: any = { symbolIndex: idx };
  for (const name of ['DMFStagingService', 'AifUserSessionService']) {
    const req: any = { params: { name: 'get_service_info', arguments: { serviceName: name } } };
    const res = await getServiceInfoTool(req, ctx);
    console.log('─'.repeat(70));
    console.log(res.content[0].text);
  }

  idx.close();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* temp cleanup best-effort */ });
}

main().catch(e => { console.error(e); process.exit(1); });
