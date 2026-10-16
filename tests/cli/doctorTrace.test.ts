/**
 * `doctor` with tracing on: says where captures go, and warns before a capture
 * would be refused for lack of space.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { checkTrace } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';

describe.runIf(process.platform === 'win32')('doctor — trace', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'doctor-trace-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is quiet while tracing is off', () => {
    expect(checkTrace(openStore(tmp, null), 'Root')).toBeNull();
  });

  it('warns when the trace folder lacks space for a capture', () => {
    const store = openStore(tmp, null);
    writeSetting(store, settingByPath('trace.enabled')!, true);
    writeSetting(store, settingByPath('trace.outputDir')!, 'K:/Traces');
    const low = checkTrace(store, 'Root', () => 0.2 * 2 ** 30);
    expect(low?.severity).toBe('warn');
    expect(low?.message).toContain('0.2 GB free');
    expect(low?.fix).toContain('config trace');
    expect(checkTrace(store, 'Root', () => 200 * 2 ** 30)?.severity).toBe('ok');
  });

  it("asks for as much room as start does at the configured limits", () => {
    const store = openStore(tmp, null);
    writeSetting(store, settingByPath('trace.enabled')!, true);
    writeSetting(store, settingByPath('trace.outputDir')!, 'K:/Traces');
    // Defaults (120 s, 4096 MB): start needs 4096 + 1024 MB, so 4.5 GB is not enough.
    expect(checkTrace(store, 'Root', () => 4.5 * 2 ** 30)?.message).toContain('needs about 5 GB');
    writeSetting(store, settingByPath('trace.maxSizeMB')!, 1000);
    expect(checkTrace(store, 'Root', () => 4.5 * 2 ** 30)?.severity).toBe('ok');
  });
});
