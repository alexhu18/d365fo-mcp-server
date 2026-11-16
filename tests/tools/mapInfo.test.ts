/**
 * getMapInfoTool — full map rendering.
 *
 * Maps used to render a stub: name/model/extends plus "Mapped tables (0)",
 * because methods and fields were never extracted and mappings were looked for
 * only on the map's side (most bindings are declared by the tables). These
 * tests pin the full render: declaration, fields, method signatures and the
 * mapped-tables table, plus the index-only fallback when the XML is gone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';

const MAP_PATH = 'C:\\AosService\\PackagesLocalDirectory\\Test\\Test\\AxMap\\TestMap.xml';

const MAP_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<AxMap xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
  '<Name>TestMap</Name>' +
  '<SourceCode>' +
  '<Declaration><![CDATA[\npublic class TestMap extends common\n{\n}\n]]></Declaration>' +
  '<Methods>' +
  '<Method><Name>find</Name><Source><![CDATA[public static TestMap find(RecId _recId)\n{\n}\n]]></Source></Method>' +
  '<Method><Name>calcAmount</Name><Source><![CDATA[public void calcAmount()\n{\n}\n]]></Source></Method>' +
  '</Methods>' +
  '</SourceCode>' +
  '<Fields>' +
  '<AxMapBaseField xmlns="" i:type="AxMapFieldString"><Name>InvoiceId</Name></AxMapBaseField>' +
  '<AxMapBaseField xmlns="" i:type="AxMapFieldReal"><Name>AmountCur</Name><ExtendedDataType>AmountCur</ExtendedDataType></AxMapBaseField>' +
  '<AxMapBaseField xmlns="" i:type="AxMapFieldEnum"><Name>DiscrepancyRSL</Name><EnumType>NoYes</EnumType></AxMapBaseField>' +
  '</Fields>' +
  '</AxMap>';

// xmlParser reads files via 'fs/promises' — mock THAT module's readFile.
vi.mock('fs/promises', async (orig) => {
  const actual = await orig<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (p: any) => {
      if (String(p) === MAP_PATH) return MAP_XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
  };
});

import { getMapInfoTool } from '../../src/tools/readers/mapInfo';

// The reader probes the indexed path (fs.access) and re-resolves through
// findD365FileOnDisk when unreadable. Both point at the mock file above.
vi.mock('../../src/utils/objectFileLookup', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/objectFileLookup')>();
  return {
    ...actual,
    findD365FileOnDisk: vi.fn(async () => MAP_PATH),
  };
});

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_map_info', arguments: args },
});

const makeStmt = (rows: any[] = []) => ({
  all: vi.fn(() => rows),
  get: vi.fn(() => undefined),
  run: vi.fn(() => ({ changes: 0 })),
});

/** Index that knows the map, its mapped tables and (optionally) its method rows. */
function indexWithMethodRows(methodRows: any[] = []) {
  const prepare = vi.fn((sql: string) => {
    if (/FROM map_mappings/.test(sql)) {
      return makeStmt([
        { mapping_table: 'CustInvoiceJour', field_connections: 5 },
        { mapping_table: 'VendInvoiceJour', field_connections: 5 },
      ]);
    }
    if (/type = 'method' AND parent_name/.test(sql)) return makeStmt(methodRows);
    return makeStmt();
  });
  return {
    getReadDb: vi.fn(() => ({ prepare })),
  } as any;
}

/** lookupSymbolNocase is served by the real symbolLookup against this db shape. */
vi.mock('../../src/utils/symbolLookup', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/symbolLookup')>();
  return {
    ...actual,
    lookupSymbolNocase: vi.fn(() => ({
      name: 'TestMap',
      type: 'map',
      model: 'TestModel',
      extends_class: 'common',
      file_path: MAP_PATH,
    })),
  };
});

const buildContext = (symbolIndex: any): XppServerContext => ({
  symbolIndex,
  parser: {
    parseMapFile: vi.fn(async (p: string) => {
      const { XppMetadataParser } = await import('../../src/metadata/xmlParser');
      return new XppMetadataParser().parseMapFile(p);
    }),
  } as any,
} as any);

describe('getMapInfoTool — full map render', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders declaration, fields, method signatures and mapped tables', async () => {
    const result = await getMapInfoTool(
      req({ mapName: 'TestMap' }),
      buildContext(indexWithMethodRows()),
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;

    expect(text).toContain('# AxMap: `TestMap`');
    expect(text).toContain('**Model:** TestModel');
    expect(text).toContain('## Declaration');
    expect(text).toContain('public class TestMap extends common');

    expect(text).toContain('## Fields (3)');
    expect(text).toContain('| `InvoiceId` | String | `—` |');
    expect(text).toContain('| `AmountCur` | Real | `AmountCur` |');
    expect(text).toContain('| `DiscrepancyRSL` | Enum | `NoYes` |');

    expect(text).toContain('## Methods (2)');
    expect(text).toContain('TestMap find(');
    expect(text).toContain('void calcAmount()');

    expect(text).toContain('## Mapped tables (2)');
    expect(text).toContain('| `CustInvoiceJour` | 5 |');
    expect(text).toContain('| `VendInvoiceJour` | 5 |');
  });

  it('falls back to indexed method names when the XML is unreachable', async () => {
    const ctx = buildContext(indexWithMethodRows([
      { name: 'find', signature: 'TestMap find(RecId _recId)' },
      { name: 'calcAmount', signature: 'void calcAmount()' },
    ]));
    // Parser fails (file gone) — the index must still serve the method list.
    (ctx.parser as any).parseMapFile = vi.fn(async () => ({ success: false, error: 'ENOENT' }));

    const result = await getMapInfoTool(req({ mapName: 'TestMap' }), ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('## Methods (2)');
    expect(text).toContain('TestMap find(RecId _recId)');
    expect(text).toContain('symbol index');
    // Header data and mapped tables survive the XML outage.
    expect(text).toContain('## Mapped tables (2)');
  });
});
