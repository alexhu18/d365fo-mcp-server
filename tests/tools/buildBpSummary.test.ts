import { describe, expect, it } from 'vitest';
import { summarizeBpOutput } from '../../src/tools/sdlc/buildProject.js';
import { parseBpFindings } from '../../src/tools/sdlc/runBpCheck.js';

// build_d365fo_project is uncapped: a model-wide bpCheck on ~5,000 warnings put
// 2.7 MB into one build result. Past 12,000 characters the result carries this.
describe('summarizeBpOutput', () => {
  const finding = (i: number, rule = 'BPUpgradeCodeRecId') =>
    `${rule}: dynamics://Class/MyClass${i}/Method/run\nWarning AxClass [(1,1),(2,2)] Rule text ${i}`;
  const output = (body: string[], tally = '') =>
    ['⚠️ BP Check completed with issues', '', ...body, tally].join('\n');

  it('keeps the verdict, counts findings by rule and names where the full text is', () => {
    const body = [
      ...Array.from({ length: 30 }, (_, i) => finding(i)),
      ...Array.from({ length: 5 }, (_, i) => finding(100 + i, 'BPErrorEDTNotMigrated')),
    ];
    const text = output(body);
    const summary = summarizeBpOutput(text, parseBpFindings(text), 'K:\\logs\\build.log.bp.txt');
    expect(summary.split('\n')[0]).toBe('⚠️ BP Check completed with issues');
    expect(summary).toMatch(/30 × BPUpgradeCodeRecId/);
    expect(summary).toMatch(/5 × BPErrorEDTNotMigrated/);
    // Errors lead whatever their count: 5 errors outrank 30 warnings.
    expect(summary.indexOf('BPErrorEDTNotMigrated')).toBeLessThan(summary.indexOf('BPUpgradeCodeRecId'));
    expect(summary).toContain('saved to: K:\\logs\\build.log.bp.txt');
    expect(summary).toContain('run_bp_check');
    expect(summary.length).toBeLessThan(text.length);
  });

  it("leads with xppbp's own totals, which can exceed what the parser recognises", () => {
    const text = output(Array.from({ length: 3 }, (_, i) => finding(i)), 'Errors: 0\nWarnings: 5291');
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    expect(summary).toContain('xppbp totals: Errors 0, Warnings 5291.');
    expect(summary).toContain('Counted below: 3 finding(s) the parser recognises');
    expect(summary).not.toContain('saved to');
  });

  it('stays bounded however many rules and findings there are', () => {
    const body = Array.from({ length: 2_000 }, (_, i) => finding(i, `BPRule${i % 60}`));
    const text = output(body);
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    expect(summary).toContain('… and 35 more rule(s)');
    expect(summary).toContain('First 15 finding(s), errors first:');
    expect(summary.length).toBeLessThan(5_000);
  });

  // Ranked by count alone, one BP error among 30 busier warning rules fell past the
  // 25-rule cut and out of the 15-finding sample: the build result named it nowhere,
  // only "Errors 1" in the totals line.
  it('keeps an error finding in the summary however many warning rules outnumber it', () => {
    const body: string[] = [];
    for (let r = 0; r < 30; r++) {
      for (let i = 0; i < 20; i++) {
        body.push(`BestPractices Warning: AxClass dynamics://Class/C${r}x${i}/Method/run: [(6,5),(8,6)]: BPWarnRule${r}: No doc for C${r}.run.`);
      }
    }
    body.push('BestPractices Error: AxTable dynamics://Table/MyTable: [(1,1),(1,2)]: BPErrorTableNoPrimaryIndex: Table has no primary index.');
    const text = output(body, 'Errors: 1\nWarnings: 600');
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    const byRule = summary.slice(summary.indexOf('Findings by rule:'), summary.indexOf('First '));
    expect(byRule.split('\n')[1]).toBe('  1 × BPErrorTableNoPrimaryIndex (Error)');
    const sample = summary.slice(summary.indexOf('First '));
    expect(sample.split('\n')[1]).toBe('  • BPErrorTableNoPrimaryIndex: dynamics://Table/MyTable');
  });

  it("keeps run_bp_check's label-compile caveat, which qualifies the findings", () => {
    const caveat = '⚠️ Labels could not be compiled (labelc.exe not found) — any BPErrorUnknownLabel below may be an artefact of that, not of the source.';
    const text = ['⚠️ BP Check completed with issues', '', 'Model: M', caveat, '', finding(1)].join('\n');
    expect(summarizeBpOutput(text, parseBpFindings(text))).toContain(caveat);
  });
});
