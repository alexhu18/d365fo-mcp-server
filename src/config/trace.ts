/**
 * Configuration of the optional ETW trace tool, shared by publication and the tool itself.
 *
 * The output folder has three sources, in order: trace.outputDir from the config, the folder the
 * user chose the first time a capture needed one (remembered in a small state file beside the
 * index, because the server never writes the config — only the CLI does), and nothing, in which
 * case the tool proposes drives with free space instead of starting.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface TraceConfig {
  outputDir?: string;
  /** Where outputDir came from, for the tool's reply. */
  outputDirSource?: 'config' | 'remembered';
  maxSeconds: number;
  maxSizeMB: number;
}

const yes = (value?: string) => /^(true|1|yes|on)$/i.test(value?.trim() ?? '');

export function isTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return yes(env.D365FO_TRACE_ENABLED);
}

/** Directory for this installation's tool state: beside the index database, else the user profile. */
export function traceStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const db = env.DB_PATH?.trim();
  return db ? dirname(resolve(db)) : join(homedir(), '.d365fo-mcp');
}

const rememberedFile = (env: NodeJS.ProcessEnv) => join(traceStateDir(env), 'trace-settings.json');

export function readRememberedOutputDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(rememberedFile(env), 'utf-8'))?.outputDir;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function rememberOutputDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = rememberedFile(env);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ outputDir: dir, savedAt: new Date().toISOString() }, null, 2)}\n`);
  return file;
}

export function resolveTraceConfig(env: NodeJS.ProcessEnv = process.env): TraceConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
    return value;
  };
  const configured = env.D365FO_TRACE_DIR?.trim();
  const remembered = configured ? undefined : readRememberedOutputDir(env);
  return {
    outputDir: configured || remembered,
    outputDirSource: configured ? 'config' : remembered ? 'remembered' : undefined,
    maxSeconds: integer('D365FO_TRACE_MAX_SECONDS', 120, 10, 900),
    maxSizeMB: integer('D365FO_TRACE_MAX_SIZE_MB', 4096, 100, 20000),
  };
}
