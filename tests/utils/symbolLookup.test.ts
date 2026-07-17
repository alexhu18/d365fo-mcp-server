/**
 * symbolLookup — index-safe case-insensitive lookups against a REAL in-memory
 * symbol index (production schema incl. symbols_fts). Locks the exact-probe +
 * FTS-fallback shape extracted from prepare (d93f004): the former
 * `name = ? COLLATE NOCASE` queries full-scanned the 1.17M-row symbols table
 * (13–180 s cold) and got the MCP server killed by clients.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  lookupSymbolNocase,
  lookupSymbolsNocase,
  canonicalSymbolName,
  distinctSymbolTypesNocase,
} from '../../src/utils/symbolLookup';

let index: XppSymbolIndex;
let db: any;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type: string, parentName?: string) =>
    index.addSymbol({ name, type, parentName, filePath: '/x.xml', model: 'Test' } as any);

  sym('CustTable', 'table');
  sym('CustTable', 'form');            // cross-type name collision (real in AOT)
  sym('AccountNum', 'field', 'CustTable');
  sym('validateWrite', 'method', 'CustTable');
  sym('SalesStatus', 'enum');
  sym('CustAccount', 'edt');
  db = index.getReadDb();
});

afterAll(() => index.close());

describe('lookupSymbolNocase', () => {
  it('finds an exact-case top-level object (index probe, no FTS)', () => {
    const hit = lookupSymbolNocase(db, 'CustTable', ['table']);
    expect(hit).toMatchObject({ name: 'CustTable', type: 'table', model: 'Test' });
  });

  it('resolves canonical casing for differently-cased input (FTS fallback)', () => {
    expect(lookupSymbolNocase(db, 'custtable', ['table'])?.name).toBe('CustTable');
    expect(lookupSymbolNocase(db, 'CUSTTABLE', ['table'])?.name).toBe('CustTable');
    expect(lookupSymbolNocase(db, 'salesstatus', ['enum', 'enum-extension'])?.name).toBe('SalesStatus');
  });

  it('respects the type filter', () => {
    expect(lookupSymbolNocase(db, 'custtable', ['enum'])).toBeUndefined();
    expect(lookupSymbolNocase(db, 'custaccount', ['edt'])?.name).toBe('CustAccount');
  });

  it('does not match non-top-level symbols (fields, methods)', () => {
    expect(lookupSymbolNocase(db, 'accountnum')).toBeUndefined();
    expect(lookupSymbolNocase(db, 'validatewrite')).toBeUndefined();
  });

  it('returns undefined for unknown names', () => {
    expect(lookupSymbolNocase(db, 'NoSuchObject123')).toBeUndefined();
    expect(lookupSymbolNocase(db, '')).toBeUndefined();
  });
});

describe('lookupSymbolsNocase', () => {
  it('returns all top-level rows for a name across types, deduplicated', () => {
    const rows = lookupSymbolsNocase(db, 'custtable', { limit: 5 });
    expect(rows.map(r => r.type).sort()).toEqual(['form', 'table']);
  });
});

describe('canonicalSymbolName', () => {
  it('canonicalizes casing so parent_name probes can stay BINARY', () => {
    expect(canonicalSymbolName(db, 'cUsTtAbLe')).toBe('CustTable');
    expect(canonicalSymbolName(db, 'Missing')).toBeUndefined();
  });
});

describe('distinctSymbolTypesNocase', () => {
  it('includes child-symbol types (methods, fields), any casing', () => {
    expect(distinctSymbolTypesNocase(db, 'validatewrite')).toEqual(['method']);
    expect(distinctSymbolTypesNocase(db, 'AccountNum')).toEqual(['field']);
  });

  it('unions types across casings of a top-level name', () => {
    expect(distinctSymbolTypesNocase(db, 'CUSTTABLE').sort()).toEqual(['form', 'table']);
  });

  it('returns [] for unknown names', () => {
    expect(distinctSymbolTypesNocase(db, 'NoSuchObject123')).toEqual([]);
  });
});
