/**
 * indexOneFile must not invent a symbol for a file that is not an AOT object.
 *
 * classifyAotFolder falls back to 'class' for an unrecognised folder. That is a
 * sane default for an Ax* folder this server does not model yet, and a lie for a
 * path with NO Ax* folder at all: a model descriptor lives at
 * <Package>/Descriptor/<Model>.xml, so every descriptor write indexed a CLASS
 * named after the model, in model "Unknown". It was not theoretical — the first
 * live runs of add-module-reference put exactly such a row in a real index,
 * where `search` returned it as an exact match and resolve_references would have
 * accepted it as a real type.
 *
 * The skip branch also PRUNES, so pointing update_symbol_index at such a file is
 * what cleans up what the old behaviour inserted.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { indexOneFile, classifyAotFolder, isAotFolder } from '../../src/tools/sdlc/updateSymbolIndex';

let dir: string;

/** Minimal symbolIndex double — only what the skip branch touches. */
function fakeIndex(removed = 0) {
  return {
    removeSymbolsByFile: vi.fn(() => ({ deletedCount: removed })),
    removeLabelsByFile: vi.fn(() => 0),
    touchLastIndexed: vi.fn(),
    addSymbol: vi.fn(),
    bulkAddLabels: vi.fn(),
    db: { transaction: (fn: any) => fn },
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nonaot-index-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('the classification trap this guards', () => {
  it("classifies an absent AOT folder as 'class' — the reason the guard exists", () => {
    expect(isAotFolder('Descriptor')).toBe(false);
    // Not a bug in itself; a bug the moment it is applied to a non-AOT path.
    expect(classifyAotFolder('')).toBe('class');
  });

  it('still classifies a real Ax* folder, mapped or not', () => {
    expect(isAotFolder('AxClass')).toBe(true);
    expect(isAotFolder('AxWorkflowType')).toBe(true);
    expect(classifyAotFolder('AxTable')).toBe('table');
  });
});

describe('indexOneFile on a model descriptor', () => {
  it('indexes NO symbol for it', async () => {
    const descriptorDir = path.join(dir, 'ContosoPkg', 'Descriptor');
    await fs.mkdir(descriptorDir, { recursive: true });
    const file = path.join(descriptorDir, 'Contoso.xml');
    await fs.writeFile(file, '<?xml version="1.0"?>\n<AxModelInfo><Name>Contoso</Name></AxModelInfo>', 'utf-8');

    const symbolIndex = fakeIndex();
    const r = await indexOneFile(file, { symbolIndex } as any);

    expect(r.isError).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.text).toMatch(/not an AOT object file/i);
    // The phantom row is the whole point: nothing may be inserted.
    expect(symbolIndex.addSymbol).not.toHaveBeenCalled();
  });

  it('prunes the phantom a previous run inserted for that path', async () => {
    const descriptorDir = path.join(dir, 'ContosoPkg2', 'Descriptor');
    await fs.mkdir(descriptorDir, { recursive: true });
    const file = path.join(descriptorDir, 'Contoso.xml');
    await fs.writeFile(file, '<AxModelInfo><Name>Contoso</Name></AxModelInfo>', 'utf-8');

    const symbolIndex = fakeIndex(1);
    const r = await indexOneFile(file, { symbolIndex } as any);

    expect(symbolIndex.removeSymbolsByFile).toHaveBeenCalledWith(file);
    expect(r.text).toMatch(/Removed 1 stale symbol/i);
    // Self-healing: running update_symbol_index on the file is the cleanup.
    expect(symbolIndex.touchLastIndexed).toHaveBeenCalled();
  });

  it('says nothing about the index on a descriptor write', async () => {
    // The write response used to end with "🔎 Symbol index updated in place",
    // which was a claim about a symbol that should never have existed.
    const { upsertWrittenFileIntoIndex } = await import('../../src/tools/write/inlineIndexUpsert');
    const descriptorDir = path.join(dir, 'ContosoPkg3', 'Descriptor');
    await fs.mkdir(descriptorDir, { recursive: true });
    const file = path.join(descriptorDir, 'Contoso.xml');
    await fs.writeFile(file, '<AxModelInfo><Name>Contoso</Name></AxModelInfo>', 'utf-8');

    const note = await upsertWrittenFileIntoIndex(file, { symbolIndex: fakeIndex() } as any);
    expect(note).toBe('');
  });
});
