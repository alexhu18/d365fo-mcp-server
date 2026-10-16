/**
 * Whether `update` offers to rebuild the C# bridge.
 *
 * The bridge binary lives inside the package, and `npm install -g
 * d365fo-mcp@latest` replaces the package directory wholesale — so an npm-mode
 * update deletes the only write path the server has. The decision therefore
 * cannot be made from the state after the update alone: the exe is always
 * missing by then, which reads identically to "this install never built one"
 * and skips the rebuild. A server that could write before the update would
 * come back read-only, with nothing said about it.
 *
 * Hence two inputs, one sampled on each side of the update. The one after it
 * is not just "does the exe exist": a binary that survived may have been built
 * from older sources than the update brought (#1115).
 */
import { describe, it, expect } from 'vitest';
import { bridgeAction } from '../../src/cli/commands/update.js';

describe('bridgeAction', () => {
  it('does nothing when this install never had a bridge', () => {
    // Read-only, hybrid and azure-client setups: no dotnet, nothing to rebuild.
    expect(bridgeAction(false, 'missing')).toBe('none');
  });

  it('offers an optional rebuild when the bridge survived and matches its sources', () => {
    // Nothing in the update touched the bridge: rebuilding is only for a
    // D365FO platform upgrade, which keeps its own prompt.
    expect(bridgeAction(true, 'current')).toBe('optional');
  });

  it('requires a rebuild when the update removed a bridge that was there', () => {
    // The npm case, and the regression this guards: judged on the after-state
    // alone this is indistinguishable from 'none'.
    expect(bridgeAction(true, 'missing')).toBe('required');
  });

  it('requires a rebuild when the bridge survived but its sources moved', () => {
    // #1115: `git pull` leaves bin/Release alone and `npm install -g` leaves the
    // data directory alone, so the old binary is still there — and still old.
    expect(bridgeAction(true, 'stale')).toBe('stale');
  });

  it('requires one rebuild when the bridge predates the source stamp', () => {
    // Which sources it has is unknown; rebuilding once writes the stamp.
    expect(bridgeAction(true, 'unstamped')).toBe('unstamped');
  });

  it('does not invent work when a bridge appears from nowhere', () => {
    // Not reachable through the update flow, but the answer should still be
    // "leave it alone" rather than a rebuild prompt for something untouched.
    for (const now of ['current', 'stale', 'unstamped'] as const) expect(bridgeAction(false, now)).toBe('none');
  });
});
