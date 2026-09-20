/**
 * The declaring-type scan when the owner's FILE cannot be read.
 *
 * `scanDeclaringTypeSource` recovers intra-type calls by reading the owner's
 * source off disk — a Windows-VM path, so on an Azure read-only deployment the
 * read can never succeed and the recovery returned nothing at all. It now falls
 * back to the bodies held in the index.
 *
 * Two separate reasons a read produces no text, pinned apart here:
 *  • cannot be read (no such file — the Azure case) → use the index
 *  • deliberately not read (not a file, or past the 8 MB ceiling) → skip the
 *    owner, because spending that cost against the index instead is exactly
 *    what the guard exists to refuse.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

let dir: string;
let dirAsOwnerPath: string;

/** The owner's methods as the indexer stores them — full bodies, not previews. */
const BODIES = [
  {
    name: 'displayForm',
    source: [
      'public container displayForm(container _con, str _buttonClicked)',
      '{',
      ...Array.from({ length: 12 }, (_, i) => `    // line ${i + 1} of padding`),
      '    ret = this.buildAdjustIn(_con);',
      '    return ret;',
      '}',
    ].join('\n'),
  },
  { name: 'buildAdjustIn', source: 'protected container buildAdjustIn(container _con)\n{\n}\n' },
];

/**
 * Index stub. Records whether the indexed-body query was issued, so "the guard
 * skipped this owner" can be told from "the owner produced no hits".
 */
function stubIndex(ownerFilePath: string, opts: { bodies?: typeof BODIES } = {}) {
  const bodyQueries: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      all: (...params: any[]) => {
        if (/DISTINCT parent_name/.test(sql)) {
          return params[0] === 'buildAdjustIn'
            ? [{ parent_name: 'WHSWorkExecuteDisplayAdjustIn', file_path: ownerFilePath }]
            : [];
        }
        if (/type = 'method'/.test(sql) && /parent_name = \?/.test(sql)) {
          bodyQueries.push(sql);
          return (opts.bodies ?? BODIES).map(b => ({ ...b, signature: null, model: 'Foundation' }));
        }
        return []; // FTS: previews only, nothing matches the deep call site
      },
      get: () => undefined,
    }),
  };
  return { index: { getReadDb: () => db, searchLabels: () => [] } as any, bodyQueries };
}

const call = (args: Record<string, unknown>, index: any) =>
  findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: index, bridge: undefined } as any,
  );

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'findrefs-idx-'));
  dirAsOwnerPath = path.join(dir, 'NotAFile');
  await fsp.mkdir(dirAsOwnerPath);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('scanDeclaringTypeSource with no readable metadata file', () => {
  it('recovers the call from indexed bodies when the file does not exist (Azure)', async () => {
    const { index, bodyQueries } = stubIndex(path.join(dir, 'K_drive', 'Absent.xml'));

    const text = textOf(await call(
      { targetName: 'buildAdjustIn', targetType: 'method', includeContext: true }, index,
    ));

    expect(bodyQueries.length).toBeGreaterThan(0);
    expect(text).toContain('this.buildAdjustIn(');
    expect(text).not.toMatch(/Total References Found:\*\* 0/);
  });

  it('skips the owner when the read was refused by the guard, rather than paying the same cost against the index', async () => {
    const { index, bodyQueries } = stubIndex(dirAsOwnerPath);

    const text = textOf(await call(
      { targetName: 'buildAdjustIn', targetType: 'method', includeContext: true }, index,
    ));

    expect(bodyQueries).toHaveLength(0);
    expect(text).not.toContain('this.buildAdjustIn(');
  });

  it('never splices two bodies into one context — the rows come back in no order', async () => {
    // The call sits on the FIRST line of its body. Concatenated, the context
    // line above it was the closing brace of whichever unrelated method the
    // query happened to return first, shown as if it were contiguous source.
    const { index } = stubIndex(path.join(dir, 'Absent.xml'), {
      bodies: [
        { name: 'unrelated', source: ['void unrelated()', '{', '    doSomethingElse();', '}'].join('\n') },
        { name: 'displayForm', source: ['    ret = this.buildAdjustIn(_con);', '    return ret;'].join('\n') },
      ],
    });

    const text = textOf(await call(
      { targetName: 'buildAdjustIn', targetType: 'method', includeContext: true }, index,
    ));

    expect(text).toContain('this.buildAdjustIn(');
    // Nothing from the neighbouring method may appear in the rendered context.
    expect(text).not.toMatch(/\}\s*\n\s*ret = this\.buildAdjustIn/);
    expect(text).not.toContain('doSomethingElse');
  });

  it('falls through quietly when the index has no bodies for the owner either', async () => {
    const { index } = stubIndex(path.join(dir, 'Absent.xml'), { bodies: [] });

    const result = await call({ targetName: 'buildAdjustIn', targetType: 'method' }, index);

    expect(textOf(result)).toMatch(/not evidence/i);
  });
});
