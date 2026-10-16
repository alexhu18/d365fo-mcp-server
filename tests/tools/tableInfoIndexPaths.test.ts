/**
 * tableInfoTool's bridge-less index fallback against REAL directories (PR #1071).
 *
 * The reader shares the stale-row rule with every other index reader; these pin
 * the two outcomes that matter for tables: a CI-built row for a table installed
 * here is served, and a row for a table whose whole package was deleted here is
 * not (ghost fields are what the original guard, ed47089c, existed to stop).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tableinfo-paths-')));
const PLD = path.join(TMP, 'PackagesLocalDirectory');

vi.mock('../../src/utils/configManager', async (orig) => ({
  ...(await orig<any>()),
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => PLD,
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => '',
}));
vi.mock('../../src/bridge/bridgeAdapter', () => ({ tryBridgeTable: vi.fn(async () => null) }));
vi.mock('../../src/utils/objectFileLookup', () => ({ findD365FileOnDisk: vi.fn(async () => null) }));

import { tableInfoTool } from '../../src/tools/readers/tableInfo';

const req = (tableName: string): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: { tableName } },
});

function ctxFor(row: { name: string; filePath: string; model: string }) {
  return {
    symbolIndex: {
      getSymbolByName: vi.fn((name: string, type: string) => (type === 'table' && name === row.name ? row : null)),
      getReadDb: vi.fn(() => ({
        prepare: vi.fn((sql: string) => ({
          all: vi.fn(() => (sql.includes("'field'") ? [{ name: 'AccountNum', signature: 'CustAccount' }] : [])),
          get: vi.fn(() => undefined),
        })),
      })),
    },
    parser: { parseTableFile: vi.fn(async () => ({ success: false })) },
  } as any;
}

beforeAll(() => {
  const f = path.join(PLD, 'ApplicationSuite', 'Foundation', 'AxTable', 'CustTable.xml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '<AxTable/>');
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('tableInfoTool — index rows against real paths', () => {
  it('serves a CI-built row through its local remap', async () => {
    const result = await tableInfoTool(req('CustTable'), ctxFor({
      name: 'CustTable', model: 'Foundation',
      filePath: '/home/vsts/work/1/PackagesLocalDirectory/ApplicationSuite/Foundation/AxTable/CustTable.xml',
    }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('**AccountNum**: CustAccount');
  });

  it('does not serve ghost fields for a table whose package was deleted here', async () => {
    const result = await tableInfoTool(req('GhostTable'), ctxFor({
      name: 'GhostTable', model: 'Gone',
      filePath: path.join(PLD, 'GonePkg', 'GonePkg', 'AxTable', 'GhostTable.xml'),
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('AccountNum');
  });
});
