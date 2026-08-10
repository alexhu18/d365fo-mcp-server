/**
 * Scoped incremental indexing.
 *
 * `indexMetadataDirectory` must be able to index an explicit *list* of models in a single
 * pass — that is what lets build-database's `custom`/`standard` modes rebuild only the
 * changed models without paying a full FTS rebuild per model. These tests pin:
 *   1. an array argument indexes exactly those models and nothing else, and
 *   2. the extract-manifest write/read roundtrip that bridges extract → build classification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  writeExtractManifest,
  readExtractedCustomModels,
  EXTRACT_MANIFEST_FILENAME,
} from '../../src/utils/extractManifest';

let tmpDir: string;

/** Write a minimal classes/<name>.json so a model directory has one indexable class. */
async function writeModelWithClass(root: string, model: string, className: string): Promise<void> {
  const dir = path.join(root, model, 'classes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${className}.json`),
    JSON.stringify({ name: className, type: 'class', model }, null, 2),
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-idx-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('indexMetadataDirectory scoping', () => {
  it('indexes exactly the models named in an array, skipping the rest', async () => {
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');
    await writeModelWithClass(extracted, 'ModelB', 'ClassB');
    await writeModelWithClass(extracted, 'ModelC', 'ClassC');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted, ['ModelA', 'ModelC']);

    const models = index
      .getReadDb()
      .prepare('SELECT DISTINCT model FROM symbols ORDER BY model')
      .all()
      .map((r: any) => r.model);

    expect(models).toEqual(['ModelA', 'ModelC']);
    index.close?.();
  });

  it('a single string argument still indexes just that one model', async () => {
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');
    await writeModelWithClass(extracted, 'ModelB', 'ClassB');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted, 'ModelB');

    const models = index
      .getReadDb()
      .prepare('SELECT DISTINCT model FROM symbols')
      .all()
      .map((r: any) => r.model);

    expect(models).toEqual(['ModelB']);
    index.close?.();
  });

  it('omitting the argument indexes every model directory', async () => {
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');
    await writeModelWithClass(extracted, 'ModelB', 'ClassB');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted);

    const count = index.getReadDb().prepare('SELECT COUNT(DISTINCT model) AS n FROM symbols').get() as { n: number };
    expect(count.n).toBe(2);
    index.close?.();
  });
});

describe('extract manifest bridge', () => {
  it('roundtrips the recorded custom models', () => {
    writeExtractManifest(tmpDir, {
      generatedAt: new Date().toISOString(),
      extractMode: 'custom',
      environment: 'ude',
      customModels: ['MyCustomModel'],
    });

    expect(readExtractedCustomModels(tmpDir)).toEqual(['MyCustomModel']);
  });

  it('returns undefined when no manifest is present (distinct from an empty list)', () => {
    expect(readExtractedCustomModels(tmpDir)).toBeUndefined();

    writeExtractManifest(tmpDir, {
      generatedAt: new Date().toISOString(),
      extractMode: 'standard',
      environment: 'ude',
      customModels: [],
    });
    expect(readExtractedCustomModels(tmpDir)).toEqual([]);
  });

  it('writes the manifest as a dotfile so model scanners ignore it', () => {
    expect(EXTRACT_MANIFEST_FILENAME.startsWith('.')).toBe(true);
  });
});
