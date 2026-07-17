/**
 * X++ method-source re-indentation.
 *
 * Re-derives indentation from brace depth alone, discarding whatever leading
 * whitespace the input had, so output is consistent regardless of how the
 * caller indented a method body.
 *
 * Microsoft convention (verified against shipped platform code, e.g.
 * ApplicationFoundation/AxClass/AVActionCompletedEventData.xml): the doc
 * comment + signature line sit at one indent level (4 spaces) — the matching
 * `{`/`}` sit at that same level, and nested content goes one level deeper
 * per brace.
 */

const INDENT_UNIT = '    ';

/** Net open/close bracket delta for one line, ignoring string literals and comments. */
function braceDelta(line: string): { delta: number; leadingCloses: number } {
  let delta = 0;
  let leadingCloses = 0;
  let sawNonCloseNonSpace = false;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (inLineComment) break;
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "'" && next === "'") { i++; continue; } // escaped '' inside a string
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; continue; }
    if (c === '/' && next === '/') { inLineComment = true; break; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }

    if (c === '{') { delta++; sawNonCloseNonSpace = true; }
    else if (c === '}') {
      delta--;
      if (!sawNonCloseNonSpace) leadingCloses++;
    } else if (c !== ' ' && c !== '\t') {
      sawNonCloseNonSpace = true;
    }
  }
  return { delta, leadingCloses };
}

/**
 * Re-indent an X++ method source block (doc comment + signature + body) to
 * the D365FO convention. `baseDepth` is the indent level (in 4-space units)
 * of the signature line itself — 1 for a method embedded in a class/table
 * <Source> element (the standard case), matching real shipped code.
 */
export function reindentXppSource(source: string, baseDepth = 1): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  // Trim leading/trailing all-blank lines; preserve blank lines in the middle.
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return '';

  let depth = baseDepth;
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') { out.push(''); continue; }

    const { delta, leadingCloses } = braceDelta(trimmed);
    const thisLineDepth = Math.max(depth - leadingCloses, 0);
    out.push(INDENT_UNIT.repeat(thisLineDepth) + trimmed);
    depth = Math.max(depth + delta, 0);
  }
  return out.join('\n');
}
