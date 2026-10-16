/**
 * The one stale-row rule (isStaleIndexedPath), exercised against REAL directories.
 *
 * "No file at the recorded path or its remap" means two different things:
 *   - the index was built on THIS machine (its metadata root is here and holds
 *     packages) → the object was deleted: a rolled-back table, a removed model, a
 *     package dropped by a branch switch;
 *   - the index was built elsewhere (CI agent, old UDE version folder) → absence
 *     proves nothing unless the object's own or model folder is here.
 * Getting the first wrong serves ghost fields; getting the second wrong answered
 * "not found" for CustTable on every bridge-less machine (PR #1071).
 *
 * No fs mocking: every case builds the tree it describes in a temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-rule-')));
const PLD = path.join(TMP, 'AosService', 'PackagesLocalDirectory');
const CUSTOM = path.join(TMP, 'repo', 'Metadata');
const roots = { pld: PLD as string | null, custom: null as string | null };

vi.mock('../../src/utils/configManager', async (orig) => ({
  ...(await orig<any>()),
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => roots.pld,
    getCustomPackagesPath: async () => roots.custom,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => '',
}));

const mockLookup = vi.fn();
vi.mock('../../src/utils/symbolLookup', async (orig) => ({
  ...(await orig<any>()),
  lookupSymbolNocase: (...args: unknown[]) => mockLookup(...args),
}));

import { indexedPathIsMissing, resolveIndexedObject, resetStaleRootCache } from '../../src/utils/indexedXmlLookup';

function touch(p: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '<AxTable/>');
  return p;
}
const inPld = (...segs: string[]) => path.join(PLD, ...segs);
const CI = '/home/vsts/work/1/PackagesLocalDirectory';
const CI_WIN = 'C:\\home\\vsts\\work\\1\\PackagesLocalDirectory';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(PLD, { recursive: true });
  // A populated packages root, as the indexer saw it.
  touch(inPld('ApplicationSuite', 'Foundation', 'AxTable', 'CustTable.xml'));
  touch(inPld('fm', 'fm', 'AxTable', 'Keep.xml'));
  roots.pld = PLD;
  roots.custom = null;
  resetStaleRootCache();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('index built on this machine — any missing file is a deletion', () => {
  it('A: rolled-back table, its AxTable folder still there', async () => {
    expect(await indexedPathIsMissing(inPld('fm', 'fm', 'AxTable', 'Gone.xml'))).toBe(true);
  });

  it('B: the only table of a model, AxTable folder removed with it', async () => {
    fs.mkdirSync(inPld('solo', 'solo', 'AxClass'), { recursive: true });
    expect(await indexedPathIsMissing(inPld('solo', 'solo', 'AxTable', 'Only.xml'))).toBe(true);
  });

  it('C: the whole package folder is gone (custom model deleted, branch switched)', async () => {
    expect(await indexedPathIsMissing(inPld('DeletedPkg', 'DeletedPkg', 'AxTable', 'Ghost.xml'))).toBe(true);
  });

  it('C2: one model of a multi-model package is gone', async () => {
    fs.mkdirSync(inPld('MultiPkg', 'OtherModel', 'AxTable'), { recursive: true });
    expect(await indexedPathIsMissing(inPld('MultiPkg', 'RemovedModel', 'AxTable', 'Ghost.xml'))).toBe(true);
  });

  it('F: custom metadata root outside PackagesLocalDirectory, file deleted', async () => {
    touch(path.join(CUSTOM, 'Pkg', 'Pkg', 'AxTable', 'Keep.xml'));
    expect(await indexedPathIsMissing(path.join(CUSTOM, 'Pkg', 'Pkg', 'AxTable', 'Gone.xml'))).toBe(true);
  });

  it('F2: custom metadata root outside PackagesLocalDirectory, whole package removed', async () => {
    touch(path.join(CUSTOM, 'Pkg', 'Pkg', 'AxTable', 'Keep.xml'));
    expect(await indexedPathIsMissing(path.join(CUSTOM, 'Removed', 'Removed', 'AxTable', 'Gone.xml'))).toBe(true);
  });

  it('a symlinked model whose target was removed is a deletion, not "not installed"', async () => {
    const target = path.join(TMP, 'repoModel');
    fs.mkdirSync(path.join(target, 'AxTable'), { recursive: true });
    fs.symlinkSync(target, inPld('Linked'), 'junction');
    fs.rmSync(target, { recursive: true, force: true });
    expect(await indexedPathIsMissing(inPld('Linked', 'Linked', 'AxTable', 'T.xml'))).toBe(true);
  });

  it('never flags a file that is there', async () => {
    expect(await indexedPathIsMissing(inPld('ApplicationSuite', 'Foundation', 'AxTable', 'CustTable.xml'))).toBe(false);
  });
});

describe('index built elsewhere — only the object\'s folder being here proves anything', () => {
  it('serves a CI-built row whose file remaps onto this machine', async () => {
    const recorded = `${CI}/ApplicationSuite/Foundation/AxTable/CustTable.xml`;
    mockLookup.mockReturnValue({ name: 'CustTable', model: 'Foundation', file_path: recorded });
    const ref = await resolveIndexedObject({}, 'CustTable', ['table']);
    expect(ref?.localPath).toBe(inPld('ApplicationSuite', 'Foundation', 'AxTable', 'CustTable.xml'));
    expect(ref?.sourceFileMissing).toBe(false);
  });

  it('does not flag a CI-built row recorded with Windows separators', async () => {
    expect(await indexedPathIsMissing(`${CI_WIN}\\ApplicationSuite\\Foundation\\AxTable\\CustTable.xml`)).toBe(false);
    expect(await indexedPathIsMissing(`${CI_WIN}\\Retail\\Retail\\AxTable\\X.xml`)).toBe(false);
  });

  it('does not flag a CI-built row whose package is not installed here', async () => {
    expect(await indexedPathIsMissing(`${CI}/Retail/Retail/AxTable/X.xml`)).toBe(false);
  });

  it('does not flag CI-built rows when no packages root is configured (hosted server)', async () => {
    roots.pld = null;
    expect(await indexedPathIsMissing(`${CI}/ApplicationSuite/Foundation/AxTable/CustTable.xml`)).toBe(false);
  });

  it('flags a CI-built row whose AxTable folder is here but the file is not', async () => {
    expect(await indexedPathIsMissing(`${CI}/ApplicationSuite/Foundation/AxTable/NotInThisVersion.xml`)).toBe(true);
  });

  it('does not judge against an EMPTY packages-root stub (UDE boxes carry one)', async () => {
    const stub = path.join(TMP, 'stub', 'PackagesLocalDirectory');
    fs.mkdirSync(stub, { recursive: true });
    expect(await indexedPathIsMissing(path.join(stub, 'Pkg', 'Pkg', 'AxTable', 'T.xml'))).toBe(false);
  });

  it('says nothing about a JSON metadata-cache path', async () => {
    expect(await indexedPathIsMissing(inPld('fm', 'fm', 'AxTable', 'Gone.json'))).toBe(false);
  });
});

describe('package-relative rows', () => {
  it('resolves one against the packages root, not the process cwd', async () => {
    mockLookup.mockReturnValue({ name: 'Keep', model: 'fm', file_path: 'fm/fm/AxTable/Keep.xml' });
    const ref = await resolveIndexedObject({}, 'Keep', ['table']);
    expect(ref?.localPath).toBe(inPld('fm', 'fm', 'AxTable', 'Keep.xml'));
    expect(ref?.sourceFileMissing).toBe(false);
  });

  it('flags one whose model folder is here without the file', async () => {
    expect(await indexedPathIsMissing('fm/fm/AxTable/Gone.xml')).toBe(true);
  });

  it('does not flag one whose package is not here — it names no root to judge by', async () => {
    expect(await indexedPathIsMissing('Other/Other/AxTable/X.xml')).toBe(false);
  });

  it('does not flag a bare file name', async () => {
    expect(await indexedPathIsMissing('Foo.xml')).toBe(false);
    expect(await indexedPathIsMissing('AxTable/Foo.xml')).toBe(false);
  });
});
