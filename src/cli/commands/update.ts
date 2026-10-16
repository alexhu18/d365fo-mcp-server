/**
 * `d365fo-mcp update [--yes]` — bring the installation to the latest release,
 * then optionally rebuild the C# bridge and the metadata index.
 *
 * How the code is refreshed depends on how it was installed: a checkout runs
 * the "Update" flow SETUP.md documents (git pull && npm install && npm run
 * build); an npm install reinstalls itself from the registry.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { bridgeFreshness, type BridgeFreshness } from '../bridgeSources.js';
import { DOTNET_MISSING, bridgeBuildCommand, installMode, isWindows, paths, repoRoot } from '../context.js';
import { commandExists, runExe, runShell } from '../exec.js';
import { listInstances } from '../instances.js';
import { checkRelease } from '../npmRegistry.js';
import { instanceTarget, rootTarget } from '../target.js';
import { askConfirm, p, requireFullInstall } from '../ui.js';
import { rebuildIndex } from './indexCmd.js';

/**
 * What to do about the C# bridge after the code has been refreshed.
 *
 * Both inputs are needed, and *when* they are sampled is the whole point.
 * `hadBridge` is taken before the update: judged on the after-state alone, a
 * bridge the update destroyed is indistinguishable from one that was never
 * built, and the difference is whether the server just lost its write path.
 * `now` is taken after it: an update that moved the bridge sources leaves the
 * binary in place, so whether it survived says nothing about whether it is
 * still the bridge this code expects (#1115).
 *
 *   none      — there was no bridge, so this install does not use writes
 *   optional  — the bridge survived and was built from these very sources;
 *               rebuilding is only for a D365FO platform upgrade
 *   required  — the update removed a bridge that was there, so the write path
 *               is gone until it is rebuilt
 *   stale     — the bridge survived but was built from older sources, so the
 *               new code would run against the old bridge
 *   unstamped — the bridge survived but records no sources (built before the
 *               stamp existed); one rebuild writes the stamp
 */
export type BridgeAction = 'none' | 'optional' | 'required' | 'stale' | 'unstamped';

export function bridgeAction(hadBridge: boolean, now: BridgeFreshness): BridgeAction {
  if (!hadBridge) return 'none';
  switch (now) {
    case 'missing': return 'required';
    case 'current': return 'optional';
    case 'stale': return 'stale';
    case 'unstamped': return 'unstamped';
  }
}

/** Why a rebuild is required, said before asking for it. */
const REQUIRED_BECAUSE: Record<Exclude<BridgeAction, 'none' | 'optional'>, string> = {
  required: 'The update replaced the package, so the C# bridge binary is gone — writes stay unavailable until it is rebuilt.',
  stale: 'The C# bridge was built from older sources than this version — the server would run the new code against the old bridge until it is rebuilt.',
  unstamped: 'The C# bridge records no sources (it was built before that record existed), so it may be older than this version — rebuild it once so updates can tell from now on.',
};

/**
 * Where `npm install -g` runs. Anywhere but the package itself.
 *
 * runShell defaults to repoRoot, which for an npm install IS the directory
 * npm is about to replace — and npm replaces it by renaming it aside first.
 * Windows refuses to rename a directory that any process has as its working
 * directory, so the shell and npm spawned there held the very lock that made
 * the rename fail with EBUSY/EPERM. The home directory is outside every
 * global prefix npm uses.
 */
export function globalInstallCwd(): string {
  return homedir();
}

