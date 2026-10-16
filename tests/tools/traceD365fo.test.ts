import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceD365foTool } from '../../src/tools/sdlc/traceD365fo.js';
import { TraceInputSchema } from '../../src/tools/sdlc/trace/contract.js';
import { accessDenied, captureFileName, isInside, readState, sizeLimitMB, requiredFreeMB, stopCapture, stopOwnCapture, writeState } from '../../src/tools/sdlc/trace/capture.js';
import { analysisFiles, analysisState, boundedAnalysis } from '../../src/tools/sdlc/trace/analysis.js';
import { readRememberedOutputDir, rememberOutputDir, resolveTraceConfig } from '../../src/config/trace.js';
import { isToolEnabled } from '../../src/server/serverMode.js';

// logman stands in for the machine: these tests never touch a real ETW session.
const logman = vi.hoisted(() => ({ running: false }));
vi.mock('../../src/tools/sdlc/trace/capture.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/tools/sdlc/trace/capture.js')>()),
  isSessionRunning: vi.fn(async () => logman.running),
  stopCapture: vi.fn(async () => ({ code: 0, output: '' })),
  startCapture: vi.fn(async () => ({ code: 0, output: '' })),
  listDrives: vi.fn(async () => ({ drives: [{ drive: 'E:/', freeGB: 500 }], skipped: [] })),
  freeBytes: vi.fn(() => 500 * 2 ** 30),
}));

