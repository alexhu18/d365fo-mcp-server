import { describe, expect, it } from 'vitest';
import { listDrives } from '../../src/tools/sdlc/trace/capture.js';

const gb = (n: number) => ({ bavail: n * 2 ** 30, bsize: 1 });

describe('trace_d365fo listDrives', () => {
  it('probes off the event loop, one letter at a time, and skips what the budget leaves', async () => {
    let now = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const probed: string[] = [];
    const statfs = async (root: string) => {
      probed.push(root);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      // K: is a disconnected mapped drive: it costs the SMB timeout, then fails.
      if (root === 'K:\\') { now += 30_000; throw new Error('ETIMEDOUT'); }
      if (root === 'C:\\') return gb(40);
      throw new Error('ENOENT');
    };
    const { drives, skipped } = await listDrives({ statfs, clock: () => now, budgetMs: 2_000, letters: '' });
    expect(maxInFlight).toBe(1);
    expect(drives).toEqual([{ drive: 'C:\\', freeGB: 40 }]);
    // C and K were probed; every letter behind the dead drive was skipped and named, not waited for.
    expect(probed).toEqual(['C:\\', 'K:\\']);
    expect(skipped).toHaveLength(22);
    expect(skipped).not.toContain('C');
  });

  it('probes exactly the pinned letters, whatever they cost', async () => {
    let now = 0;
    const probed: string[] = [];
    const statfs = async (root: string) => { probed.push(root); now += 60_000; return gb(1); };
    const { drives, skipped } = await listDrives({ statfs, clock: () => now, letters: 'E, f:' });
    expect(probed).toEqual(['E:\\', 'F:\\']);
    expect(skipped).toEqual([]);
    expect(drives.map(d => d.drive)).toEqual(['E:\\', 'F:\\']);
  });
});
