/**
 * Release version computation (scripts/compute-version.ts).
 *
 * The load-bearing case: promoting a tested beta to production must cut the
 * stable version that matches the beta LINE (v1.0.0-beta.53 → v1.0.0), not an
 * unrelated auto-increment of stale early stable tags (v0.0.4 → v0.0.5). This
 * is what the manual "promote to production" workflow relies on.
 */
import { describe, test, expect } from 'bun:test';
import { computeNextVersion, parse, cmp } from '../scripts/compute-version';

describe('computeNextVersion — stable channel', () => {
  test('promoting a beta line cuts that line\'s stable, not a stale v0.0.x bump', () => {
    // Real repo state at the time of the promote-workflow work: betas ran the
    // 1.0.0 line while stable was still stuck on early v0.0.x test tags.
    const tags = [
      'v0.0.1', 'v0.0.2', 'v0.0.3', 'v0.0.4',
      'v1.0.0-beta.52', 'v1.0.0-beta.53',
    ];
    expect(computeNextVersion('stable', tags, '0.0.1')).toBe('v1.0.0');
  });

  test('re-cutting stable off a continued beta line bumps the patch', () => {
    // v1.0.0 already shipped; more 1.0.0 betas landed; promote again → v1.0.1.
    const tags = ['v0.0.4', 'v1.0.0', 'v1.0.0-beta.53', 'v1.0.0-beta.60'];
    expect(computeNextVersion('stable', tags, '0.0.1')).toBe('v1.0.1');
  });

  test('a bumped beta base carries the next stable to that base', () => {
    const tags = ['v1.0.0', 'v1.1.0-beta.1', 'v1.1.0-beta.2'];
    expect(computeNextVersion('stable', tags, '0.0.1')).toBe('v1.1.0');
  });

  test('package.json floor still wins when it declares a higher base', () => {
    const tags = ['v0.0.4', 'v1.0.0-beta.53'];
    expect(computeNextVersion('stable', tags, '2.0.0')).toBe('v2.0.0');
  });

  test('no beta tags: plain stable auto-increment', () => {
    expect(computeNextVersion('stable', ['v1.2.3'], '0.0.1')).toBe('v1.2.4');
  });

  test('no tags at all: falls back to the package.json floor', () => {
    expect(computeNextVersion('stable', [], '0.0.1')).toBe('v0.0.1');
  });

  test('result must be strictly greater than every existing stable tag', () => {
    // pkg floor below existing stable AND no higher beta base → cannot advance.
    expect(() => computeNextVersion('stable', ['v5.0.0'], '0.0.1')).not.toThrow();
    expect(computeNextVersion('stable', ['v5.0.0'], '0.0.1')).toBe('v5.0.1');
  });
});

describe('computeNextVersion — beta channel (unchanged behavior)', () => {
  test('increments the highest beta on the same base', () => {
    expect(computeNextVersion('beta', ['v1.0.0-beta.53'], '0.0.1')).toBe(
      'v1.0.0-beta.54',
    );
  });

  test('first beta on a base declared by package.json', () => {
    expect(computeNextVersion('beta', [], '1.0.0')).toBe('v1.0.0-beta.1');
  });

  test('a higher package.json base starts a fresh beta line at .1', () => {
    expect(computeNextVersion('beta', ['v1.0.0-beta.53'], '1.1.0')).toBe(
      'v1.1.0-beta.1',
    );
  });

  test('stable tags do not affect the beta count', () => {
    expect(
      computeNextVersion('beta', ['v1.0.0', 'v1.0.0-beta.9'], '0.0.1'),
    ).toBe('v1.0.0-beta.10');
  });
});

describe('parse/cmp helpers', () => {
  test('parse rejects malformed tags', () => {
    expect(parse('nope')).toBeNull();
    expect(parse('v1.2')).toBeNull();
    expect(parse('v1.2.3-alpha.1')).toBeNull();
  });

  test('cmp orders a stable above its prerelease', () => {
    expect(cmp(parse('v1.0.0')!, parse('v1.0.0-beta.9')!)).toBeGreaterThan(0);
  });
});
