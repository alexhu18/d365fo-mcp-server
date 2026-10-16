/**
 * The stale-row rule on a POSIX host (the hosted Linux server) reading an index
 * built on Windows. `path.posix.dirname('C:\\…\\CustTable.xml')` is '.', which
 * always exists — so a dirname-based "is the object's folder here?" test called
 * every Windows-recorded row a deletion, and CustTable "not found" on Linux.
 *
 * `path` is swapped for path.posix to run the host-sensitive code as Linux would.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('path', async () => {
  const p: any = await vi.importActual('path');
  return { ...p.posix, default: p.posix };
});

vi.mock('../../src/utils/configManager', async (orig) => ({
  ...(await orig<any>()),
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => '/nonexistent/PackagesLocalDirectory',
  }),
  fallbackPackagePath: () => '',
}));

import { indexedPathIsMissing } from '../../src/utils/indexedXmlLookup';

describe('POSIX host, Windows-built index', () => {
  it('does not flag a drive-letter CI path', async () => {
    expect(await indexedPathIsMissing(
      'C:\\home\\vsts\\work\\1\\PackagesLocalDirectory\\ApplicationSuite\\Foundation\\AxTable\\CustTable.xml',
    )).toBe(false);
  });

  it('does not flag a bare file name', async () => {
    expect(await indexedPathIsMissing('CustTable.xml')).toBe(false);
  });
});
