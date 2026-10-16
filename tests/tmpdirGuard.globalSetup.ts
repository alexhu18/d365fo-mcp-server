/**
 * Plants the os.tmpdir() canary that tests/setup.ts checks after every test file.
 *
 * A test once cleaned up with `fs.rm(path.dirname(dir), { recursive: true })`
 * where `dir` was the mkdtemp folder itself, so the parent was os.tmpdir(): every
 * run deleted the developer's whole %TEMP% (other tools' scratch files, open logs)
 * and the suite stayed green, because the errors on locked files were swallowed.
 * Nothing about a single test's own assertions can see that, so the shared
 * directory is watched from outside every test.
 *
 * The canary is a plain file in os.tmpdir() — only a deletion of os.tmpdir()
 * itself (or a sweep of its files) reaches it; a test removing its own mkdtemp
 * folder never does. The name carries the pid so concurrent runs don't collide.
 *
 * The CHECK lives in tests/setup.ts, not in the teardown returned here: vitest
 * reports a teardown error as "error during close" and still exits 0, so a check
 * here would be seen by nobody in CI. A failing afterAll fails the test file —
 * and names the file that was running when the canary went.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const TMPDIR_CANARY_ENV = 'D365FO_TEST_TMPDIR_CANARY';

export default function setup(): () => void {
  const canary = path.join(os.tmpdir(), `d365fo-mcp-test-tmpdir-canary-${process.pid}.txt`);
  fs.writeFileSync(canary, 'Deleted during a test run? A test removed files directly in os.tmpdir().\n');
  // Set before the workers start, so every worker inherits it.
  process.env[TMPDIR_CANARY_ENV] = canary;

  return () => {
    fs.rmSync(canary, { force: true });
  };
}
