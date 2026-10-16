import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isTraceEnabled, rememberOutputDir, resolveTraceConfig } from '../../config/trace.js';
import { TraceInputSchema, traceContract, type TraceInput } from './trace/contract.js';
import {
  SESSION, accessDenied, armTimer, captureFileName, captures, clearTimer, freeBytes, isDriveRoot, isInside, isOurs,
  isSessionRunning, listDrives, readState, requiredFreeMB, sameFile, settleExpired, sizeLimitMB, startCapture, stopCapture,
  writeState, type CaptureState,
} from './trace/capture.js';
import { analysisFiles, analysisState, boundedAnalysis, clearAnalysis, startAnalysis, waitForAnalysis } from './trace/analysis.js';
import { locateBridgeExe } from '../../bridge/bridgeClient.js';

export interface TraceContext { bridge?: { exePath?: string } }

const reply = (data: unknown, isError = false) => ({
  ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => reply({ code, message, ...extra }, true);
const ACCESS = 'logman was refused: capturing ETW needs MCP to run under an account in Administrators or Performance Log Users. Ask the user to fix the account and restart MCP; do not fall back to timer code without telling them.';
const NOT_OURS = `An ETW session named ${SESSION} is running that this server did not start: another MCP instance on this VM, or a logman command. Only one capture runs at a time on the VM.`;

/**
 * The folders analyze and delete may touch: the last capture's and the configured/remembered one.
 * Never a drive root, whose "inside" would be the whole drive.
 */
const traceFolders = (state: CaptureState | undefined) =>
  [...new Set([state?.outputDir, resolveTraceConfig().outputDir].filter((d): d is string => !!d && !isDriveRoot(d)))];

function captureView(state: CaptureState | undefined, running: boolean) {
  if (!state) return undefined;
  let sizeMB: number | undefined;
  try { sizeMB = Math.round(fs.statSync(state.file).size / 2 ** 20); } catch { /* not yet flushed */ }
  const now = Date.now();
  return {
    running, file: state.file, mode: state.mode, label: state.label, sizeMB, sizeLimitMB: state.maxSizeMB,
    startedAt: state.startedAt,
    secondsElapsed: Math.round(((state.stoppedAt ? Date.parse(state.stoppedAt) : now) - Date.parse(state.startedAt)) / 1000),
    ...(running ? { secondsLeft: Math.max(0, Math.round((Date.parse(state.deadline) - now) / 1000)) } : { stoppedAt: state.stoppedAt, stopReason: state.stopReason }),
  };
}

async function start(input: Extract<TraceInput, { action: 'start' }>) {
  const config = resolveTraceConfig();
  const current = await settleExpired();
  if (current && !current.stoppedAt) return fail('TRACE_ALREADY_RUNNING', 'A capture is running. Call stop (or wait for it to end) before starting another.', { capture: captureView(current, true) });
  if (await isSessionRunning()) return fail('TRACE_ALREADY_RUNNING', `${NOT_OURS} Wait for it to end, or ask the user to end it (logman stop ${SESSION} -ets).`);

  const seconds = Math.min(input.seconds ?? 60, config.maxSeconds);
  const limitMB = sizeLimitMB(seconds, config.maxSizeMB);
  const needMB = requiredFreeMB(limitMB);
  const neededGB = Math.ceil(needMB / 1024);
  // A configured trace.outputDir always wins: the agent cannot move captures (and what delete may remove) elsewhere.
  const configured = config.outputDirSource === 'config';
  const askFolder = async (why: string) => {
    const { drives, skipped } = await listDrives();
    return fail('TRACE_LOCATION_NEEDED', configured
      ? `${why}; a ${seconds} s capture needs about ${neededGB} GB. trace.outputDir is set in the configuration: ask the user to free space there or to change it (d365fo-mcp config trace, then restart MCP), or start a shorter capture.`
      : `${why}; a ${seconds} s capture needs about ${neededGB} GB. Ask the user which folder to use (suggest the drive with most space, not the system drive), then call start again with outputDir. The folder will be remembered.`,
      { drives, neededGB, ...(skipped.length ? { drivesNotProbed: `${skipped.join(', ')} (a slow drive used up the probe budget; D365FO_SCAN_DRIVES pins the letters)` } : {}) });
  };
  // A relative folder would land wherever the MCP host started the server, then be remembered there.
  if (!configured && input.outputDir && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(input.outputDir)) {
    return askFolder(`${input.outputDir} is not an absolute path (e.g. E:\\Traces)`);
  }
  const chosen = configured ? config.outputDir : input.outputDir ?? config.outputDir;
  if (!chosen) return askFolder('No trace folder is set yet');
  const dir = resolve(chosen);
  if (isDriveRoot(dir)) return askFolder(`${dir} is a drive root, which cannot be the trace folder (analyze and delete are confined to it); use a folder on it`);
  const free = freeBytes(dir);
  if (free === undefined || free / 2 ** 20 < needMB) {
    return askFolder(`${dir} has ${free === undefined ? 'no readable volume' : `${Math.round(free / 2 ** 30 * 10) / 10} GB free`}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  let remembered: string | undefined;
  if (input.outputDir && input.rememberOutputDir !== false && !configured) remembered = rememberOutputDir(dir);

  const file = captureFileName(dir, input.label);
  const result = await startCapture(file, limitMB);
  if (result.code !== 0) {
    if (accessDenied(result)) return fail('TRACE_ACCESS_DENIED', ACCESS);
    return fail('TRACE_START_FAILED', `logman create failed (${result.code}): ${result.output.slice(0, 1200)}`);
  }
  const startedAt = new Date();
  const state: CaptureState = {
    file, outputDir: dir, mode: input.mode, label: input.label, startedAt: startedAt.toISOString(),
    deadline: new Date(startedAt.getTime() + seconds * 1000).toISOString(), maxSizeMB: limitMB, ownerPid: process.pid,
  };
  try {
    writeState(state);
  } catch (error) {
    // Without its state file the capture has no owner, no deadline and nothing that would stop it:
    // every later stop would call it another instance's. Stop it now rather than leave it writing.
    const why = String(error instanceof Error ? error.message : error).slice(0, 600);
    const stopped = await stopCapture();
    const stillRunning = stopped.code !== 0 && await isSessionRunning();
    return fail('TRACE_STATE_FAILED', stillRunning
      ? `The capture started, but its state file could not be written (${why}), and stopping it failed too (${stopped.output.slice(0, 300)}). Ask the user to end it with: logman stop ${SESSION} -ets, and to fix the folder of the index database.`
      : `The capture was started and stopped again at once: its state file could not be written (${why}), so nothing could have stopped it later. Ask the user to fix write access to the folder of the index database (trace-session.json lives there).`,
      { file, stillRunning });
  }
  armTimer(state);
  return reply({
    started: true, capture: captureView(state, true),
    ...(remembered ? { outputDirRemembered: `${dir} (saved in ${remembered})` } : {}),
    ...(configured && input.outputDir && !sameFile(input.outputDir, dir) ? { outputDirIgnored: `trace.outputDir is configured; the capture is in ${dir}.` } : {}),
    nextStep: input.mode === 'auto'
      ? `Reproduce the scenario now with your browser tool or by running the job, then call stop. The capture ends by itself after ${seconds} s.`
      : `Tell the user the capture is running and what to do in the D365FO client; when they say they are done, call stop. It ends by itself after ${seconds} s.`,
  });
}

async function stop() {
  const state = readState();
  const running = await isSessionRunning();
  if (!running) {
    const settled = await settleExpired();
    if (!settled) return fail('TRACE_NOT_RUNNING', 'No capture to stop.');
    return reply({ stopped: true, alreadyEnded: true, capture: captureView(settled, false), nextStep: 'Call analyze.' });
  }
  // The session name is the same for every instance on the VM; the state file is this one's.
  if (!state || state.stoppedAt || !isOurs(state)) return fail('TRACE_NOT_OURS', `${NOT_OURS} Do not stop it from here; if it is left over, the user can end it with: logman stop ${SESSION} -ets`);
  const result = await stopCapture();
  if (result.code !== 0) {
    // Denied first: a query without the right fails as well and would read as "already ended".
    if (accessDenied(result)) return fail('TRACE_ACCESS_DENIED', ACCESS);
    if (!(await isSessionRunning())) {
      // It ended while we asked (the size limit, or the deadline timer stopping it first): not a failure.
      const settled = await settleExpired();
      return reply({ stopped: true, alreadyEnded: true, capture: captureView(settled ?? state, false), nextStep: 'Call analyze.' });
    }
    return fail('TRACE_STOP_FAILED', `logman stop failed (${result.code}): ${result.output.slice(0, 1200)}`);
  }
  clearTimer();
  if (state && !state.stoppedAt) { state.stoppedAt = new Date().toISOString(); state.stopReason = 'stop'; writeState(state); }
  return reply({ stopped: true, capture: captureView(state, false), nextStep: 'Call analyze; give focus (the batch class or form method) to select the threads that matter.' });
}

async function status() {
  const config = resolveTraceConfig();
  const state = await settleExpired();
  const dir = state?.outputDir ?? config.outputDir;
  return reply({
    capture: captureView(state, !!state && !state.stoppedAt) ?? null,
    outputDir: dir ?? null, outputDirSource: config.outputDirSource ?? null,
    freeGB: dir ? Math.round((freeBytes(dir) ?? 0) / 2 ** 30 * 10) / 10 : null,
    captures: dir ? captures(dir).slice(0, 20) : [],
    limits: { maxSeconds: config.maxSeconds, maxSizeMB: config.maxSizeMB },
  });
}

async function analyze(input: Extract<TraceInput, { action: 'analyze' }>, context: TraceContext) {
  const state = await settleExpired();
  const etl = resolve(input.file ?? state?.file ?? '');
  if (!input.file && !state) return fail('TRACE_NO_CAPTURE', 'No capture yet: start one, or pass file.');
  if (input.file && !traceFolders(state).some(d => isInside(etl, d))) {
    return fail('TRACE_FILE_REFUSED', `Only captures inside the trace folder can be analysed${traceFolders(state).length ? ` (${traceFolders(state).join(', ')})` : ''}.`);
  }
  if (state && !state.stoppedAt && sameFile(state.file, etl)) return fail('TRACE_STILL_RUNNING', 'This capture is still running: call stop first.');
  if (!fs.existsSync(etl)) return fail('TRACE_FILE_NOT_FOUND', `${etl} does not exist.`);
  const options = { focus: input.focus, pid: input.pid, scope: input.scope, top: input.top };
  const files = analysisFiles(etl, options);
  let current = analysisState(files);
  if (current?.state === 'failed') {
    clearAnalysis(files);
    return fail('TRACE_ANALYSIS_FAILED', current.error.slice(0, 1500));
  }
  if (!current) {
    // The running bridge's binary, else the one it would start: the analysis needs only the binary,
    // so a bridge that failed to start (no packages path, a cold-VM timeout) does not block it.
    const exe = context.bridge?.exePath || locateBridgeExe();
    if (!exe || !fs.existsSync(exe)) return fail('TRACE_BRIDGE_UNAVAILABLE', 'The analysis runs in the Windows bridge binary, which was not found. Build it on the VM (dotnet build bridge/D365MetadataBridge -c Release) and restart MCP.');
    startAnalysis(exe, etl, options, files);
  }
  current = await waitForAnalysis(files, input.waitSeconds ?? 25);
  if (current?.state === 'done') return reply(boundedAnalysis(current.result, files.result));
  if (current?.state === 'failed') {
    clearAnalysis(files);
    return fail('TRACE_ANALYSIS_FAILED', current.error.slice(0, 1500));
  }
  return reply({
    analysing: true, file: etl, eventsRead: current?.state === 'running' ? current.eventsRead ?? 0 : 0,
    elapsedSeconds: current?.state === 'running' ? current.elapsedSeconds ?? 0 : 0,
    nextStep: 'Still reading the capture (about 15,000 events/s). Call analyze again with the same arguments.',
  });
}

function remove(input: Extract<TraceInput, { action: 'delete' }>) {
  const state = readState();
  const dirs = traceFolders(state);
  const etl = resolve(input.file);
  if (!dirs.some(d => isInside(etl, d))) return fail('TRACE_DELETE_REFUSED', `Only captures inside the trace folder${dirs.length ? ` (${dirs.join(', ')})` : ''} can be deleted.`);
  if (state && !state.stoppedAt && sameFile(state.file, etl)) return fail('TRACE_STILL_RUNNING', 'This capture is running: call stop first.');
  const name = basename(etl).toLowerCase();
  const parent = resolve(etl, '..');
  const removed: string[] = [];
  for (const entry of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
    const lower = entry.toLowerCase();
    if (lower === name || lower.startsWith(`${name}.analysis.`)) {
      fs.rmSync(join(parent, entry), { force: true });
      removed.push(join(parent, entry));
    }
  }
  return reply({ deleted: removed });
}

export async function traceD365foTool(args: unknown, context: TraceContext) {
  try {
    const input = TraceInputSchema.parse(args);
    if (input.action === 'contract') return reply(traceContract());
    if (!isTraceEnabled()) return fail('TRACE_DISABLED', 'Tracing is not enabled. Do not use this tool; run d365fo-mcp config trace to enable it, then restart MCP.');
    if (process.platform !== 'win32') return fail('TRACE_UNSUPPORTED', 'ETW capture runs only on the Windows D365FO VM.');
    switch (input.action) {
      case 'start': return await start(input);
      case 'stop': return await stop();
      case 'status': return await status();
      case 'analyze': return await analyze(input, context);
      case 'delete': return remove(input);
    }
  } catch (error) {
    return fail('TRACE_ERROR', String(error instanceof Error ? error.message : error).slice(0, 1500));
  }
}
