import { describe, expect, it, vi } from 'vitest';
import {
  selectAosHost,
  restartAosRuntime,
  type RuntimeInventory,
  type RuntimeHost,
} from '../../src/tools/sdlc/aosRuntime';

const url = 'https://dev.example.test/';
const express: RuntimeHost = {
  kind: 'iis-express',
  pid: 25144,
  creationTime: '2026-09-26T12:00:00Z',
  executablePath: 'C:\\Program Files\\IIS Express\\IISExpress.exe',
  commandLine:
    '"C:\\Program Files\\IIS Express\\IISExpress.exe" /config:"C:\\Users\\Admin\\Documents\\IISExpress\\config\\applicationHost.config" /apppool:Dynamics365',
  args: ['/config:C:\\Users\\Admin\\Documents\\IISExpress\\config\\applicationHost.config', '/apppool:Dynamics365'],
  ownerSid: 'S-1-own',
  configPath: 'C:\\Users\\Admin\\Documents\\IISExpress\\config\\applicationHost.config',
  configHash: 'hash',
  siteName: 'AOS',
  siteId: '1',
  pool: 'Dynamics365',
  applicationPath: '/',
  binding: { protocol: 'https', information: '*:443:dev.example.test' },
};
const inventory = (hosts: RuntimeHost[] = [express]): RuntimeInventory => ({
  currentSid: 'S-1-own',
  isAdmin: false,
  localAddresses: ['127.0.0.1'],
  targetAddresses: ['127.0.0.1'],
  hosts,
  errors: [],
});

describe('AOS runtime host selection', () => {
  it('selects the observed IISExpress /config + /apppool launch without changing arguments', () => {
    expect(selectAosHost(url, inventory())).toEqual(express);
  });
  it('supports one explicitly selected site among other sites in the config', () => {
    const host = { ...express, args: [express.args![0], '/site:AOS'] };
    expect(selectAosHost(url, inventory([host]))).toEqual(host);
  });
  it.each([
    ['ambiguous', [express, { ...express, pid: 22 }]],
    ['foreign Windows identity', [{ ...express, ownerSid: 'S-1-other' }]],
    ['unrecognized arguments', [{ ...express, args: [...express.args!, '/path:C:\\Other'] }]],
    ['wrong pool', [{ ...express, pool: 'OtherPool' }]],
    ['wrong host', [{ ...express, binding: { protocol: 'https', information: '*:443:other.test' } }]],
    ['wrong port', [{ ...express, binding: { protocol: 'https', information: '*:444:dev.example.test' } }]],
    ['missing root', [{ ...express, applicationPath: '/Other' }]],
  ] as const)('blocks %s without choosing another process', (_reason, hosts) => {
    expect(() => selectAosHost(url, inventory([...hosts] as RuntimeHost[]))).toThrow();
  });
  it('rejects nonlocal DNS even if a wildcard binding would match', () => {
    expect(() => selectAosHost(url, { ...inventory(), targetAddresses: ['203.0.113.1'] })).toThrow(/local/i);
  });
  it('requires an administrative preflight for the matching full IIS AOSService pool', () => {
    const host: RuntimeHost = {
      kind: 'iis',
      siteName: 'AOS',
      siteId: '1',
      pool: 'AOSService',
      applicationPath: '/',
      binding: express.binding,
      configPath: 'C:\\Windows\\System32\\inetsrv\\config\\applicationHost.config',
      configHash: 'hash',
      workerPids: [5],
    };
    expect(() => selectAosHost(url, inventory([host]))).toThrow(/admin/i);
    expect(selectAosHost(url, { ...inventory([host]), isAdmin: true })).toEqual(host);
  });
});

describe('restart and readiness orchestration', () => {
  function deps() {
    return {
      platform: 'win32',
      command: vi.fn(async (request: any) =>
        request.action === 'discover'
          ? inventory()
          : request.action === 'restart'
            ? { replacementPid: 555, restarted: true }
            : { verified: true },
      ),
      http: vi.fn().mockResolvedValue({ status: 200 }),
      delay: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(0),
    };
  }
  it('restarts only the selected host then verifies replacement and HTTP readiness separately', async () => {
    const d = deps();
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('ready');
    expect(d.command.mock.calls.map(c => c[0].action)).toEqual(['discover', 'restart', 'verify']);
    expect(d.command.mock.calls[1][0].host).toEqual(express);
    expect(result.message).toContain('check them in the browser');
  });
  it('never mutates if discovery is ambiguous', async () => {
    const d = deps();
    d.command.mockResolvedValue(inventory([express, { ...express, pid: 55 }]));
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('blocked');
    expect(d.command).toHaveBeenCalledTimes(1);
  });
  it('does not claim readiness or retry a restart after a mutation failure', async () => {
    const d = deps();
    d.command.mockImplementation(async request => {
      if (request.action === 'discover') return inventory();
      throw new Error('Replacement failed after stop');
    });
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('unknown');
    expect(d.command).toHaveBeenCalledTimes(2);
    expect(d.http).not.toHaveBeenCalled();
  });
  it('rejects external redirects without following them or claiming readiness', async () => {
    const d = deps();
    d.http.mockResolvedValue({ status: 302, location: 'https://unexpected.example.test/' });
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('not-ready');
    expect(result.message).toContain('redirect');
  });
  it('accepts a known Entra authentication challenge only after verifying the replacement host', async () => {
    const d = deps();
    d.http.mockResolvedValue({ status: 302, location: 'https://login.microsoftonline.com/tenant/oauth2/authorize' });
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('ready');
    expect(result.message).toContain('authentication');
    expect(d.command.mock.calls.at(-1)![0].action).toBe('verify');
    expect(d.http).toHaveBeenCalledTimes(1);
  });
  it('follows bounded same-origin redirects to the known authentication challenge', async () => {
    const d = deps();
    let clockReads = 0;
    d.now.mockImplementation(() => (++clockReads < 20 ? 0 : 181000));
    d.http
      .mockResolvedValueOnce({ status: 302, location: '/account/login' })
      .mockResolvedValueOnce({ status: 302, location: 'https://login.microsoftonline.com/tenant/oauth2/authorize' });
    expect((await restartAosRuntime(url, d)).status).toBe('ready');
    expect(d.http.mock.calls.map(call => call[0])).toEqual([url, 'https://dev.example.test/account/login']);
  });
  it('stops a same-origin redirect loop without claiming readiness or waiting 180 seconds', async () => {
    const d = deps();
    let clockReads = 0;
    d.now.mockImplementation(() => (++clockReads < 20 ? 0 : 181000));
    d.http.mockResolvedValue({ status: 302, location: '/loop' });
    expect((await restartAosRuntime(url, d)).status).toBe('not-ready');
    expect(d.http).toHaveBeenCalledTimes(2);
    expect(d.delay).not.toHaveBeenCalled();
  });
  it('bounds readiness polling and does not treat 503 as ready', async () => {
    const d = deps();
    d.http.mockResolvedValue({ status: 503 });
    d.now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(181000);
    const result = await restartAosRuntime(url, d);
    expect(result.status).toBe('not-ready');
    expect(d.command.mock.calls.filter(c => c[0].action === 'restart')).toHaveLength(1);
  });
  it('never accepts HTTP success without verifying replacement process', async () => {
    const d = deps();
    d.command.mockImplementation(async request =>
      request.action === 'discover'
        ? inventory()
        : request.action === 'restart'
          ? { replacementPid: 555, restarted: true }
          : { verified: false, message: 'old process still alive' },
    );
    d.now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(181000);
    expect((await restartAosRuntime(url, d)).status).toBe('not-ready');
  });
});
