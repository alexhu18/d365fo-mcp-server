/**
 * property_stats tests — mined property distributions in the symbol index.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
});

afterAll(() => {
  index.close();
});

describe('recordPropertyStat / getPropertyPresenceRatio', () => {
  it('aggregates presence observations into a ratio', () => {
    for (let i = 0; i < 9; i++) index.recordPropertyStat('AxTable', 'Label', '(present)', 'ApplicationSuite');
    index.recordPropertyStat('AxTable', 'Label', '(absent)', 'ApplicationSuite');

    index.flushPropertyStats();
    const r = index.getPropertyPresenceRatio('AxTable', 'Label');
    expect(r.total).toBe(10);
    expect(r.present).toBe(9);
    expect(r.ratio).toBeCloseTo(0.9);
  });

  it('returns total=0 when no statistics exist', () => {
    const r = index.getPropertyPresenceRatio('AxForm', 'NeverMined');
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it('aggregates across models', () => {
    index.recordPropertyStat('AxView', 'Label', '(present)', 'ApplicationSuite');
    index.recordPropertyStat('AxView', 'Label', '(present)', 'ApplicationPlatform');
    index.flushPropertyStats();
    const r = index.getPropertyPresenceRatio('AxView', 'Label');
    expect(r.total).toBe(2);
    expect(r.present).toBe(2);
  });
});

describe('getPropertyValueDistribution', () => {
  it('returns values ordered by count, excluding presence markers', () => {
    for (let i = 0; i < 5; i++) index.recordPropertyStat('AxTable', 'TableGroup', 'Main', 'ApplicationSuite');
    for (let i = 0; i < 3; i++) index.recordPropertyStat('AxTable', 'TableGroup', 'Transaction', 'ApplicationSuite');
    index.recordPropertyStat('AxTable', 'TableGroup', 'Parameter', 'ApplicationSuite');
    index.recordPropertyStat('AxTable', 'TableGroup', '(absent)', 'ApplicationSuite');
    index.flushPropertyStats();

    const dist = index.getPropertyValueDistribution('AxTable', 'TableGroup');
    expect(dist[0]).toEqual({ value: 'Main', count: 5 });
    expect(dist[1]).toEqual({ value: 'Transaction', count: 3 });
    expect(dist.map(d => d.value)).not.toContain('(absent)');
  });
});

describe('clearModels removes property stats for the cleared model', () => {
  it('deletes per-model rows', () => {
    index.recordPropertyStat('AxQuery', 'Title', '(present)', 'ContosoModel');
    index.recordPropertyStat('AxQuery', 'Title', '(present)', 'ApplicationSuite');
    index.flushPropertyStats();
    index.clearModels(['ContosoModel']);
    const r = index.getPropertyPresenceRatio('AxQuery', 'Title');
    expect(r.total).toBe(1);
  });
});
