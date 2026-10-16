/**
 * Analysis of a capture by the bridge binary in its own process (`--analyze-trace`), so a run of
 * several minutes neither holds the bridge nor outlasts a tool call. Each set of options has its
 * own result file beside the capture; asking again returns it, or the progress while it runs.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

export interface AnalysisOptions { focus?: string[]; pid?: number; scope?: 'thread' | 'subtree'; top?: number }

export function analysisFiles(etl: string, options: AnalysisOptions) {
  const stat = fs.statSync(etl);
  const key = createHash('sha256')
    .update(JSON.stringify([stat.size, stat.mtimeMs, options.focus ?? [], options.pid ?? 0, options.scope ?? 'thread', options.top ?? 25]))
    .digest('hex').slice(0, 12);
  const base = `${etl}.analysis.${key}`;
  return { result: `${base}.json`, progress: `${base}.progress.json`, log: `${base}.log` };
}

/** Running analyses, by result file. A restart forgets them; the progress file's age then tells. */
const running = new Map<string, number>();

export type AnalysisState =
  | { state: 'done'; result: Record<string, unknown> }
  | { state: 'failed'; error: string }
  | { state: 'running'; eventsRead?: number; elapsedSeconds?: number };

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return undefined; } };

export function analysisState(files: ReturnType<typeof analysisFiles>): AnalysisState | undefined {
  const result = readJson(files.result);
  if (result) {
    if (typeof result.error === 'string') return { state: 'failed', error: result.error };
    return { state: 'done', result };
  }
  if (running.has(files.result)) {
    const p = readJson(files.progress);
    return { state: 'running', eventsRead: p?.eventsRead, elapsedSeconds: p?.elapsedSeconds };
  }
  // Started by an earlier server process: trust a progress file written in the last minute.
  try {
    if (Date.now() - fs.statSync(files.progress).mtimeMs < 60_000) {
      const p = readJson(files.progress);
      return { state: 'running', eventsRead: p?.eventsRead, elapsedSeconds: p?.elapsedSeconds };
    }
  } catch { /* none */ }
  return undefined;
}

/**
 * Forget a failed analysis: its result, and its progress file too — a progress file under a minute
 * old reads as a run still going (one started by an earlier server process), so leaving it would
 * answer "analysing" for a run that has already died, instead of starting a new one.
 */
export function clearAnalysis(files: ReturnType<typeof analysisFiles>): void {
  for (const f of [files.result, files.progress, files.log]) {
    try { fs.rmSync(f, { force: true }); } catch { /* a log still held open is harmless */ }
  }
}

export function startAnalysis(exe: string, etl: string, options: AnalysisOptions, files: ReturnType<typeof analysisFiles>): void {
  for (const f of [files.result, files.progress]) fs.rmSync(f, { force: true });
  const args = ['--analyze-trace', etl, '--out', files.result, '--progress', files.progress];
  if (options.focus?.length) args.push('--focus', options.focus.join(';'));
  if (options.pid) args.push('--pid', String(options.pid));
  if (options.scope) args.push('--scope', options.scope);
  if (options.top) args.push('--top', String(options.top));
  const log = fs.openSync(files.log, 'w');
  const child = spawn(exe, args, { windowsHide: true, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  running.set(files.result, Date.now());
  const forget = () => running.delete(files.result);
  child.on('exit', code => {
    forget();
    // A crash before the result was written still has to read as a failure, not "running".
    if (!fs.existsSync(files.result)) {
      const tail = (() => { try { return fs.readFileSync(files.log, 'utf-8').slice(-1500); } catch { return ''; } })();
      fs.writeFileSync(files.result, JSON.stringify({ error: `Analysis exited with code ${code} without a result. ${tail}`.trim() }));
    }
  });
  child.on('error', error => {
    forget();
    fs.writeFileSync(files.result, JSON.stringify({ error: `Could not start the analysis: ${error.message}` }));
  });
  child.unref();
}

export async function waitForAnalysis(files: ReturnType<typeof analysisFiles>, seconds: number): Promise<AnalysisState | undefined> {
  const until = Date.now() + seconds * 1000;
  let state = analysisState(files);
  while (state?.state === 'running' && Date.now() < until) {
    await new Promise(r => setTimeout(r, 1000));
    state = analysisState(files);
  }
  return state;
}

const LISTS = ['topSqlByTime', 'topSqlByCount', 'repeatedSql', 'topRowFetch', 'topCalls', 'topInclusive', 'topExclusive', 'openAtEnd', 'threads'];

/** Bound the reply: drop rows from the end of the longest ranking until it fits; never slice JSON. */
export function boundedAnalysis(result: Record<string, unknown>, file: string, cap = 24000): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...result };
  for (const key of LISTS) if (Array.isArray(copy[key])) copy[key] = [...(copy[key] as unknown[])];
  if (JSON.stringify(copy).length <= cap) return copy;
  copy.truncated = `Rankings were shortened to fit the reply; the full result is in ${file}. Ask with a smaller top, or a focus, for a complete list.`;
  while (JSON.stringify(copy).length > cap) {
    const longest = LISTS
      .filter(k => Array.isArray(copy[k]) && (copy[k] as unknown[]).length > 3)
      .sort((a, b) => JSON.stringify(copy[b]).length - JSON.stringify(copy[a]).length)[0];
    if (!longest) break;
    (copy[longest] as unknown[]).pop();
  }
  return copy;
}
