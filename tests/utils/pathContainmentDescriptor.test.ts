/**
 * The containment guard's one non-AOT write target: a model descriptor at
 * `<root>/<Package>/Descriptor/<Model>.xml`.
 *
 * Every other write target is `<Package>/<Model>/Ax<Type>/<Name>.xml`. A
 * descriptor is one segment shallower and has no Ax* folder, so admitting it
 * meant widening the single authoritative check on where this server may write
 * — and the point of these tests is that it widened for the descriptor shape
 * ONLY. A three-segment path that is not a descriptor, and a descriptor outside
 * an allowed root, must still be refused.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => 'C:/PLD',
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => 'C:/never',
}));

import { assertWritePathAllowed } from '../../src/utils/pathContainment.js';

/** What modifyD365File passes for objectType="model-descriptor", and only then. */
const DESCRIPTOR = { allowDescriptor: true };

describe('pathContainment — model descriptor', () => {
  it('allows a descriptor and reports its package and model', async () => {
    const r = await assertWritePathAllowed('C:/PLD/Contoso/Descriptor/Contoso.xml', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(true);
    expect(r.packageSegment).toBe('Contoso');
    // The model a descriptor describes is its own BASENAME, not a path segment —
    // which is what lets the model-hint cross-check apply to it at all.
    expect(r.modelSegment).toBe('Contoso');
  });

  it('allows an ISV model whose descriptor sits in a differently named package', async () => {
    const r = await assertWritePathAllowed('C:/PLD/IsvPackage/Descriptor/IsvModel.xml', 'IsvModel', DESCRIPTOR);
    expect(r.ok).toBe(true);
    expect(r.packageSegment).toBe('IsvPackage');
    expect(r.modelSegment).toBe('IsvModel');
  });

  it('enforces the model hint against the descriptor basename', async () => {
    // The agent-steered case: modelName says one model, filePath points at
    // another model's manifest.
    const r = await assertWritePathAllowed('C:/PLD/ApplicationSuite/Descriptor/ApplicationSuite.xml', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Model mismatch/i);
  });

  it('is case-insensitive about the Descriptor segment, as Windows is', async () => {
    const r = await assertWritePathAllowed('C:/PLD/Contoso/descriptor/Contoso.xml', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(true);
  });

  it('still refuses a descriptor outside every allowed root', async () => {
    const r = await assertWritePathAllowed('D:/elsewhere/Contoso/Descriptor/Contoso.xml', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/outside configured D365FO package roots/i);
  });

  it('does not admit any other three-segment path', async () => {
    // The widening is keyed on the literal 'Descriptor' segment; without that it
    // would have accepted every <Package>/<Anything>/<file>.xml under a root.
    const r = await assertWritePathAllowed('C:/PLD/Contoso/Resources/Contoso.xml', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/canonical AOT layout/i);
  });

  it('does not admit a non-.xml leaf in a Descriptor folder', async () => {
    const r = await assertWritePathAllowed('C:/PLD/Contoso/Descriptor/notes.txt', 'Contoso', DESCRIPTOR);
    expect(r.ok).toBe(false);
  });

  it('refuses traversal that collapses onto a descriptor-shaped tail', async () => {
    // The shape check reads the COLLAPSED path, so a `..` chain cannot dress an
    // escape up as a descriptor.
    const r = await assertWritePathAllowed(
      'C:/PLD/Contoso/Descriptor/Contoso.xml/../../../../evil/Pkg/Descriptor/Pkg.xml', 'Pkg', DESCRIPTOR);
    expect(r.ok).toBe(false);
  });

  it('refuses a descriptor path for any caller that did not opt in', async () => {
    // A "class" modify aimed at ApplicationSuite's manifest would reach the
    // writer without the descriptor's standard-model guard, which only the
    // model-descriptor branch runs.
    for (const opts of [undefined, {}, { allowDescriptor: false }]) {
      const r = await assertWritePathAllowed('C:/PLD/ApplicationSuite/Descriptor/Foundation.xml', undefined, opts);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/canonical AOT layout/i);
    }
  });
});
