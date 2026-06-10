/**
 * provenanceStore tests — grounding tokens, TTL, object binding, enforcement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createProvenanceToken,
  getProvenanceBundle,
  isValidToken,
  tokenMatchesTarget,
  enforceGrounding,
} from '../../src/utils/provenanceStore';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) delete process.env.GROUNDING_ENFORCE;
  else process.env.GROUNDING_ENFORCE = ORIGINAL_ENFORCE;
  vi.useRealTimers();
});

// ─── Token lifecycle ─────────────────────────────────────────────────────────

describe('createProvenanceToken / isValidToken', () => {
  it('creates a 32-char hex token that validates', () => {
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidToken(token)).toBe(true);
  });

  it('stores the full context in the bundle', () => {
    const token = createProvenanceToken({
      goal: 'test',
      objectName: 'CustTable',
      methodName: 'validateWrite',
      proposedName: 'CustTableContoso_Extension',
    });
    const bundle = getProvenanceBundle(token);
    expect(bundle?.context.objectName).toBe('CustTable');
    expect(bundle?.context.proposedName).toBe('CustTableContoso_Extension');
  });

  it('rejects an unknown token', () => {
    expect(isValidToken('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  it('expires tokens after 30 minutes', () => {
    vi.useFakeTimers();
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(isValidToken(token)).toBe(true);
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(isValidToken(token)).toBe(false);
  });
});

// ─── Object binding ──────────────────────────────────────────────────────────

describe('tokenMatchesTarget', () => {
  const bundleFor = (objectName: string, proposedName?: string) => {
    const token = createProvenanceToken({ goal: 'test', objectName, proposedName });
    return getProvenanceBundle(token)!;
  };

  it('matches exact object name (case-insensitive)', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'custtable')).toBe(true);
  });

  it('matches extension element name embedding the base object', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'CustTable.ContosoExtension')).toBe(true);
  });

  it('matches extension class name embedding the base object', () => {
    expect(tokenMatchesTarget(bundleFor('SalesFormLetter'), 'SalesFormLetterContoso_Extension')).toBe(true);
  });

  it('matches the proposedName recorded by prepare_change', () => {
    expect(tokenMatchesTarget(
      bundleFor('CustTable', 'ContosoCustHelper'),
      'ContosoCustHelper',
    )).toBe(true);
  });

  it('rejects a different object', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'SalesTable.ContosoExtension')).toBe(false);
  });

  it('does not substring-match very short names', () => {
    expect(tokenMatchesTarget(bundleFor('Tax'), 'TaxWithholdContoso_Extension')).toBe(false);
    expect(tokenMatchesTarget(bundleFor('Tax'), 'Tax')).toBe(true);
  });
});

// ─── Enforcement ─────────────────────────────────────────────────────────────

describe('enforceGrounding', () => {
  it('passes when GROUNDING_ENFORCE is not set', () => {
    delete process.env.GROUNDING_ENFORCE;
    expect(enforceGrounding(undefined, 'op')).toBeNull();
  });

  it('fails closed without a token when GROUNDING_ENFORCE=true', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = enforceGrounding(undefined, 'create_d365fo_file(...)');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('prepare_change');
  });

  it('fails with an invalid token', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = enforceGrounding('deadbeefdeadbeefdeadbeefdeadbeef', 'op');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('expired or is invalid');
  });

  it('passes with a valid token and matching target', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(enforceGrounding(token, 'op', 'CustTable.ContosoExtension')).toBeNull();
  });

  it('rejects a valid token used on a different object', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    const result = enforceGrounding(token, 'op', 'SalesTable.ContosoExtension');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('token mismatch');
    expect(result?.content[0].text).toContain('SalesTable.ContosoExtension');
  });

  it('passes with a valid token when no target is supplied (backward compatible)', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(enforceGrounding(token, 'op')).toBeNull();
  });
});

// ─── Hybrid-deployment guard ─────────────────────────────────────────────────
// In write-only mode prepare_change is not exposed and tokens live in the
// read-only instance's memory — enforcement would dead-loop the agent between
// the two servers, so it must be bypassed (with a stderr warning).

describe('enforceGrounding in write-only server mode', () => {
  afterEach(() => {
    vi.doUnmock('../../src/server/serverMode');
    vi.resetModules();
  });

  it('bypasses enforcement even without a token', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    vi.resetModules();
    vi.doMock('../../src/server/serverMode', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/server/serverMode')>()),
      SERVER_MODE: 'write-only' as const,
    }));
    const { enforceGrounding: enforceWriteOnly } = await import('../../src/utils/provenanceStore');
    expect(enforceWriteOnly(undefined, 'create_d365fo_file(...)')).toBeNull();
    expect(enforceWriteOnly('deadbeefdeadbeefdeadbeefdeadbeef', 'op')).toBeNull();
  });
});
