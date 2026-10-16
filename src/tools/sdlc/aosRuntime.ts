import { spawn } from 'node:child_process';
import { AOS_RUNTIME_POWERSHELL } from './aosRuntimePowerShell.js';

export interface RuntimeHost {
  kind: 'iis' | 'iis-express';
  siteName: string;
  siteId: string;
  pool: string;
  applicationPath: string;
  binding: { protocol: string; information: string };
  configPath: string;
  configHash: string;
  pid?: number;
  creationTime?: string;
  executablePath?: string;
  commandLine?: string;
  args?: string[];
  ownerSid?: string;
  workerPids?: number[];
}
export interface RuntimeInventory {
  currentSid: string;
  isAdmin: boolean;
  localAddresses: string[];
  targetAddresses: string[];
  hosts: RuntimeHost[];
  errors: string[];
}
export interface RuntimeRestartResult {
  status: 'ready' | 'blocked' | 'failed' | 'not-ready';
  message: string;
  host?: string;
  replacementPid?: number;
}

function environmentOrigin(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
    throw new Error('AOS URL must be an HTTP(S) environment root without credentials.');
  }
  return new URL(url.origin);
}

function bindingMatches(host: RuntimeHost, url: URL, addresses: string[]): boolean {
  const binding = /^(.*):(\d+):(.*)$/.exec(host.binding.information);
  return (
    !!binding &&
    host.applicationPath === '/' &&
    host.binding.protocol === url.protocol.slice(0, -1) &&
    Number(binding[2]) === Number(url.port || (url.protocol === 'https:' ? 443 : 80)) &&
    (!binding[3] || binding[3].toLowerCase() === url.hostname.toLowerCase()) &&
    (['*', '', '0.0.0.0', '[::]'].includes(binding[1]) || addresses.includes(binding[1]))
  );
}

