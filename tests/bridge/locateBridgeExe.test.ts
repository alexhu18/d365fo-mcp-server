/**
 * locateBridgeExe — the bridge binary the server would start, found without
 * starting it (the trace analysis needs only the binary).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeExeCandidates, locateBridgeExe } from '../../src/bridge/bridgeClient.js';

afterEach(() => vi.unstubAllEnvs());

describe('locateBridgeExe', () => {
  it('returns the configured path when it exists, and never second-guesses one that does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-exe-'));
    try {
      const exe = path.join(dir, 'D365MetadataBridge.exe');
      fs.writeFileSync(exe, '');
      vi.stubEnv('D365FO_BRIDGE_EXE_PATH', exe);
      expect(locateBridgeExe()).toBe(exe);
      vi.stubEnv('D365FO_BRIDGE_EXE_PATH', path.join(dir, 'missing.exe'));
      expect(locateBridgeExe()).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('otherwise takes the first built candidate, the same search the server uses', () => {
    vi.stubEnv('D365FO_BRIDGE_EXE_PATH', '');
    expect(bridgeExeCandidates()[0]).toMatch(/bridge[\\/]D365MetadataBridge[\\/]bin[\\/]Release[\\/]D365MetadataBridge\.exe$/);
    expect(locateBridgeExe()).toBe(bridgeExeCandidates().find(c => fs.existsSync(c)));
  });
});
