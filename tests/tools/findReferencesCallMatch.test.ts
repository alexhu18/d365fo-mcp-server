/**
 * A call is recognised the way X++ writes it.
 *
 * X++ identifiers are case-insensitive and allow a space before the argument
 * list, so `this.validatewrite()` and `this.validateWrite ()` are calls of
 * validateWrite. FTS (case-insensitive) matched those rows, and the context
 * extractor, an exact `includes("validateWrite(")`, then dropped them: the
 * index-only path reported one reference where there were three. The same
 * exact match also took the tail of a longer name (`revalidateWrite(`) for a
 * call.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

function stubIndex(rows: Array<Record<string, unknown>>) {
  const db = {
    prepare: (sql: string) => ({
      all: (..._params: any[]) => {
        // The declaring-type recovery: no owners, so only the FTS path runs.
        if (/DISTINCT parent_name/.test(sql)) return [];
        if (/symbols_fts/.test(sql)) return rows;
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

const row = (name: string, line: string) => ({
  name,
  parent_name: 'MyTable',
  file_path: `K:/Packages/MyModel/AxTable/MyTable.xml`,
  model: 'MyModel',
  source_snippet: ['public boolean ' + name + '()', '{', `    ${line}`, '}'].join('\n'),
});

describe('find_references fallback: what counts as a call', () => {
  it('finds calls in any letter case and with a space before the parenthesis', async () => {
    const text = textOf(await call(
      { targetName: 'validateWrite', targetType: 'method', includeContext: true },
      stubIndex([
        row('callExact', 'return this.validateWrite();'),
        row('callLower', 'return this.validatewrite();'),
        row('callSpaced', 'return this.validateWrite ();'),
      ]),
    ));

    expect(text).toContain('MyTable.callExact');
    expect(text).toContain('MyTable.callLower');
    expect(text).toContain('MyTable.callSpaced');
  });

  it('does not take a longer name ending in the target for a call', async () => {
    const text = textOf(await call(
      { targetName: 'validateWrite', targetType: 'method', includeContext: true },
      stubIndex([row('callOther', 'return this.revalidateWrite();')]),
    ));

    expect(text).not.toContain('MyTable.callOther');
  });

  it('finds an instantiation written with different case or spacing', async () => {
    const text = textOf(await call(
      { targetName: 'MyController', targetType: 'class', includeContext: true },
      stubIndex([row('build', 'MyController c = new mycontroller ();')]),
    ));

    expect(text).toContain('new mycontroller ()');
    expect(text).toMatch(/instantiation/i);
  });
});

describe('find_references fallback: one call site, one reference', () => {
  it('does not list a call twice when the index and the declaring-type scan both find it', async () => {
    // Seen on the VM once case-insensitive calls were found: the scan of the
    // declaring type's file reported this.validatewrite() again, because it
    // cuts a ±1-line window where the index path cuts ±2, and the duplicate
    // check compared the two windows for equality.
    const dir = mkdtempSync(path.join(tmpdir(), 'fr-dedupe-'));
    try {
      const file = path.join(dir, 'MyTable.xml');
      const body = [
        'public boolean callLower()',
        '{',
        '    boolean ok;',
        '    ok = this.validatewrite();',
        '    return ok;',
        '}',
      ].join('\n');
      writeFileSync(file, body);
      const db = {
        prepare: (sql: string) => ({
          all: (..._params: any[]) => {
            if (/DISTINCT parent_name/.test(sql)) return [{ parent_name: 'MyTable', file_path: file }];
            if (/symbols_fts/.test(sql)) {
              return [{ name: 'callLower', parent_name: 'MyTable', file_path: file, model: 'MyModel', source_snippet: body, source: body }];
            }
            return [];
          },
          get: () => undefined,
        }),
      };
      const text = textOf(await call(
        { targetName: 'validateWrite', targetType: 'method', includeContext: true },
        { getReadDb: () => db, searchLabels: () => [] },
      ));
      expect(text).toMatch(/Total References Found:\*\* 1\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not list a call twice when it sits on the first line of the indexed body', async () => {
    // A one-line method: the call is on the body's first line, so the scan of
    // the file takes its leading context line from outside the body — text the
    // index's window cannot contain.
    const dir = mkdtempSync(path.join(tmpdir(), 'fr-dedupe-'));
    try {
      const file = path.join(dir, 'MyTable.xml');
      const body = 'public boolean callLower() { return this.validatewrite(); }';
      writeFileSync(file, ['<Source><![CDATA[', body, ']]></Source>'].join('\n'));
      const db = {
        prepare: (sql: string) => ({
          all: (..._params: any[]) => {
            if (/DISTINCT parent_name/.test(sql)) return [{ parent_name: 'MyTable', file_path: file }];
            if (/symbols_fts/.test(sql)) {
              return [{ name: 'callLower', parent_name: 'MyTable', file_path: file, model: 'MyModel', source_snippet: body, source: body }];
            }
            return [];
          },
          get: () => undefined,
        }),
      };
      const text = textOf(await call(
        { targetName: 'validateWrite', targetType: 'method', includeContext: true },
        { getReadDb: () => db, searchLabels: () => [] },
      ));
      expect(text).toMatch(/Total References Found:\*\* 1\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
