/**
 * ETW capture with logman: one session at a time, named SESSION, written straight to an .etl file.
 *
 * The session is a real-time ("-ets") one, so nothing persists in the Data Collector Sets and the
 * file name is exactly the one passed. logman itself stops it when the file reaches the size limit
 * (-max); the duration limit is ours — a timer in this process plus a deadline in the state file,
 * checked on every call and re-armed when the server starts. The server also stops its capture when
 * it shuts down, so a capture does not outlive the session that started it.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, parse, resolve, win32 } from 'node:path';
import { traceStateDir } from '../../../config/trace.js';
import { DRIVE_SCAN_BUDGET_MS, driveLettersToProbe } from '../../../utils/packagesRoot.js';

export const SESSION = 'd365fo-mcp-trace';

/** Providers and keywords: X++ method enter/exit, and the AOS Database keyword (SQL latency). */
const PROVIDERS = [
  // Microsoft-Dynamics-AX-XppExecutionTraces: ImplicitTraces (method enter/exit)
  '{C0D248CE-634D-426B-9E31-5A50A6D83024} 0x1 5',
  // Microsoft-Dynamics-AX-ExecutionTraces: Database (statement, bind and fetch latency)
  '{70560195-BECD-45D4-AC93-97290953AD02} 0x10 5',
];

/** Volume measured on a busy batch server: about 45 MB/s; the margin keeps the drive usable. */
const MB_PER_SECOND = 50;
const MARGIN_MB = 1024;

export interface CaptureState {
  file: string;
  outputDir: string;
  mode: 'auto' | 'manual';
  label?: string;
  startedAt: string;
  deadline: string;
  maxSizeMB: number;
  /** The server process that started it: instances sharing an index share this state file. */
  ownerPid?: number;
  stoppedAt?: string;
  stopReason?: 'stop' | 'time limit' | 'size limit or ended outside MCP' | 'server shut down';
}

const stateFile = () => join(traceStateDir(), 'trace-session.json');

