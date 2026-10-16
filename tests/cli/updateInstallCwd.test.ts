/**
 * Where an npm-mode `update` runs `npm install -g`.
 *
 * npm replaces the global package by renaming its directory aside first, and
 * Windows refuses to rename a directory some process has as its working
 * directory. The update used to spawn npm with cwd = the package root, so
 * npm's own shell held the lock that made the rename fail with EBUSY.
 */
import { describe, it, expect } from 'vitest';
import { relative, isAbsolute } from 'node:path';
import { repoRoot } from '../../src/cli/context.js';
import { globalInstallCwd } from '../../src/cli/commands/update.js';

describe('globalInstallCwd', () => {
  it('is not inside the package npm is about to replace', () => {
    const rel = relative(repoRoot, globalInstallCwd());
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    expect(inside).toBe(false);
  });
});
