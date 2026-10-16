import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AOS_RUNTIME_POWERSHELL } from '../../src/tools/sdlc/aosRuntimePowerShell';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('keeps the encoded constant script within the Windows command-line limit', () => {
  expect(Buffer.from(AOS_RUNTIME_POWERSHELL, 'utf16le').toString('base64').length + 300).toBeLessThan(32767);
});

const mocks = `
$script:observed = @()
function Get-SameHost($request) { $request.host }
function Get-Process { param($Id, $ErrorAction)
  $fake = [pscustomobject]@{ Id=$Id }
  $fake | Add-Member ScriptMethod WaitForExit { param($timeout) return !$script:request.failExit }
  $fake
}
function Stop-Process { param($InputObject, $ErrorAction) $script:observed += @{ action='stop'; pid=$InputObject.Id } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
  $parsed = @([AosCommandLine]::Parse('iisexpress.exe ' + $ArgumentList) | Select-Object -Skip 1)
  $script:observed += @{ action='start'; exe=$FilePath; argv=$parsed; style=$WindowStyle }
  [pscustomobject]@{ Id=555 }
}
function Restart-WebAppPool { param($Name) $script:observed += @{ action='recycle'; pool=$Name } }
`;

async function harness(request: unknown, overrides = mocks): Promise<any> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aos-runtime-test-'));
  directories.push(dir);
  const file = path.join(dir, 'harness.ps1');
  const script = AOS_RUNTIME_POWERSHELL.replace(
    '\ntry {\n  $request =',
    `${overrides}\ntry {\n  $script:request =`,
  ).replace(
    '$result | ConvertTo-Json -Depth 12 -Compress',
    '@{result=$result;observed=$script:observed} | ConvertTo-Json -Depth 12 -Compress',
  );
  await writeFile(file, script, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { windowsHide: true });
    let output = '',
      errors = '';
    child.stdout.on('data', data => {
      output += data.toString();
    });
    child.stderr.on('data', data => {
      errors += data.toString();
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(errors.trim()))));
    child.stdin.end(JSON.stringify(request));
  });
}

describe.skipIf(process.platform !== 'win32')('Windows runtime script with every mutation mocked', () => {
  const host = {
    kind: 'iis-express',
    pid: 25144,
    executablePath: 'C:\\Program Files\\IIS Express\\IISExpress.exe',
    args: [
      '/config:C:\\Users\\Developer\\Documents\\IISExpress\\config\\applicationHost.config',
      '/apppool:Dynamics365',
    ],
  };
  it('stops only the selected PID, preserves argv, and starts the replacement hidden', async () => {
    const result = await harness({ action: 'restart', host });
    expect(result.result).toEqual({ restarted: true, replacementPid: 555 });
    expect(result.observed).toEqual([
      { action: 'stop', pid: 25144 },
      { action: 'start', exe: host.executablePath, argv: host.args, style: 'Hidden' },
    ]);
  });
  it('refuses to start a replacement when the selected process did not exit', async () => {
    await expect(harness({ action: 'restart', host, failExit: true })).rejects.toThrow('did not exit');
  });
  it('recycles only AOSService for a validated full IIS host', async () => {
    const result = await harness({ action: 'restart', host: { kind: 'iis', pool: 'AOSService' } });
    expect(result.observed).toEqual([{ action: 'recycle', pool: 'AOSService' }]);
  });
});
