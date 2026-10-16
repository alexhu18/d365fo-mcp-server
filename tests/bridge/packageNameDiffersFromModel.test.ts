/**
 * Regression test — #1086: a model whose package carries a different name.
 *
 * PackagesLocalDirectory is laid out {Package}/{Model}/Ax{Type}/{Name}.xml, and the two
 * names need not match (package "Enhancements" holding model "Sales Integration").
 * GetExpectedPath built {Model}/{Model}/…, so for such a model every bridge create
 * reported a path that does not exist. The SDK's Create() had put the file in the right
 * place, but the TS side trusts the reported path for its on-disk check, the .rnrproj
 * entry and the index upsert — so a successful create was answered with
 * "the file is NOT on disk after a reported success — treat this write as failed".
 *
 * The on-disk fallback of GetModelSaveInfoForObject made the same assumption
 * ({pkg}/{pkg}/Ax…), so an existing object in such a model could not be resolved there.
 *
 * Source greps, because the behaviour lives in the C# bridge the TS suite does not start
 * (see csharpSource.ts). The behaviour itself was probed against a fake package layout:
 * "Sales Integration" → Enhancements\Sales Integration\AxClass\NewClass.xml.
 */

import { describe, it, expect } from 'vitest';
import { WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

const source = readStripped(WRITE_SERVICE_CS);

describe('#1086 — package name differs from model name', () => {
  it('GetExpectedPath names the package the model lives in, not the model twice', () => {
    const body = methodBody(source, 'private string GetExpectedPath(');
    expect(body).toContain('ResolvePackageName(modelName), modelName, aotFolder');
    expect(body).not.toMatch(/_packagesPath,\s*modelName,\s*modelName/);
  });

  it('ResolvePackageName finds the package by the descriptor that declares the model', () => {
    const body = methodBody(source, 'private string ResolvePackageName(');
    // The descriptor's <Name> decides, not the folder name.
    expect(body).toContain('DescriptorDeclaresModel(');
    expect(body).toContain('Path.GetFileName(packageDir)');
    // A miss falls back to the historical {Model}/{Model} layout and is NOT cached,
    // so a model deployed after the first lookup still resolves.
    expect(body).toMatch(/if \(found == null\) return modelName;\s*_packageNameCache\[modelName\] = found;/);
  });

  it('the package cache is cleared with the other provider-derived caches', () => {
    const body = methodBody(source, 'public void UpdateProvider(');
    expect(body).toContain('_packageNameCache.Clear()');
  });

  it('the on-disk object fallback walks model folders instead of assuming {pkg}/{pkg}', () => {
    const body = methodBody(source, 'private ModelSaveInfo ResolveModelSaveInfoForObjectUncached<T>(');
    expect(body).not.toMatch(/Path\.Combine\(packageDir,\s*packageName,/);
    expect(body).toContain('Directory.GetDirectories(packageDir)');
    expect(body).toContain('Path.Combine(modelDir, aotFolder, objectName + ".xml")');
    expect(body).toContain('ResolveModelSaveInfo(modelName)');
  });
});
