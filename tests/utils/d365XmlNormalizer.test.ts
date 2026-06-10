/**
 * Unit tests for normalizeD365Xml()
 *
 * Verifies the three invariants of Microsoft's canonical D365FO XML shape:
 *   1. No UTF-8 BOM
 *   2. CRLF line endings (never bare LF)
 *   3. No trailing newline
 *
 * Test scenarios match the four cases described in the PR:
 *   A. LF + trailing newline   → CRLF, no trailing newline
 *   B. With BOM                → BOM stripped
 *   C. Mixed CRLF/LF           → all CRLF (no CRCRLF double-CR expansion)
 *   D. Already canonical       → idempotent (no change)
 *
 * Plus edge cases: empty string, only-BOM, multiple trailing newlines,
 * BOM in middle of content, compound inputs.
 */

import { describe, it, expect } from 'vitest';
import { normalizeD365Xml } from '../../src/utils/d365XmlNormalizer';

const BOM = '\uFEFF'; // U+FEFF ZERO WIDTH NO-BREAK SPACE / UTF-8 BOM

// ── helper: assert canonical invariants ─────────────────────────────────────
function assertCanonical(result: string, label: string): void {
  expect(result.charCodeAt(0), `${label}: must not start with BOM`).not.toBe(0xFEFF);
  expect(result.includes('\r\n') || !result.includes('\n') || result === '',
    `${label}: if result has LF it must be preceded by CR`).toBe(true);
  const bareLineFeed = /(?<!\r)\n/.test(result);
  expect(bareLineFeed, `${label}: must have no bare LF`).toBe(false);
  expect(result.endsWith('\r\n') || result.endsWith('\n'),
    `${label}: must not end with newline`).toBe(false);
}

describe('normalizeD365Xml', () => {

  // ── EOL normalization ──────────────────────────────────────────────────
  describe('EOL normalization', () => {
    it('converts bare LF to CRLF (scenario A)', () => {
      const result = normalizeD365Xml('line1\nline2\nline3');
      expect(result).toBe('line1\r\nline2\r\nline3');
    });

    it('leaves existing CRLF unchanged', () => {
      const input = 'line1\r\nline2\r\nline3';
      expect(normalizeD365Xml(input)).toBe(input);
    });

    it('converts mixed CRLF/LF without producing double CR (scenario C)', () => {
      // Critically: \r\n must not become \r\r\n after the two-step replace
      const result = normalizeD365Xml('line1\r\nline2\nline3\r\nline4\n');
      expect(result).toBe('line1\r\nline2\r\nline3\r\nline4');
      expect(result).not.toContain('\r\r');
    });

    it('handles content with no line breaks at all', () => {
      const input = '<Name>MyTable</Name>';
      expect(normalizeD365Xml(input)).toBe(input);
    });
  });

  // ── BOM removal ────────────────────────────────────────────────────────
  describe('BOM removal', () => {
    it('strips a leading BOM from LF content (scenario B)', () => {
      const result = normalizeD365Xml(BOM + 'line1\nline2');
      expect(result).toBe('line1\r\nline2');
      expect(result.charCodeAt(0)).not.toBe(0xFEFF);
    });

    it('strips a leading BOM from already-CRLF content', () => {
      const result = normalizeD365Xml(BOM + 'line1\r\nline2');
      expect(result).toBe('line1\r\nline2');
    });

    it('does NOT strip a BOM that appears in the middle of content', () => {
      const input = 'abc' + BOM + 'def';
      expect(normalizeD365Xml(input)).toBe(input);
    });

    it('returns empty string when input is only a BOM', () => {
      expect(normalizeD365Xml(BOM)).toBe('');
    });
  });

  // ── Trailing newline removal ───────────────────────────────────────────
  describe('trailing newline removal', () => {
    it('strips a trailing LF', () => {
      const result = normalizeD365Xml('line1\nline2\n');
      expect(result).toBe('line1\r\nline2');
    });

    it('strips a trailing CRLF', () => {
      const result = normalizeD365Xml('line1\r\nline2\r\n');
      expect(result).toBe('line1\r\nline2');
    });

    it('strips only ONE trailing newline when multiple are present', () => {
      // Two LFs → two CRLFs → strip one → one CRLF remains
      const result = normalizeD365Xml('line1\n\n');
      expect(result).toBe('line1\r\n');
    });

    it('returns empty string for a single LF', () => {
      expect(normalizeD365Xml('\n')).toBe('');
    });

    it('returns empty string for a single CRLF', () => {
      expect(normalizeD365Xml('\r\n')).toBe('');
    });
  });

  // ── Idempotence (scenario D) ───────────────────────────────────────────
  describe('idempotence', () => {
    it('is idempotent on already-canonical plain text', () => {
      const canonical = 'line1\r\nline2\r\nline3';
      const once = normalizeD365Xml(canonical);
      const twice = normalizeD365Xml(once);
      expect(once).toBe(canonical);
      expect(twice).toBe(canonical);
    });

    it('is idempotent on a realistic AxTable XML snippet', () => {
      const xml =
        '<?xml version="1.0" encoding="utf-8"?>\r\n' +
        '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\r\n' +
        '\t<Name>CustPaymPropLine</Name>\r\n' +
        '\t<Label>@SYS12345</Label>\r\n' +
        '</AxTable>';
      expect(normalizeD365Xml(xml)).toBe(xml);
      expect(normalizeD365Xml(normalizeD365Xml(xml))).toBe(xml);
    });
  });

  // ── Compound scenarios ─────────────────────────────────────────────────
  describe('compound scenarios', () => {
    it('fixes BOM + LF + trailing newline all at once', () => {
      const input = BOM + '<?xml version="1.0" encoding="utf-8"?>\nline2\n';
      const result = normalizeD365Xml(input);
      expect(result).toBe('<?xml version="1.0" encoding="utf-8"?>\r\nline2');
      assertCanonical(result, 'BOM+LF+trailing');
    });

    it('fixes BOM + mixed EOL + trailing newline', () => {
      const input =
        BOM + '<AxClass>\r\n\t<Name>TestClass</Name>\n\t<SourceCode/>\r\n</AxClass>\n';
      const result = normalizeD365Xml(input);
      expect(result).toBe(
        '<AxClass>\r\n\t<Name>TestClass</Name>\r\n\t<SourceCode/>\r\n</AxClass>',
      );
      assertCanonical(result, 'BOM+mixed+trailing');
    });

    it('handles empty string without throwing', () => {
      expect(() => normalizeD365Xml('')).not.toThrow();
      expect(normalizeD365Xml('')).toBe('');
    });
  });

  // ── Canonical invariant on all outputs ────────────────────────────────
  describe('canonical invariants hold for every case', () => {
    const cases: [string, string][] = [
      ['empty string',              ''],
      ['bare LF only',              '\n'],
      ['BOM only',                  BOM],
      ['LF lines + trailing LF',   'a\nb\n'],
      ['CRLF lines + trailing CRLF', 'a\r\nb\r\n'],
      ['mixed EOL, no BOM',        'a\r\nb\nc\n'],
      ['BOM + LF + trailing',      BOM + 'a\nb\n'],
      ['already canonical',        'a\r\nb'],
    ];

    for (const [label, input] of cases) {
      it(`canonical invariants hold for: ${label}`, () => {
        const result = normalizeD365Xml(input);
        assertCanonical(result, label);
      });
    }
  });
});
