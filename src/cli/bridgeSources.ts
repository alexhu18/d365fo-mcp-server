/**
 * Whether the built C# bridge was compiled from the sources now on disk (#1115).
 *
 * An update can move the bridge sources and leave the built binary in place:
 * `npm install -g` replaces the package but not the build in the data
 * directory (paths.bridgeOutDir), and `git pull` never touches bin/Release.
 * The server then runs new TypeScript against an old bridge, and parts of the
 * adapter tolerate an older binary without a word. So the build records what
 * it compiled — the WriteBridgeSourceStamp target in D365MetadataBridge.csproj
 * writes D365MetadataBridge.sources.json next to the binary — and `update` and
 * `doctor` compare that stamp with the sources as they are now.
 *
 * The hash is the one scripts/bridgeAttest.mjs computes (same files, same
 * order, CRLF normalised), ported here because that script is not part of the
 * npm package; a test pins the two together.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { paths, repoRoot } from './context.js';

const SOURCE_EXTENSIONS = ['.cs', '.csproj'];
const SKIP_DIRS = new Set(['obj', 'bin']);
export const SOURCE_STAMP_FILE = 'D365MetadataBridge.sources.json';

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSources(join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.some(e => entry.name.endsWith(e))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Hash of the bridge compiler's inputs, identical to bridgeAttest.mjs's hashSources. */
export function hashBridgeSources(dir: string = paths.bridgeDir, root: string = repoRoot): string {
  const digest = createHash('sha256');
  for (const file of collectSources(dir).sort()) {
    const rel = relative(root, file).split(sep).join('/');
    const content = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    digest.update(`${rel}:${createHash('sha256').update(content).digest('hex')}\n`);
  }
  return digest.digest('hex');
}

/**
 *   missing    — no binary
 *   current    — the binary was built from exactly these sources
 *   stale      — the sources changed after the binary was built
 *   unstamped  — a binary without a readable stamp: built before stamping
 *                existed, so which sources it has is unknown
 */
export type BridgeFreshness = 'missing' | 'current' | 'stale' | 'unstamped';

export function bridgeFreshness(
  exePath: string = paths.bridgeExe,
  dir: string = paths.bridgeDir,
  root: string = repoRoot,
): BridgeFreshness {
  if (!fs.existsSync(exePath)) return 'missing';
  let sourceHash: unknown;
  try {
    sourceHash = (JSON.parse(fs.readFileSync(join(dirname(exePath), SOURCE_STAMP_FILE), 'utf-8')) as { sourceHash?: unknown }).sourceHash;
  } catch {
    return 'unstamped';
  }
  if (typeof sourceHash !== 'string' || sourceHash.length === 0) return 'unstamped';
  try {
    return sourceHash === hashBridgeSources(dir, root) ? 'current' : 'stale';
  } catch {
    // Sources unreadable: nothing to compare against, so claim nothing.
    return 'unstamped';
  }
}
