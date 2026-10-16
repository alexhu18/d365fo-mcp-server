/**
 * Whether the built bridge matches the sources on disk (#1115).
 *
 * An update can leave the bridge binary in place while it moves the bridge
 * sources — `npm install -g` builds into the data directory, `git pull` never
 * touches bin/Release — and the server then runs new TypeScript against an old
 * bridge. The build writes a stamp of its sources next to the binary (the
 * WriteBridgeSourceStamp target in the csproj); this compares it with the
 * sources as they are now.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeFreshness, hashBridgeSources, SOURCE_STAMP_FILE } from '../../src/cli/bridgeSources.js';
import { checkBuiltBridge } from '../../src/cli/commands/doctor.js';
import { paths } from '../../src/cli/context.js';
import { hashSources } from '../../scripts/bridgeAttest.mjs';

describe('hashBridgeSources', () => {
  it('computes the same hash as the build attestation', () => {
    // The csproj target, this port and bridgeAttest.mjs must agree, or a
    // freshly built bridge would read as stale.
    expect(hashBridgeSources()).toBe(hashSources().hash);
  });

  it('is the hash the csproj target writes, under the file name this reads', () => {
    // The target cannot run in CI (no D365FO assemblies to build against), so
    // pin what can be: it exists, runs after every build, writes next to the
    // binary for both install modes ($(OutDir) follows `-o`), and hashes the
    // same inputs the same way.
    const csproj = fs.readFileSync(paths.bridgeProject, 'utf-8');
    expect(csproj).toMatch(/<Target Name="WriteBridgeSourceStamp" AfterTargets="Build">/);
    expect(csproj).toContain(`OutputFile="$(OutDir)${SOURCE_STAMP_FILE}"`);
    expect(csproj).toContain('name != "obj" && name != "bin"');
    expect(csproj).toContain('file.EndsWith(".cs", System.StringComparison.Ordinal) || file.EndsWith(".csproj", System.StringComparison.Ordinal)');
    expect(csproj).toContain('.Replace("\\r\\n", "\\n")');
  });
});

describe('bridgeFreshness', () => {
  let root: string;
  let project: string;
  let exe: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'bridge-freshness-'));
    project = join(root, 'bridge', 'D365MetadataBridge');
    fs.mkdirSync(join(project, 'Services'), { recursive: true });
    fs.writeFileSync(join(project, 'D365MetadataBridge.csproj'), '<Project />\n');
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A {}\n');
    // Wherever the build put it: bin/Release in a checkout, the data
    // directory for an npm install. The stamp sits next to the binary either way.
    const out = join(root, 'data', 'bridge');
    fs.mkdirSync(out, { recursive: true });
    exe = join(out, 'D365MetadataBridge.exe');
    fs.writeFileSync(exe, '');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeStamp = (body: string) => fs.writeFileSync(join(root, 'data', 'bridge', SOURCE_STAMP_FILE), body);
  const stamp = (sourceHash: string) => writeStamp(JSON.stringify({ sourceHash, sourceFileCount: 2, builtAt: '2026-10-15T00:00:00Z' }));

  it('is current when the stamp matches the sources', () => {
    stamp(hashBridgeSources(project, root));
    expect(bridgeFreshness(exe, project, root)).toBe('current');
  });

  it('is stale when a source changed after the build', () => {
    stamp(hashBridgeSources(project, root));
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A { int x; }\n');
    expect(bridgeFreshness(exe, project, root)).toBe('stale');
  });

  it('is stale when a source file was added', () => {
    stamp(hashBridgeSources(project, root));
    fs.writeFileSync(join(project, 'Services', 'B.cs'), 'class B {}\n');
    expect(bridgeFreshness(exe, project, root)).toBe('stale');
  });

  it('ignores build output and line-ending churn', () => {
    stamp(hashBridgeSources(project, root));
    fs.mkdirSync(join(project, 'obj'), { recursive: true });
    fs.writeFileSync(join(project, 'obj', 'Generated.cs'), 'class G {}\n');
    fs.writeFileSync(join(project, 'Services', 'A.cs'), 'class A {}\r\n');
    expect(bridgeFreshness(exe, project, root)).toBe('current');
  });

  it('is unstamped for a bridge built before stamping existed', () => {
    expect(bridgeFreshness(exe, project, root)).toBe('unstamped');
  });

  it('is unstamped, not stale, for a stamp it cannot read', () => {
    writeStamp('{ not json');
    expect(bridgeFreshness(exe, project, root)).toBe('unstamped');
    writeStamp(JSON.stringify({ sourceHash: '' }));
    expect(bridgeFreshness(exe, project, root)).toBe('unstamped');
  });

  it('is missing when there is no binary, whatever the stamp says', () => {
    stamp(hashBridgeSources(project, root));
    fs.rmSync(exe);
    expect(bridgeFreshness(exe, project, root)).toBe('missing');
  });
});

describe('doctor — built bridge', () => {
  const exe = 'C:\\data\\bridge\\D365MetadataBridge.exe';

  it('warns with the rebuild command when the bridge is older than its sources', () => {
    const result = checkBuiltBridge(exe, 'stale', 'dotnet build "x.csproj" -c Release');
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('older sources');
    expect(result.fix).toContain('dotnet build "x.csproj" -c Release');
    // The running server locks the exe; a rebuild without stopping it fails.
    expect(result.fix).toContain('stop the MCP server');
  });

  it('does not claim a match it cannot check', () => {
    const result = checkBuiltBridge(exe, 'unstamped', 'cmd');
    expect(result.severity).toBe('info');
    expect(result.message).toContain('unknown');
    expect(result.fix).toContain('cmd');
  });

  it('says so when the bridge matches its sources', () => {
    const result = checkBuiltBridge(exe, 'current', 'cmd');
    expect(result.severity).toBe('ok');
    expect(result.message).toContain('current sources');
    expect(result.fix).toBeUndefined();
  });
});
