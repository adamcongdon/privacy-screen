/**
 * Pattern induction tests — deterministic regex induction from examples.
 * Tests run FIRST (TDD red phase) before any implementation exists.
 */

import { describe, test, expect } from 'bun:test';
import { induceRegex } from '../src/induction';

describe('induceRegex — basic induction', () => {
  test('induces INC-\\d{5} from three INC examples', () => {
    const result = induceRegex(['INC-12345', 'INC-99001', 'INC-00042']);
    expect(result).not.toBeNull();
    expect(result!.source).toBeInstanceOf(RegExp);
    // Should match INC-NNNNN pattern
    expect(result!.source.test('INC-12345')).toBe(true);
    expect(result!.source.test('INC-99001')).toBe(true);
    expect(result!.source.test('INC-00042')).toBe(true);
    // Regex source should encode the INC- literal and 5-digit group
    expect(result!.source.source).toContain('INC');
  });

  test('returns null below threshold of 3', () => {
    const result = induceRegex(['INC-12345', 'INC-99001']);
    expect(result).toBeNull();
  });

  test('returns null on divergent shapes INC-123 vs TKT-9999', () => {
    // Completely different prefixes — no common literal anchor long enough
    const result = induceRegex(['INC-12345', 'TKT-99999', 'REQ-00001']);
    expect(result).toBeNull();
  });

  test('returns null for low-specificity examples', () => {
    // Single chars — no literal content, specificity would be near 0
    const result = induceRegex(['a', 'b', 'c']);
    expect(result).toBeNull();
  });

  test('returns null when no common literal anchor (all-digit examples)', () => {
    // Pure digit sequences — no shared literal prefix/suffix → null
    const result = induceRegex(['12345', '99001', '00042'], { minSpecificity: 0.3 });
    expect(result).toBeNull();
  });

  test('anchors with \\b on word boundaries', () => {
    const result = induceRegex(['INC-12345', 'INC-99001', 'INC-00042']);
    expect(result).not.toBeNull();
    // Regex source should end with \b when skeleton ends with \w-class
    expect(result!.source.source).toContain('\\b');
  });

  test('omits \\b when skeleton starts with non-word char', () => {
    const result = induceRegex(['/path-123', '/path-456', '/path-789']);
    expect(result).not.toBeNull();
    // Starts with '/' which is non-word — no leading \b
    expect(result!.source.source).not.toMatch(/^\\\b/);
    // Should NOT start with \\b because '/' is non-word
    expect(result!.source.source.startsWith('\\b')).toBe(false);
  });

  test('falls back to common prefix+suffix when middle diverges', () => {
    // PREFIX-XXXX-SUFFIX where XXXX varies
    const result = induceRegex(['PREFIX-AAAA-SUFFIX', 'PREFIX-BBBB-SUFFIX', 'PREFIX-CCCC-SUFFIX']);
    expect(result).not.toBeNull();
    expect(result!.source.source).toContain('PREFIX');
    expect(result!.source.source).toContain('SUFFIX');
    // Should match all source examples
    expect(result!.source.test('PREFIX-AAAA-SUFFIX')).toBe(true);
    expect(result!.source.test('PREFIX-BBBB-SUFFIX')).toBe(true);
    expect(result!.source.test('PREFIX-CCCC-SUFFIX')).toBe(true);
  });

  test('aborts when no common literal anchor (no prefix no suffix)', () => {
    // Completely random strings with no shared prefix or suffix
    const result = induceRegex(['abc123', 'xyz789', 'qrs456']);
    expect(result).toBeNull();
  });

  test('enforces maxPatternLength=200', () => {
    // Examples that would produce a very long regex (long shared prefix/suffix).
    // 99 A-prefix + \d{1} + 99 Z-suffix + \b anchors = 203 chars > 200 limit.
    const longPrefix = 'A'.repeat(99);
    const longSuffix = 'Z'.repeat(99);
    const examples = [
      `${longPrefix}1${longSuffix}`,
      `${longPrefix}2${longSuffix}`,
      `${longPrefix}3${longSuffix}`,
    ];
    const result = induceRegex(examples, { maxPatternLength: 200 });
    // The resulting regex source would be very long — should be null
    expect(result).toBeNull();
  });

  test('computes coverage=1.0 over source examples', () => {
    const examples = ['INC-12345', 'INC-99001', 'INC-00042'];
    const result = induceRegex(examples);
    expect(result).not.toBeNull();
    expect(result!.coverage).toBe(1.0);
  });

  test('computes specificity >= 0.3 for valid output', () => {
    const result = induceRegex(['INC-12345', 'INC-99001', 'INC-00042']);
    expect(result).not.toBeNull();
    expect(result!.specificity).toBeGreaterThanOrEqual(0.3);
  });

  test('escapes regex metachars in literal separators', () => {
    // Version strings — period must be escaped in regex
    const result = induceRegex(['v1.0.0', 'v1.0.1', 'v1.0.2']);
    expect(result).not.toBeNull();
    // The period in v1.0. should appear as \. in the regex source (escaped)
    expect(result!.source.source).toContain('\\.');
    // And should NOT produce a false match on something like "v1X0X2"
    expect(result!.source.test('v1.0.0')).toBe(true);
  });

  test('min/max counts widen across examples', () => {
    // Upper letters: 2,3,4 chars; digits: 1,2,3 chars
    const result = induceRegex(['AB-1', 'ABC-12', 'ABCD-123']);
    expect(result).not.toBeNull();
    const src = result!.source.source;
    // Should contain a quantifier that spans the min/max range.
    // The aligned path uses token-level widening; the fallback path uses .{min,max}.
    // Either way a range quantifier must be present.
    expect(src).toMatch(/\{[0-9]+,[0-9]+\}/);
    // And all three source examples must match
    expect(result!.source.test('AB-1')).toBe(true);
    expect(result!.source.test('ABC-12')).toBe(true);
    expect(result!.source.test('ABCD-123')).toBe(true);
  });

  test('returns deterministic regex for same input in any order', () => {
    const examples = ['INC-12345', 'INC-99001', 'INC-00042'];
    const shuffled = ['INC-00042', 'INC-12345', 'INC-99001'];
    const r1 = induceRegex(examples);
    const r2 = induceRegex(shuffled);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.source.source).toBe(r2!.source.source);
  });

  test('coverage check: induced regex matches all source examples', () => {
    const examples = ['INC-12345', 'INC-99001', 'INC-00042'];
    const result = induceRegex(examples);
    expect(result).not.toBeNull();
    for (const ex of examples) {
      expect(result!.source.test(ex)).toBe(true);
    }
  });
});
