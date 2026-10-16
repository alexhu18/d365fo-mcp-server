/**
 * `d365fo-mcp doctor` — a SQL server configured while SQL stays off.
 *
 * axdb_sql is published only when sql.enabled is true and a server is set. The
 * wizard writes both, but a hand-edited config can carry the server alone, and
 * then the tool is silently absent.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSqlSwitch } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { toEnvRecord } from '../../src/config/configFile.js';
import { isAxDbConfigured } from '../../src/config/axdbSql.js';

describe('doctor — SQL switch', () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'doctor-sql-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const store = (enabled?: unknown, server?: string) => {
    const s = openStore(fs.mkdtempSync(join(tmp, 's-')), null);
    if (server !== undefined) writeSetting(s, settingByPath('sql.server')!, server);
    if (enabled !== undefined) writeSetting(s, settingByPath('sql.enabled')!, enabled);
    return s;
  };

  it('warns when a server is configured but SQL is not enabled', () => {
    for (const s of [store(undefined, '.'), store(false, 'SQLHOST')]) {
      const result = checkSqlSwitch(s, 'Root', {});
      expect(result?.severity).toBe('warn');
      expect(result?.message).toContain('axdb_sql is not published');
      expect(result?.fix).toContain('config sql');
    }
  });

  it('is quiet when SQL is enabled, or when no server is set', () => {
    expect(checkSqlSwitch(store(), 'Root', {})).toBeNull();
    expect(checkSqlSwitch(store(false), 'Root', {})).toBeNull();
    expect(checkSqlSwitch(store(undefined, '   '), 'Root', {})).toBeNull();
    expect(checkSqlSwitch(store(true, '.'), 'Root', {})).toBeNull();
    // A quoted value in the config file reads as the server projects it (serializeValue).
    expect(checkSqlSwitch(store('true', '.'), 'Root', {})).toBeNull();
  });

  // A hand-edited `"enabled": "false"` used to be truthy at runtime: SQL switched ON
  // while doctor (reading the text) said it was off. Both sides now read it as false.
  it('reads a quoted boolean in the config file the same way the server does', () => {
    for (const [enabled, published] of [['false', false], ['no', false], ['off', false], ['0', false], [0, false], ['TRUE', true], ['yes', true]] as const) {
      const s = store(enabled, 'localhost');
      const env = toEnvRecord({ baseDir: s.baseDir, config: s.config, secrets: s.secrets });
      expect(isAxDbConfigured(env), `runtime, enabled=${JSON.stringify(enabled)}`).toBe(published);
      expect(checkSqlSwitch(s, 'Root', {}) === null, `doctor, enabled=${JSON.stringify(enabled)}`).toBe(published);
    }
  });

  it('lets the real environment outrank the config file, as the server does', () => {
    // Server in the file, the switch in the environment: published.
    expect(checkSqlSwitch(store(undefined, 'SQLHOST'), 'Root', { D365FO_SQL_ENABLED: 'true' })).toBeNull();
    // The file says on, the environment says off: not published, and the fix names the environment.
    const off = checkSqlSwitch(store(true, 'SQLHOST'), 'Root', { D365FO_SQL_ENABLED: 'false' });
    expect(off?.message).toContain('sql.enabled (environment)');
    expect(off?.fix).toContain('D365FO_SQL_ENABLED');
    // A server defined (even empty) in the environment replaces the file's.
    expect(checkSqlSwitch(store(false, 'SQLHOST'), 'Root', { D365FO_SQL_SERVER: '' })).toBeNull();
    expect(checkSqlSwitch(store(false), 'Root', { D365FO_SQL_SERVER: 'ENVHOST' })?.message).toContain('ENVHOST');
  });
});
