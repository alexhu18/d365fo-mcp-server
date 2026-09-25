/**
 * Match on the preview, render from the whole body.
 *
 * FTS indexes `source_snippet` — a method's first ten lines — so what
 * find_references can FIND is bounded by that preview, and this branch does not
 * change it. What it changes is what happens to a row FTS has already matched:
 * the context extractors used to be handed the same ten lines, so a caller that
 * mentions the name early (a declaration, a comment, a first call) but makes the
 * call being reported further down produced no context and was dropped at the
 * rendering step — a correct match, discarded.
 *
 * Measured against the production index, this recovers single digits per query
 * (`validateWrite` 130 → 138 rendered of 150 matched rows, `initFromCustTable`
 * 65 → 67), which is why the rows below are shaped like the real ones rather
 * than exaggerated.
 *
 * The rows the existing find_references suites stub carry `source_snippet`
 * only, so `bodyOf` always took its fallback branch there and none of this was
 * covered.
 */

import { describe, it, expect } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

/** Ten lines of preview that mention the name, then the call, far below. */
const PREVIEW = [
  'public void postJournal(LedgerJournalTable _journal)',
  '{',
  '    // initFromCustTable is applied once the header is validated',
  '    LedgerJournalTrans trans;',
  '    CustTable cust;',
  '    ;',
  '    if (!_journal)',
  '    {',
  '        return;',
  '    }',
].join('\n');

const FULL_BODY = [
  PREVIEW,
  '    cust = CustTable::find(_journal.AccountNum);',
  '    trans.initFromCustTable(cust);',
  '    trans.insert();',
  '}',
].join('\n');

function stubIndex(row: Record<string, unknown> | null) {
  const db = {
    prepare: (sql: string) => ({
      all: (..._params: any[]) => {
        // The declaring-type recovery: no owners, so only the FTS path runs.
        if (/DISTINCT parent_name/.test(sql)) return [];
        if (/symbols_fts/.test(sql)) return row ? [row] : [];
        return [];
      },
      get: () => undefined,
    }),
  };
  return { getReadDb: () => db, searchLabels: () => [] } as any;
}

const call = (args: Record<string, unknown>, index: any) =>
  findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: index, bridge: undefined } as any,
  );

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

const ROW = {
  name: 'postJournal',
  parent_name: 'LedgerJournalCheckPost',
  file_path: 'K:/Packages/LedgerJournalCheckPost.xml',
  model: 'Foundation',
  source_snippet: PREVIEW,
};

describe('find_references rendering from the indexed body', () => {
  it('reports a call that sits below the ten lines FTS matched on', async () => {
    const text = textOf(await call(
      { targetName: 'initFromCustTable', targetType: 'method', includeContext: true },
      stubIndex({ ...ROW, source: FULL_BODY }),
    ));

    expect(text).toContain('trans.initFromCustTable(cust);');
    expect(text).toContain('LedgerJournalCheckPost.postJournal');
    expect(text).not.toMatch(/Total References Found:\*\* 0/);
  });

  it('drops the same row when only the preview is available — the behaviour before this fallback', async () => {
    const text = textOf(await call(
      { targetName: 'initFromCustTable', targetType: 'method', includeContext: true },
      stubIndex({ ...ROW, source: null }),
    ));

    // The preview mentions the name in a comment but makes no call, so there is
    // no context to render and the row yields nothing. Pinned so the fallback to
    // `source_snippet` is understood to be a degradation, not an equivalent.
    expect(text).not.toContain('trans.initFromCustTable(cust);');
    expect(text).toMatch(/not evidence/i);
  });

  it('falls back to the preview for a row indexed before the source column existed', async () => {
    const callInPreview = PREVIEW.replace(
      '    LedgerJournalTrans trans;',
      '    trans.initFromCustTable(cust);',
    );

    const text = textOf(await call(
      { targetName: 'initFromCustTable', targetType: 'method', includeContext: true },
      stubIndex({ ...ROW, source_snippet: callInPreview, source: null }),
    ));

    expect(text).toContain('trans.initFromCustTable(cust);');
  });

  it('does not change which rows FTS can find — the preview is still what it matches', async () => {
    // A body whose preview never mentions the name is not returned by the FTS
    // query at all, so a full body cannot rescue it. This is the limitation the
    // branch documents rather than fixes.
    const text = textOf(await call(
      { targetName: 'initFromCustTable', targetType: 'method' },
      stubIndex(null),
    ));

    expect(text).toMatch(/FIRST TEN LINES/i);
    expect(text).not.toMatch(/might be unused/i);
  });
});
