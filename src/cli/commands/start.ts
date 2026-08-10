/**
 * `d365fo-mcp start [instance]` — run the server in the foreground,
 * the TS counterpart of instances/run-instance.ps1. Started from a terminal
 * the server picks HTTP mode by itself (stdin is a TTY); stdio mode is what
 * IDE clients use when they spawn dist/index.js directly.
 */
import * as fs from 'node:fs';
import { settingByPath } from '../../config/settings.js';
import { isWindows, paths } from '../context.js';
import { runNode, runShell } from '../exec.js';
import { readSetting } from '../settingsStore.js';
import { pickTarget, targetEnv } from '../target.js';
import { askConfirm, p } from '../ui.js';
import { isXppConfigStale, xppConfigDir } from '../xppConfig.js';

export async function startCommand(instanceName: string | undefined): Promise<void> {
  p.intro('d365fo-mcp start');
  const target = await pickTarget(instanceName, 'Which server do you want to start?');

  if (!fs.existsSync(paths.distEntry)) {
    p.log.warn('dist/index.js not found — the server has not been built yet.');
    if (!await askConfirm('Build it now (npm run build)?')) {
      p.cancel('Aborted.');
      return;
    }
    if (await runShell('npm run build') !== 0) {
      p.log.error('Build failed.');
      process.exitCode = 1;
      return;
    }
  }

  // A pinned XPP config that no longer exists means the UDE was upgraded and the indexed database is stale.
  if (isWindows && isXppConfigStale(target.store)) {
    const configName = readSetting(target.store, settingByPath('environment.xppConfigName')!);
    p.log.warn(`Pinned XPP config '${configName}' does not match any file in ${xppConfigDir()}.\n` +
      `   The UDE may have been upgraded since ${target.label} was configured.\n` +
      `   Fix with: d365fo-mcp instance upgrade ${target.name}`);
    if (!await askConfirm('Continue anyway?', false)) {
      p.cancel('Aborted.');
      return;
    }
  }

  const port = target.port ?? readSetting(target.store, settingByPath('server.port')!) ?? 8080;
  p.log.step(`Starting ${target.label} — expected endpoint http://localhost:${port}/mcp (Ctrl+C stops it)`);

  const code = await runNode([paths.distEntry], { env: targetEnv(target) });
  if (code !== 0) {
    p.log.error(`Server exited with code ${code}`);
    process.exitCode = code;
  }
}