function validateExpress(host: RuntimeHost, inventory: RuntimeInventory): void {
  if (!host.ownerSid || host.ownerSid !== inventory.currentSid)
    throw new Error('IIS Express belongs to a different Windows identity.');
  if (
    !host.pid ||
    !host.creationTime ||
    !host.commandLine ||
    !host.executablePath ||
    !/^[a-z]:\\Program Files(?: \(x86\))?\\IIS Express\\iisexpress\.exe$/i.test(host.executablePath)
  ) {
    throw new Error('Cannot verify the IIS Express executable/process identity.');
  }
  const options = new Map<string, string>();
  for (const arg of host.args ?? []) {
    const match = /^\/(config|apppool|site|siteid|systray|trace):([^"\r\n]+)$/i.exec(arg);
    if (!match || options.has(match[1].toLowerCase()))
      throw new Error('IIS Express has unrecognized or duplicate startup arguments.');
    options.set(match[1].toLowerCase(), match[2]);
  }
  if (options.get('config')?.toLowerCase() !== host.configPath.toLowerCase())
    throw new Error('An explicit, matching IIS Express config path is required.');
  const selectors = ['apppool', 'site', 'siteid'].filter(key => options.has(key));
  if (selectors.length !== 1) throw new Error('Exactly one IIS Express pool/site selector is required.');
  if (
    (options.has('apppool') && options.get('apppool')!.toLowerCase() !== host.pool.toLowerCase()) ||
    (options.has('site') && options.get('site')!.toLowerCase() !== host.siteName.toLowerCase()) ||
    (options.has('siteid') && options.get('siteid') !== host.siteId)
  )
    throw new Error('The running IIS Express selector does not host this root.');
  if (options.has('systray') && !/^(true|false)$/i.test(options.get('systray')!))
    throw new Error('Invalid systray argument.');
  if (options.has('trace') && !/^(none|error|warning|info)$/i.test(options.get('trace')!))
    throw new Error('Invalid trace argument.');
}

/** Pure selection: never choose a best guess among multiple matching runtime roots. */
export function selectAosHost(value: string, inventory: RuntimeInventory): RuntimeHost {
  const url = environmentOrigin(value);
  if (inventory.errors.length) throw new Error(`Runtime discovery incomplete: ${inventory.errors.join('; ')}`);
  if (
    !inventory.targetAddresses.length ||
    inventory.targetAddresses.some(ip => !inventory.localAddresses.includes(ip))
  ) {
    throw new Error('The configured AOS hostname does not resolve exclusively to local addresses.');
  }
  const matches = inventory.hosts.filter(host => bindingMatches(host, url, inventory.targetAddresses));
  if (matches.length !== 1)
    throw new Error(`Expected one local AOS root for ${url.origin}; found ${matches.length}. Restart blocked.`);
  const host = matches[0];
  if (!host.configHash) throw new Error('Cannot validate the runtime configuration snapshot.');
  if (host.kind === 'iis-express') validateExpress(host, inventory);
  else if (host.pool.toLowerCase() !== 'aosservice' || !inventory.isAdmin) {
    throw new Error('Full IIS restart requires the AOSService application pool and an administrative Windows session.');
  }
  return host;
}

interface RestartDependencies {
  platform: string;
  command: (request: Record<string, unknown>) => Promise<any>;
  http: (url: string, timeoutMs?: number) => Promise<{ status: number; location?: string }>;
  delay: (ms: number) => Promise<void>;
  now: () => number;
}

/** Constant script only; all caller/host values travel as JSON on stdin. */
export function runtimePowerShell(request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(AOS_RUNTIME_POWERSHELL, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    const timeoutMs = typeof request.timeoutMs === 'number' ? Math.max(1, Math.min(45000, request.timeoutMs)) : 45000;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Runtime PowerShell timed out; mutation outcome may be unknown.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) {
        child.kill();
        reject(new Error('Runtime discovery output exceeded limit'));
      }
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 8000) stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Runtime PowerShell exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
      } catch {
        reject(new Error('Runtime PowerShell returned invalid JSON'));
      }
    });
    child.stdin.on('error', () => {
      /* process error/close reports the outcome */
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const dependencies: RestartDependencies = {
  platform: process.platform,
  command: runtimePowerShell,
  now: Date.now,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  http: async (url, timeoutMs = 10000) => {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return { status: response.status, location: response.headers.get('location') ?? undefined };
  },
};

async function probeHttp(
  url: URL,
  deps: RestartDependencies,
  deadline: number,
): Promise<{ status: number; location?: string; reason?: string }> {
  let current = url.href;
  const visited = new Set<string>();
  for (let hop = 0; hop < 5; hop++) {
    if (visited.has(current)) return { status: 0, reason: 'Same-origin HTTP redirect loop; readiness not verified.' };
    visited.add(current);
    if (deadline <= deps.now()) return { status: 0, reason: 'HTTP readiness deadline reached.' };
    const response = await deps.http(current, Math.max(1, Math.min(10000, deadline - deps.now())));
    if (response.status < 300 || response.status >= 400 || !response.location) return response;
    const redirect = new URL(response.location, current);
    if (redirect.username || redirect.password) return { status: 0, reason: 'HTTP redirect with credentials blocked.' };
    if (redirect.origin !== url.origin) return { ...response, location: redirect.href };
    current = redirect.href;
  }
  return { status: 0, reason: 'HTTP readiness exceeded five same-origin redirect hops.' };
}

export async function restartAosRuntime(
  value: string,
  deps: RestartDependencies = dependencies,
): Promise<RuntimeRestartResult> {
  let host: RuntimeHost;
  let url: URL;
  try {
    if (deps.platform !== 'win32') throw new Error('A local Windows AOS host is required.');
    url = environmentOrigin(value);
    host = selectAosHost(url.href, await deps.command({ action: 'discover', url: url.href }));
  } catch (error: any) {
    return { status: 'blocked', message: `AOS restart blocked: ${error.message}` };
  }
  const description = `${host.kind} ${host.siteName}/${host.pool}${host.pid ? ` PID ${host.pid}` : ''}`;
  let restart: { replacementPid?: number; restarted: boolean };
  try {
    restart = await deps.command({ action: 'restart', url: url.href, host });
    if (!restart.restarted) throw new Error('Backend did not confirm a restart');
  } catch (error: any) {
    return {
      status: 'failed',
      host: description,
      message: `AOS restart failed; mutation outcome may be unknown. No retry was made. ${error.message}`,
    };
  }
  const deadline = deps.now() + 180000;
  let lastReason = 'Readiness deadline reached';
  while (deps.now() < deadline) {
    try {
      const response = await probeHttp(url, deps, deadline);
      if (response.reason)
        return {
          status: 'not-ready',
          host: description,
          replacementPid: restart.replacementPid,
          message: response.reason,
        };
      const redirect =
        response.status >= 300 && response.status < 400 && response.location
          ? new URL(response.location, url)
          : undefined;
      const authChallenge =
        response.status === 401 ||
        (!!redirect &&
          redirect.protocol === 'https:' &&
          !redirect.port &&
          !redirect.username &&
          !redirect.password &&
          ['login.microsoftonline.com', 'login.windows.net'].includes(redirect.hostname.toLowerCase()));
      const remaining = deadline - deps.now();
      if (remaining <= 0) break;
      const verified = await deps.command({
        action: 'verify',
        url: url.href,
        host,
        replacementPid: restart.replacementPid,
        timeoutMs: remaining,
      });
      if (redirect && redirect.origin !== url.origin && !authChallenge) {
        return {
          status: 'not-ready',
          host: description,
          replacementPid: restart.replacementPid,
          message:
            'AOS restart attempted, but HTTP readiness returned an unexpected external redirect. It was not followed; investigate before testing in the browser.',
        };
      }
      if (verified.verified && ((response.status >= 200 && response.status < 300) || authChallenge)) {
        return {
          status: 'ready',
          host: description,
          replacementPid: restart.replacementPid,
          message:
            'AOS restarted; replacement host and HTTP readiness verified. ' +
            (authChallenge
              ? 'The expected authentication challenge was received without following redirects; sign-in is still required in the browser. '
              : '') +
            'HTTP readiness does not prove the new objects behave as intended; check them in the browser.',
        };
      }
      lastReason = `HTTP ${response.status}; ${verified.verified ? 'replacement host verified' : verified.message || 'replacement host not verified'}`;
    } catch (error: any) {
      lastReason = error.message;
    }
    await deps.delay(2000);
  }
  return {
    status: 'not-ready',
    host: description,
    replacementPid: restart.replacementPid,
    message: `AOS restart attempted but readiness was not verified within 180 seconds: ${lastReason}. Do not test in the browser yet.`,
  };
}