export function readState(): CaptureState | undefined {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) as CaptureState; } catch { return undefined; }
}
export function writeState(state: CaptureState): void {
  fs.mkdirSync(dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

export interface LogmanResult { code: number; output: string }

export function logman(args: string[]): Promise<LogmanResult> {
  return new Promise(done => {
    execFile('logman', args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
      done({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || String(error?.message ?? '') });
    });
  });
}

/**
 * logman refused for lack of ETW rights. Its text is localised ("Access is denied.",
 * "Accesso negato.") and carries no code, so the exit code decides: 0x80070005, which
 * Node reports unsigned (2147942405). Measured with a token whose Administrators and
 * Performance Log Users groups were disabled.
 */
export const accessDenied = (r: LogmanResult) =>
  r.code === 0x80070005 || r.code === -2147024891 || /0x80070005|access is denied/i.test(r.output);

export async function isSessionRunning(): Promise<boolean> {
  return (await logman(['query', SESSION, '-ets'])).code === 0;
}

/** Free bytes on the volume of path (the nearest existing ancestor), or undefined. */
export function freeBytes(path: string): number | undefined {
  let dir = resolve(path);
  for (;;) {
    try {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }
}

export interface DriveList { drives: Array<{ drive: string; freeGB: number }>; skipped: string[] }

export interface DriveProbe {
  statfs?: (root: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  clock?: () => number;
  budgetMs?: number;
  /** Overrides D365FO_SCAN_DRIVES. */
  letters?: string;
}

/**
 * Every drive with its free space, for the agent to offer. The same letters and time budget as the
 * packages-root scan (D365FO_SCAN_DRIVES pins them): a stat on a disconnected mapped network drive
 * stalls for the SMB timeout, so it runs on the threadpool, never on the event loop (which would stop
 * the server answering), one letter at a time; the letters left once the budget is spent are skipped
 * and named rather than waited for.
 */
export async function listDrives(probe: DriveProbe = {}): Promise<DriveList> {
  const statfs = probe.statfs ?? ((root: string) => fs.promises.statfs(root));
  const clock = probe.clock ?? Date.now;
  const budget = probe.budgetMs ?? DRIVE_SCAN_BUDGET_MS;
  const { letters, pinned } = driveLettersToProbe(probe.letters ?? process.env.D365FO_SCAN_DRIVES);
  const drives: DriveList['drives'] = [];
  const skipped: string[] = [];
  const start = clock();
  for (const letter of letters) {
    if (!pinned && clock() - start > budget) { skipped.push(letter); continue; }
    const root = `${letter}:\\`;
    try {
      const s = await statfs(root);
      drives.push({ drive: root, freeGB: Math.round((Number(s.bavail) * Number(s.bsize)) / 2 ** 30 * 10) / 10 });
    } catch { /* no such drive */ }
  }
  return { drives: drives.sort((a, b) => b.freeGB - a.freeGB), skipped };
}

/** Size limit for one capture: enough for the time asked (at least 200 MB), never more than the setup allows. */
export function sizeLimitMB(seconds: number, maxSizeMB: number): number {
  return Math.min(maxSizeMB, Math.max(200, seconds * MB_PER_SECOND));
}
export const requiredFreeMB = (limitMB: number) => limitMB + MARGIN_MB;

export function captureFileName(dir: string, label: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return join(dir, `d365fo-${stamp}${label ? `-${label}` : ''}.etl`);
}

export async function startCapture(file: string, limitMB: number): Promise<LogmanResult> {
  const providers = join(dirname(file), `${SESSION}.providers.txt`);
  fs.writeFileSync(providers, `${PROVIDERS.join('\r\n')}\r\n`);
  try {
    return await logman(['create', 'trace', SESSION, '-pf', providers, '-o', file,
      '-bs', '512', '-nb', '256', '256', '-max', String(limitMB), '-ets']);
  } finally {
    fs.rmSync(providers, { force: true });
  }
}

export async function stopCapture(): Promise<LogmanResult> {
  return logman(['stop', SESSION, '-ets']);
}

let timer: ReturnType<typeof setTimeout> | undefined;
const RETRY_STOP_MS = 30_000;

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
/** Started by this process, or by one that no longer runs (an earlier run of this installation). */
export const isOurs = (state: CaptureState) =>
  state.ownerPid === undefined || state.ownerPid === process.pid || !isAlive(state.ownerPid);

/** Stop at the deadline even if nobody calls the tool again. */
export function armTimer(state: CaptureState): void {
  if (timer) clearTimeout(timer);
  const ms = Math.max(0, Date.parse(state.deadline) - Date.now());
  timer = setTimeout(() => { void settleExpired(); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Bring the state file in line with the machine: past its deadline → stop it; no longer
 * running (size limit reached, stopped by hand) → record that. Returns the current state.
 */
export async function settleExpired(): Promise<CaptureState | undefined> {
  const state = readState();
  if (!state || state.stoppedAt) return state;
  const running = await isSessionRunning();
  if (running && Date.now() < Date.parse(state.deadline)) return state;
  if (running && (await stopCapture()).code !== 0 && await isSessionRunning()) {
    // Still writing: recording it as stopped would leave it running with nothing to stop it. Retry soon.
    armTimer({ ...state, deadline: new Date(Date.now() + RETRY_STOP_MS).toISOString() });
    return state;
  }
  state.stoppedAt = new Date().toISOString();
  state.stopReason = running ? 'time limit' : 'size limit or ended outside MCP';
  writeState(state);
  if (timer) { clearTimeout(timer); timer = undefined; }
  return state;
}

export function clearTimer(): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
}

/**
 * Server start: a capture an earlier run of this installation left running gets its timer back,
 * and one already past its deadline is stopped at once.
 */
export function resumeTimer(): void {
  const state = readState();
  if (state && !state.stoppedAt) armTimer(state);
}

/**
 * Server shutdown: stop the capture this installation started. Without it, a client closed
 * mid-capture leaves the ETW session writing until the next call to the tool.
 */
export async function stopOwnCapture(
  stop: () => Promise<LogmanResult> = stopCapture,
  running: () => Promise<boolean> = isSessionRunning,
): Promise<void> {
  const state = readState();
  // Another live instance's capture is its own to stop.
  if (!state || state.stoppedAt || !isOurs(state)) return;
  clearTimer();
  // Not stopped: leave it recorded as running, so the next call or server start stops it at its deadline.
  if ((await stop()).code !== 0 && await running()) return;
  state.stoppedAt = new Date().toISOString();
  state.stopReason = 'server shut down';
  writeState(state);
}

/**
 * Whether file lies inside dir (case-insensitive, as on Windows). Windows path rules on every
 * platform: elsewhere "\" is not a separator, so "K:\t\..\a.etl" would stay one name inside dir.
 */
export function isInside(file: string, dir: string): boolean {
  const f = win32.resolve(file).toLowerCase();
  const d = win32.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
  return f.startsWith(`${d}\\`);
}

export function captures(dir: string): Array<{ file: string; sizeMB: number; modified: string }> {
  try {
    return fs.readdirSync(dir)
      .filter(n => /\.etl$/i.test(n))
      .map(n => { const s = fs.statSync(join(dir, n)); return { file: join(dir, n), sizeMB: Math.round(s.size / 2 ** 20), modified: s.mtime.toISOString() }; })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export const driveOf = (path: string) => parse(resolve(path)).root;

/** The same file, compared as Windows does (case-insensitive). */
export const sameFile = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();

/** A drive root (or share root) cannot be the trace folder: analyze and delete are confined to it. */
export const isDriveRoot = (dir: string) => win32.dirname(win32.resolve(dir)) === win32.resolve(dir);
