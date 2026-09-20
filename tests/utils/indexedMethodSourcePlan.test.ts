/**
 * What SQLite actually does with the indexed-body queries.
 *
 * The sibling suite asserts the SQL TEXT, which can only catch a shape someone
 * typed — it cannot catch the shape being planned differently than the comment
 * beside it claims. This one asks the planner, against the real schema.
 *
 * Measured on the 2.5 GB production index, both queries plan as
 * `SEARCH symbols USING INDEX idx_type_parent (type=? AND parent_name=?)` — not
 * the `idx_parent_type_name` this code used to claim. That index carries `name`
 * as a third column, but it is BINARY, so a `COLLATE NOCASE` comparison cannot
 * seek on it; either index serves the (type, parent) equality and the name is
 * filtered afterwards. The property worth pinning is not WHICH index wins, but
 * that one does: the NOCASE compare must stay bounded by a single owner's
 * methods (222 on CustTable, 621 on SalesTable) instead of walking all 639k
 * method rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { readIndexedMethodSource, readIndexedMethodSources } from '../../src/utils/indexedMethodSource';

let index: any;

const planOf = (sql: string, ...params: unknown[]): string =>
  index.getReadDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r: any) => r.detail)
    .join(' | ');

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.addSymbol({ name: 'CustTable', type: 'table', filePath: 'K:/x/CustTable.xml', model: 'Foundation' });
  for (const [name, source] of [
    ['find', 'static CustTable find(CustAccount _a)\n{\n}'],
    ['initValue', 'public void initValue()\n{\n}'],
    ['validateWrite', 'public boolean validateWrite()\n{\n}'],
  ] as const) {
    index.addSymbol({
      name, type: 'method', parentName: 'CustTable', source,
      filePath: 'K:/x/CustTable.xml', model: 'Foundation',
    });
  }
});

afterEach(() => { index.close?.(); });

describe('the indexed-body queries against the real schema', () => {
  it('seeks an index for one method rather than scanning the table', () => {
    const plan = planOf(
      `SELECT name, source, signature, model FROM symbols
       WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE LIMIT 1`,
      'CustTable', 'find',
    );

    expect(plan).toMatch(/SEARCH symbols USING (COVERING )?INDEX/);
    expect(plan).not.toMatch(/SCAN symbols/);
  });

  it('seeks an index for a page of methods too', () => {
    const plan = planOf(
      `SELECT name, source, signature, model FROM symbols
       WHERE parent_name = ? AND type = 'method' AND name IN (?, ?)`,
      'CustTable', 'find', 'initValue',
    );

    expect(plan).toMatch(/SEARCH symbols USING (COVERING )?INDEX/);
    expect(plan).not.toMatch(/SCAN symbols/);
  });

  it('loses the owner constraint entirely if the parent is compared case-insensitively', () => {
    const plan = planOf(
      `SELECT name FROM symbols WHERE parent_name = ? COLLATE NOCASE AND type = 'method'`,
      'custtable',
    );

    // Still the word SEARCH — but on `type` alone (`idx_type_name (type=?)`),
    // which is every method row in the index, 639k of them on the production
    // database. The plan keyword is not the signal; the absence of the owner
    // from the seek is. This is what callers canonicalizing the owner name
    // buy, and why `readIndexedMethodSource` compares `parent_name` binary.
    expect(plan).not.toContain('parent_name=?');
    expect(planOf(
      `SELECT name FROM symbols WHERE parent_name = ? AND type = 'method'`, 'CustTable',
    )).toContain('parent_name=?');
  });
});

describe('the helpers against a real database', () => {
  it('matches the method name case-insensitively and returns the AOT spelling', () => {
    const hit = readIndexedMethodSource(index.getReadDb(), 'CustTable', 'VALIDATEWRITE');

    expect(hit?.name).toBe('validateWrite');
    expect(hit?.source).toContain('boolean validateWrite()');
  });

  it('returns nothing for an owner spelled differently, as the plan requires', () => {
    expect(readIndexedMethodSource(index.getReadDb(), 'custtable', 'find')).toBeNull();
  });

  it('fetches exactly the named page and nothing else', () => {
    const map = readIndexedMethodSources(index.getReadDb(), 'CustTable', ['find', 'initValue']);

    expect([...map.keys()].sort()).toEqual(['find', 'initvalue']);
  });

  it('fetches the owner\'s whole set when no page is named', () => {
    expect(readIndexedMethodSources(index.getReadDb(), 'CustTable').size).toBe(3);
  });
});