export async function updateCommand(opts: { yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp update');
  if (!requireFullInstall()) return;

  // Say up front what the update is moving towards. A checkout tracks a branch
  // rather than the registry, so there the comparison is informational only —
  // being "ahead" of the latest release is the normal state on main.
  const release = await checkRelease();
  if (release.latest === null) {
    p.log.warn(`Running ${release.current} — npm registry unreachable, so this update runs blind.`);
  } else if (release.behind) {
    p.log.step(`Running ${release.current}; latest published release is ${release.latest}.`);
  } else {
    p.log.success(`Running ${release.current} — already the latest published release.`);
    if (installMode === 'npm' && !opts.yes && !await askConfirm('Reinstall anyway?', false)) {
      p.outro('Nothing to update.');
      return;
    }
  }

  // Sampled before the update rather than after. The bridge is built outside
  // the package now, so an update should leave it alone — but this is what
  // proves it did: if the binary was there before and is gone after, the
  // update destroyed the write path, and saying so beats reading the absence
  // as "this install never needed writes" and silently moving on.
  const hadBridge = isWindows && fs.existsSync(paths.bridgeExe);

  const steps: [string, () => Promise<number>][] = installMode === 'npm'
    ? [['npm install -g d365fo-mcp@latest', () => runShell('npm install -g d365fo-mcp@latest', { cwd: globalInstallCwd() })]]
    : [
      ['git pull', () => runExe('git', ['pull'])],
      ['npm install', () => runShell('npm install')],
      ['npm run build', () => runShell('npm run build')],
    ];
  for (const [label, run] of steps) {
    p.log.step(label);
    if (await run() !== 0) {
      p.log.error(`${label} failed — fix the error above and re-run.`);
      if (installMode === 'npm' && isWindows) {
        // The other thing that pins the package directory: a server still
        // running from it (VS Code / Visual Studio keep MCP servers alive) or
        // its bridge, when an older release built the bridge inside the package.
        p.log.info(`If npm reports EPERM/EBUSY on ${repoRoot}, close VS Code / Visual Studio (or stop the MCP server) and run the update again.`);
      }
      process.exitCode = 1;
      return;
    }
  }

  const action = bridgeAction(hadBridge, bridgeFreshness());
  if (action !== 'none') {
    const gone = action === 'required';
    const needed = action !== 'optional';
    if (needed) p.log.warn(REQUIRED_BECAUSE[action]);
    const rebuild = opts.yes || await askConfirm(
      gone
        ? 'Rebuild the C# bridge now? (required to restore writes)'
        : needed
          ? 'Rebuild the C# bridge now? (required — this version may have changed it)'
          : 'Rebuild the C# bridge (recommended after a D365FO version upgrade)?',
    );
    if (rebuild && !await commandExists('dotnet')) {
      p.log.warn(DOTNET_MISSING);
    } else if (rebuild) {
      // Same output directory the wizard used, or the rebuild would land in
      // the package and the configured bridge.exePath would still point at
      // the old binary outside it.
      const buildArgs = ['build', '-c', 'Release', ...(paths.bridgeOutDir ? ['-o', paths.bridgeOutDir] : [])];
      if (await runExe('dotnet', buildArgs, { cwd: paths.bridgeDir }) !== 0) {
        p.log.error(gone
          ? 'Bridge build failed — the server stays read-only until it succeeds.'
          : 'Bridge build failed — writes keep using the previous bridge binary. ' +
            'If a file is in use, stop the MCP server (VS Code / Visual Studio) and run the update again.');
        process.exitCode = 1;
        return;
      }
      p.log.success('C# bridge rebuilt.');
    } else if (gone) {
      // Declining is allowed, but it must not be quiet: the capability was
      // there before this command ran and is not there now.
      p.log.warn(`Skipped — the server runs read-only. Rebuild later with:\n   ${bridgeBuildCommand()}`);
    } else if (needed) {
      p.log.warn(`Skipped — the server keeps running the previous bridge binary. Rebuild later with:\n   ${bridgeBuildCommand()}`);
    }
  }

  if (!opts.yes && await askConfirm('Rebuild the metadata index too? (takes minutes to hours)', false)) {
    const instances = listInstances();
    const targets = instances.length > 0 ? instances.map(instanceTarget) : [rootTarget()];
    for (const target of targets) {
      if (!await rebuildIndex(target)) {
        process.exitCode = 1;
        return;
      }
    }
  }

  p.outro('Update complete.');
}
