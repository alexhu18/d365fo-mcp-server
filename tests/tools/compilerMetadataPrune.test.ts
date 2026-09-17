import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// utimes can be made to fail for chosen paths; everything else is the real filesystem.
const { failingTouch } = vi.hoisted(() => ({ failingTouch: new Set<string>() }));
vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  return {
    ...real,
    utimes: async (p: string, a: Date, m: Date) => {
      if (failingTouch.has(p)) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' });
      return real.utimes(p, a, m);
    },
  };
});

import { pruneStaleCompilerMetadata } from '../../src/tools/sdlc/compilerMetadataPrune';

const PKG = 'MyPkg';
const MODEL = 'MyModel';

let root: string;
const src = (type: string, name: string) => path.join(root, PKG, MODEL, type, `${name}.xml`);
const meta = (type: string, name: string, model = MODEL) =>
  path.join(root, PKG, 'XppMetadata', model, type, `${name}.xml`);

function write(file: string, mtime: Date) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<x/>');
  fs.utimesSync(file, mtime, mtime);
}

const OLD = new Date('2026-01-01T00:00:00Z');
const NEWER = new Date('2026-02-01T00:00:00Z');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xppmeta-prune-'));
  failingTouch.clear();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pruneStaleCompilerMetadata', () => {
  it('drops the metadata of an element whose source changed, and touches the source', async () => {
    // A removed field is never written back by xppc -incremental: the file keeps its old mtime.
    write(meta('AxClass', 'Changed'), OLD);
    write(src('AxClass', 'Changed'), NEWER);
    const before = Date.now();

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r.stale).toEqual([meta('AxClass', 'Changed')]);
    expect(fs.existsSync(meta('AxClass', 'Changed'))).toBe(false);
    // xppc picks what to recompile by source mtime; a change an earlier build already
    // compiled would otherwise not be recompiled, and the element would vanish.
    expect(fs.statSync(src('AxClass', 'Changed')).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(fs.readFileSync(src('AxClass', 'Changed'), 'utf-8')).toBe('<x/>');
  });

  it('leaves current metadata and its source alone', async () => {
    write(src('AxTable', 'Current'), OLD);
    write(meta('AxTable', 'Current'), NEWER);

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r).toMatchObject({ stale: [], phantoms: [], errors: [], scanned: 1 });
    expect(fs.existsSync(meta('AxTable', 'Current'))).toBe(true);
    expect(fs.statSync(src('AxTable', 'Current')).mtimeMs).toBe(OLD.getTime());
  });

  it('treats an equal mtime as current', async () => {
    write(src('AxTable', 'Same'), OLD);
    write(meta('AxTable', 'Same'), OLD);

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r.stale).toEqual([]);
    expect(fs.existsSync(meta('AxTable', 'Same'))).toBe(true);
  });

  it('drops the metadata of a deleted element', async () => {
    write(src('AxClass', 'Kept'), OLD);
    write(meta('AxClass', 'Kept'), NEWER);
    write(meta('AxClass', 'Deleted'), NEWER);
    write(meta('AxForm', 'DeletedForm'), NEWER); // a whole type folder gone from source

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r.phantoms.sort()).toEqual([meta('AxClass', 'Deleted'), meta('AxForm', 'DeletedForm')].sort());
    expect(fs.existsSync(meta('AxClass', 'Kept'))).toBe(true);
  });

  it('keeps the stale file when the source cannot be touched — stale beats missing', async () => {
    write(meta('AxClass', 'Locked'), OLD);
    write(src('AxClass', 'Locked'), NEWER);
    failingTouch.add(src('AxClass', 'Locked'));

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r.stale).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(fs.existsSync(meta('AxClass', 'Locked'))).toBe(true);
  });

  it('never touches a model that has no source folder (deployed without source)', async () => {
    fs.mkdirSync(path.join(root, PKG, MODEL), { recursive: true });
    write(meta('AxClass', 'Binary', 'OtherModel'), OLD);

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r.skippedModels).toEqual(['OtherModel']);
    expect(r.phantoms).toEqual([]);
    expect(fs.existsSync(meta('AxClass', 'Binary', 'OtherModel'))).toBe(true);
  });

  it('reads sources from the source root and metadata from the compiler-metadata root', async () => {
    const sourceRoot = path.join(root, 'store');
    const metaRoot = path.join(root, 'compiler');
    write(path.join(sourceRoot, PKG, MODEL, 'AxClass', 'C.xml'), NEWER);
    const metaFile = path.join(metaRoot, PKG, 'XppMetadata', MODEL, 'AxClass', 'C.xml');
    write(metaFile, OLD);

    const r = await pruneStaleCompilerMetadata(metaRoot, sourceRoot, PKG);

    expect(r.stale).toEqual([metaFile]);
  });

  it('classifies every file when many are checked concurrently', async () => {
    for (let i = 0; i < 50; i++) {
      write(meta('AxClass', `C${i}`), i % 2 ? OLD : NEWER);
      if (i % 5 !== 0) write(src('AxClass', `C${i}`), i % 2 ? NEWER : OLD);
    }

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    // i % 5 === 0 → no source (10); otherwise odd → stale (20), even → current (20).
    expect(r.scanned).toBe(50);
    expect(r.phantoms).toHaveLength(10);
    expect(r.stale).toHaveLength(20);
    expect(fs.readdirSync(path.dirname(meta('AxClass', 'C0')))).toHaveLength(20);
  });

  it('is a no-op when the package has no XppMetadata yet', async () => {
    write(src('AxClass', 'New'), NEWER);

    const r = await pruneStaleCompilerMetadata(root, root, PKG);

    expect(r).toEqual({ stale: [], phantoms: [], skippedModels: [], errors: [], scanned: 0 });
    expect(fs.statSync(src('AxClass', 'New')).mtimeMs).toBe(NEWER.getTime());
  });
});
