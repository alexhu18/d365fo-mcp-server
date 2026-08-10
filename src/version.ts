/**
 * The package version, read from package.json.
 *
 * It used to be a literal repeated in four places — the CLI's `--version`, the
 * startup banner, the /health payload and the MCP server handshake — which
 * meant a release bump silently left some of them reporting the previous
 * version. Reading it once makes the version in package.json the only copy.
 *
 * `src/version.ts` and `dist/version.js` both sit one level below the package
 * root, so the same relative path works in the repo and in the published
 * package (`files: ["dist"]` keeps that layout).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const VERSION: string = (
  JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as { version: string }
).version;