// The bridge binary the server would start, as the analysis finds it without a running bridge.
const bridgeExe = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('../../src/bridge/bridgeClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/bridge/bridgeClient.js')>()),
  locateBridgeExe: vi.fn(() => bridgeExe.path),
}));

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
  vi.stubEnv('DB_PATH', path.join(dir, 'index', 'symbols.db'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  logman.running = false;
  bridgeExe.path = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('trace_d365fo', () => {
  it('returns the contract even when tracing is disabled', async () => {
    const contract = parse(await traceD365foTool({ action: 'contract' }, {}));
    expect(contract.rules.some((r: string) => /customer data/.test(r))).toBe(true);
    expect(contract.inputSchema).toBeDefined();
  });

  it('refuses every other action while disabled', async () => {
    const r = await traceD365foTool({ action: 'status' }, {});
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe('TRACE_DISABLED');
  });

  it('is published only when tracing is enabled', () => {
    expect(isToolEnabled('trace_d365fo', 'full', 'full')).toBe(false);
    vi.stubEnv('D365FO_TRACE_ENABLED', 'true');
    expect(isToolEnabled('trace_d365fo', 'full', 'full')).toBe(true);
    // It drives logman on the VM: never on the Azure read-only server.
    expect(isToolEnabled('trace_d365fo', 'read-only', 'full')).toBe(false);
  });

  it('validates input strictly', () => {
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'auto', seconds: 5 }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'later' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'manual', label: 'a b' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'analyze', scope: 'subtree' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'analyze', scope: 'subtree', focus: ['BOMCalc'] }).success).toBe(true);
    expect(TraceInputSchema.safeParse({ action: 'analyze', focus: ['A;B'] }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'delete', file: 'C:\\x\\notes.txt' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'stop', extra: 1 }).success).toBe(false);
  });

  it('reads numbers, booleans and lists a client sent as text', () => {
    // The MCP inputSchema types only `action`, so a client may send the rest as strings.
    expect(TraceInputSchema.parse({ action: 'start', mode: 'manual', seconds: '120', rememberOutputDir: 'false' }))
      .toEqual({ action: 'start', mode: 'manual', seconds: 120, rememberOutputDir: false });
    expect(TraceInputSchema.parse({ action: 'analyze', focus: '["MyTraceProbe"]', pid: ' 4242 ', top: '15', waitSeconds: '0' }))
      .toEqual({ action: 'analyze', focus: ['MyTraceProbe'], pid: 4242, top: 15, waitSeconds: 0 });
    // Text is read back only where its type is expected, and the limits still apply.
    expect(TraceInputSchema.parse({ action: 'start', mode: 'auto', label: '2026' })).toMatchObject({ label: '2026' });
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'auto', seconds: '5' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'auto', seconds: '60s' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'start', mode: 'auto', rememberOutputDir: 'yes' }).success).toBe(false);
    expect(TraceInputSchema.parse({ action: 'analyze', focus: 'MyTraceProbe' })).toMatchObject({ focus: ['MyTraceProbe'] });
    expect(TraceInputSchema.safeParse({ action: 'analyze', focus: 'A;B' }).success).toBe(false);
    expect(TraceInputSchema.safeParse({ action: 'analyze', focus: '["A"' }).success).toBe(false);
  });

  it('sizes a capture from its duration, within the setup limit', () => {
    expect(sizeLimitMB(60, 4096)).toBe(3000);
    expect(sizeLimitMB(120, 4096)).toBe(4096);
    expect(sizeLimitMB(1, 4096)).toBe(200);
    // The 200 MB floor never overrides a lower setup limit.
    expect(sizeLimitMB(1, 100)).toBe(100);
    expect(requiredFreeMB(3000)).toBe(4024);
  });

  describe.runIf(process.platform === 'win32')('on the VM', () => {
    beforeEach(() => vi.stubEnv('D365FO_TRACE_ENABLED', 'true'));

    it('asks for a folder instead of writing to the system drive when none is set', async () => {
      const r = parse(await traceD365foTool({ action: 'start', mode: 'auto', seconds: 30 }, {}));
      expect(r.code).toBe('TRACE_LOCATION_NEEDED');
      expect(r.message).toMatch(/No trace folder is set/);
      expect(r.drives).toEqual([{ drive: 'E:/', freeGB: 500 }]);
    });

    const running = (file: string, extra: Partial<Parameters<typeof writeState>[0]> = {}) =>
      writeState({ file, outputDir: path.dirname(file), mode: 'manual', startedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 60_000).toISOString(), maxSizeMB: 200, ...extra });

    it('keeps a configured trace folder: outputDir cannot move captures elsewhere', async () => {
      const configured = path.join(dir, 'configured');
      vi.stubEnv('D365FO_TRACE_DIR', configured);
      const r = parse(await traceD365foTool({ action: 'start', mode: 'auto', seconds: 10, outputDir: path.join(dir, 'elsewhere') }, {}));
      expect(r.started).toBe(true);
      expect(isInside(r.capture.file, configured)).toBe(true);
      expect(r.outputDirIgnored).toMatch(/configured/);
      expect(readState()?.ownerPid).toBe(process.pid);
      expect(readRememberedOutputDir()).toBeUndefined();
    });

    it('refuses a drive root as the trace folder', async () => {
      const r = parse(await traceD365foTool({ action: 'start', mode: 'auto', seconds: 10, outputDir: 'C:\\' }, {}));
      expect(r.code).toBe('TRACE_LOCATION_NEEDED');
      expect(r.message).toMatch(/drive root/);
      expect(readRememberedOutputDir()).toBeUndefined();
    });

    it('analyses only captures inside the trace folder', async () => {
      vi.stubEnv('D365FO_TRACE_DIR', path.join(dir, 'traces'));
      const outside = path.join(dir, 'other', 'a.etl');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, 'x');
      expect(parse(await traceD365foTool({ action: 'analyze', file: outside }, {})).code).toBe('TRACE_FILE_REFUSED');
      expect(parse(await traceD365foTool({ action: 'analyze', file: '\\\\host\\share\\a.etl' }, {})).code).toBe('TRACE_FILE_REFUSED');
    });

    it('analyses with the built bridge binary when the long-running bridge did not start', async () => {
      vi.stubEnv('D365FO_TRACE_DIR', path.join(dir, 'traces'));
      const etl = path.join(dir, 'traces', 'd365fo-a.etl');
      fs.mkdirSync(path.dirname(etl), { recursive: true });
      fs.writeFileSync(etl, 'x');
      expect(parse(await traceD365foTool({ action: 'analyze', file: etl, waitSeconds: 0 }, {})).code).toBe('TRACE_BRIDGE_UNAVAILABLE');
      // node stands in for the binary: it rejects --analyze-trace, which shows the analysis was started with it.
      bridgeExe.path = process.execPath;
      const r = parse(await traceD365foTool({ action: 'analyze', file: etl, waitSeconds: 20 }, {}));
      expect(r.code).toBe('TRACE_ANALYSIS_FAILED');
      expect(r.message).toMatch(/exited with code/);
    });

    it('starts a new analysis after a failed one, not "still analysing" from its progress file', async () => {
      vi.stubEnv('D365FO_TRACE_DIR', path.join(dir, 'traces'));
      const etl = path.join(dir, 'traces', 'd365fo-a.etl');
      fs.mkdirSync(path.dirname(etl), { recursive: true });
      fs.writeFileSync(etl, 'x');
      // The analysis read 250,000 events, wrote its progress, then failed.
      const files = analysisFiles(etl, {});
      fs.writeFileSync(files.progress, JSON.stringify({ eventsRead: 250000, elapsedSeconds: 17 }));
      fs.writeFileSync(files.result, JSON.stringify({ error: 'EventLogException: corrupt' }));
      expect(parse(await traceD365foTool({ action: 'analyze', file: etl, waitSeconds: 0 }, {})).message).toMatch(/corrupt/);
      expect(fs.existsSync(files.progress)).toBe(false);
      // Asked again: a new run starts (node stands in for the binary and rejects --analyze-trace).
      bridgeExe.path = process.execPath;
      const r = parse(await traceD365foTool({ action: 'analyze', file: etl, waitSeconds: 10 }, {}));
      expect(r.analysing).toBeUndefined();
      expect(r.message).toMatch(/exited with code/);
    });

    it('stops a capture whose state file cannot be written, and says so', async () => {
      vi.stubEnv('D365FO_TRACE_DIR', path.join(dir, 'traces'));
      fs.writeFileSync(path.join(dir, 'blocker'), 'a file where the index folder should be');
      vi.stubEnv('DB_PATH', path.join(dir, 'blocker', 'index', 'symbols.db'));
      vi.mocked(stopCapture).mockClear();
      const r = await traceD365foTool({ action: 'start', mode: 'auto', seconds: 10 }, {});
      expect(r.isError).toBe(true);
      expect(parse(r)).toMatchObject({ code: 'TRACE_STATE_FAILED', stillRunning: false });
      expect(stopCapture).toHaveBeenCalledTimes(1);
    });

    it('reports a capture that ended while stop was asked as stopped, not as a failed stop', async () => {
      logman.running = true;
      running(path.join(dir, 'traces', 'a.etl'), { ownerPid: process.pid });
      // The size limit ends it just before logman stop runs: stop then fails with "not found".
      vi.mocked(stopCapture).mockImplementationOnce(async () => { logman.running = false; return { code: 2150694914, output: 'Data Collector Set was not found.' }; });
      const r = await traceD365foTool({ action: 'stop' }, {});
      expect(r.isError).toBeUndefined();
      expect(parse(r)).toMatchObject({ stopped: true, alreadyEnded: true });
      expect(readState()?.stoppedAt).toBeDefined();
    });

    it('reports a denied stop as denied, not as a capture that already ended', async () => {
      logman.running = true;
      running(path.join(dir, 'traces', 'a.etl'), { ownerPid: process.pid });
      vi.mocked(stopCapture).mockImplementationOnce(async () => ({ code: 0x80070005, output: 'Access is denied.' }));
      const r = await traceD365foTool({ action: 'stop' }, {});
      expect(parse(r).code).toBe('TRACE_ACCESS_DENIED');
      expect(readState()?.stoppedAt).toBeUndefined();
    });

    it('refuses a relative trace folder from the agent', async () => {
      const r = parse(await traceD365foTool({ action: 'start', mode: 'auto', seconds: 10, outputDir: 'traces' }, {}));
      expect(r.code).toBe('TRACE_LOCATION_NEEDED');
      expect(r.message).toMatch(/not an absolute path/);
      expect(readRememberedOutputDir()).toBeUndefined();
    });

    it('recognises the running capture whatever the letter case', async () => {
      const file = path.join(dir, 'traces', 'd365fo-a.etl');
      running(file);
      const r = parse(await traceD365foTool({ action: 'delete', file: file.toUpperCase() }, {}));
      expect(r.code).toBe('TRACE_STILL_RUNNING');
    });

    it("does not stop a capture another live instance sharing the index started", async () => {
      logman.running = true;
      running(path.join(dir, 'traces', 'a.etl'), { ownerPid: process.ppid });
      expect(parse(await traceD365foTool({ action: 'stop' }, {})).code).toBe('TRACE_NOT_OURS');
      expect(readState()?.stoppedAt).toBeUndefined();
    });

    it("does not stop a session another instance started", async () => {
      logman.running = true;
      const r = await traceD365foTool({ action: 'stop' }, {});
      expect(parse(r).code).toBe('TRACE_NOT_OURS');
      // Nor one this instance already recorded as ended.
      writeState({ file: 'E:/t/a.etl', outputDir: 'E:/t', mode: 'auto', startedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 60_000).toISOString(), maxSizeMB: 200, stoppedAt: new Date().toISOString(), stopReason: 'stop' });
      expect(parse(await traceD365foTool({ action: 'stop' }, {})).code).toBe('TRACE_NOT_OURS');
    });
  });

  it('stops its own capture when the server shuts down, and only a running one', async () => {
    const stop = vi.fn(async () => ({ code: 0, output: '' }));
    await stopOwnCapture(stop);
    expect(stop).not.toHaveBeenCalled();
    writeState({ file: 'E:/t/a.etl', outputDir: 'E:/t', mode: 'manual', startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(), maxSizeMB: 3000 });
    await stopOwnCapture(stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(readState()).toMatchObject({ stopReason: 'server shut down' });
    await stopOwnCapture(stop);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves another live instance's capture alone at shutdown, and keeps one it failed to stop", async () => {
    const state = { file: 'E:/t/a.etl', outputDir: 'E:/t', mode: 'manual' as const, startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(), maxSizeMB: 3000 };
    const stop = vi.fn(async () => ({ code: 0, output: '' }));
    writeState({ ...state, ownerPid: process.ppid });
    await stopOwnCapture(stop);
    expect(stop).not.toHaveBeenCalled();
    expect(readState()?.stoppedAt).toBeUndefined();
    // logman failed and the session still runs: not recorded as stopped, so its deadline still applies.
    writeState({ ...state, ownerPid: process.pid });
    await stopOwnCapture(async () => ({ code: 1, output: 'timeout' }), async () => true);
    expect(readState()?.stoppedAt).toBeUndefined();
  });

  it('recognises a refused logman by its exit code, whatever the language', () => {
    // What Node got from logman under a token without Administrators / Performance Log Users.
    expect(accessDenied({ code: 2147942405, output: 'Errore:\r\nAccesso negato.\r\nProva a eseguire questo comando come amministratore.' })).toBe(true);
    expect(accessDenied({ code: 2147942405, output: 'Fehler:\r\nZugriff verweigert.' })).toBe(true);
    expect(accessDenied({ code: 1, output: 'Error: Access is denied.' })).toBe(true);
    expect(accessDenied({ code: 2147942487, output: 'Errore:\r\nParametro non corretto.' })).toBe(false);
  });

  it('names captures by time and label', () => {
    const name = captureFileName('K:\\Temp\\t', 'bom', new Date(2026, 9, 14, 9, 5, 7));
    expect(path.basename(name)).toBe('d365fo-20261014-090507-bom.etl');
  });

  it('confines delete to the trace folder', () => {
    expect(isInside('K:\\Temp\\t\\a.etl', 'K:\\Temp\\t')).toBe(true);
    expect(isInside('k:\\temp\\T\\a.etl', 'K:\\Temp\\t\\')).toBe(true);
    expect(isInside('K:\\Temp\\t2\\a.etl', 'K:\\Temp\\t')).toBe(false);
    expect(isInside('K:\\Temp\\t\\..\\a.etl', 'K:\\Temp\\t')).toBe(false);
  });

  it('remembers the chosen folder beside the index, and config wins over it', () => {
    expect(readRememberedOutputDir()).toBeUndefined();
    const file = rememberOutputDir('E:\\Traces');
    expect(path.dirname(file)).toBe(path.join(dir, 'index'));
    expect(resolveTraceConfig()).toMatchObject({ outputDir: 'E:\\Traces', outputDirSource: 'remembered' });
    vi.stubEnv('D365FO_TRACE_DIR', 'F:\\Configured');
    expect(resolveTraceConfig()).toMatchObject({ outputDir: 'F:\\Configured', outputDirSource: 'config' });
  });

  it('rejects limits outside their range', () => {
    vi.stubEnv('D365FO_TRACE_MAX_SECONDS', '5');
    expect(() => resolveTraceConfig()).toThrow(/D365FO_TRACE_MAX_SECONDS/);
  });

  it('keys analyses by options and reads a finished or failed result', () => {
    const etl = path.join(dir, 'a.etl');
    fs.writeFileSync(etl, 'x');
    const a = analysisFiles(etl, { focus: ['X'] });
    expect(analysisFiles(etl, { focus: ['X'] }).result).toBe(a.result);
    expect(analysisFiles(etl, { focus: ['Y'] }).result).not.toBe(a.result);
    expect(analysisState(a)).toBeUndefined();
    fs.writeFileSync(a.result, JSON.stringify({ error: 'boom' }));
    expect(analysisState(a)).toEqual({ state: 'failed', error: 'boom' });
    fs.writeFileSync(a.result, JSON.stringify({ totals: {} }));
    expect(analysisState(a)?.state).toBe('done');
  });

  it('shortens rankings to fit the reply without breaking the JSON', () => {
    const row = { statement: 'S'.repeat(300), executions: 1 };
    const result = { totals: { sqlStatements: 1 }, topSqlByTime: Array(40).fill(row), topSqlByCount: Array(40).fill(row), caveats: ['c'] };
    const bounded = boundedAnalysis(result, 'r.json', 24000);
    const text = JSON.stringify(bounded);
    expect(text.length).toBeLessThanOrEqual(24000);
    expect(bounded.truncated).toMatch(/r\.json/);
    expect(bounded.caveats).toEqual(['c']);
    expect((bounded.topSqlByTime as unknown[]).length).toBeGreaterThan(3);
    expect(result.topSqlByTime).toHaveLength(40); // the original is left alone
    expect(boundedAnalysis({ totals: {} }, 'r.json').truncated).toBeUndefined();
  });
});
