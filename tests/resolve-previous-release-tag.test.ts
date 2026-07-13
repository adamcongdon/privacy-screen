/**
 * Issue #49 — dynamic release notes: previous same-channel tag resolver.
 *
 * Reproduces the stale-base bug (always landing on an ancient prerelease /
 * stable tag) and pins correct newest-first channel filtering.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolvePreviousReleaseTag,
  parseReleaseListJson,
  stripAnsi,
  type ReleaseEntry,
} from '../scripts/resolve-previous-release-tag';

function releases(...entries: ReleaseEntry[]): ReleaseEntry[] {
  return entries;
}

describe('resolvePreviousReleaseTag (issue #49 - dynamic release notes)', () => {
  test('beta channel returns the most recent prior beta tag (not a stale base)', () => {
    // Newest-first list as returned by `gh release list`
    const list = releases(
      { tagName: 'v1.0.0-beta.10', isPrerelease: true },
      { tagName: 'v1.0.0-beta.9', isPrerelease: true },
      { tagName: 'v1.0.0-beta.5', isPrerelease: true },
      { tagName: 'v0.0.4', isPrerelease: false },
    );
    // When cutting beta.11, previous must be beta.10 — NOT beta.5
    expect(resolvePreviousReleaseTag(list, 'beta', 'v1.0.0-beta.11')).toBe(
      'v1.0.0-beta.10',
    );
  });

  test('stable channel returns the most recent non-prerelease tag', () => {
    const list = releases(
      { tagName: 'v1.0.0-beta.47', isPrerelease: true },
      { tagName: 'v1.0.0', isPrerelease: false },
      { tagName: 'v0.0.4', isPrerelease: false },
    );
    expect(resolvePreviousReleaseTag(list, 'stable', 'v1.0.1')).toBe('v1.0.0');
  });

  test('skips currentTag when re-running create for an existing release', () => {
    const list = releases(
      { tagName: 'v1.0.0-beta.47', isPrerelease: true },
      { tagName: 'v1.0.0-beta.46', isPrerelease: true },
    );
    expect(resolvePreviousReleaseTag(list, 'beta', 'v1.0.0-beta.47')).toBe(
      'v1.0.0-beta.46',
    );
  });

  test('empty list returns empty string (first release on channel)', () => {
    expect(resolvePreviousReleaseTag([], 'beta', 'v1.0.0-beta.1')).toBe('');
    expect(resolvePreviousReleaseTag([], 'stable', 'v1.0.0')).toBe('');
  });

  test('beta ignores stable-only history (no same-channel prior)', () => {
    const list = releases(
      { tagName: 'v1.0.0', isPrerelease: false },
      { tagName: 'v0.0.4', isPrerelease: false },
    );
    expect(resolvePreviousReleaseTag(list, 'beta', 'v1.0.0-beta.1')).toBe('');
  });

  test('stable ignores beta-only history', () => {
    const list = releases(
      { tagName: 'v1.0.0-beta.47', isPrerelease: true },
      { tagName: 'v1.0.0-beta.46', isPrerelease: true },
    );
    expect(resolvePreviousReleaseTag(list, 'stable', 'v1.0.0')).toBe('');
  });

  test('mixed list: beta does not fall through to stable', () => {
    const list = releases(
      { tagName: 'v1.0.0-beta.2', isPrerelease: true },
      { tagName: 'v1.0.0', isPrerelease: false },
      { tagName: 'v1.0.0-beta.1', isPrerelease: true },
    );
    expect(resolvePreviousReleaseTag(list, 'beta', 'v1.0.0-beta.3')).toBe(
      'v1.0.0-beta.2',
    );
  });

  test('parseReleaseListJson tolerates ANSI-colored gh output', () => {
    const colored =
      '\u001b[1;37m[\u001b[m\n  \u001b[1;37m{\u001b[m\n    \u001b[1;34m"isPrerelease"\u001b[m\u001b[1;37m:\u001b[m \u001b[33mtrue\u001b[m\u001b[1;37m,\u001b[m\n    \u001b[1;34m"tagName"\u001b[m\u001b[1;37m:\u001b[m \u001b[32m"v1.0.0-beta.47"\u001b[m\n  \u001b[1;37m}\u001b[m\n\u001b[1;37m]\u001b[m\n';
    const list = parseReleaseListJson(colored);
    expect(list).toEqual([{ isPrerelease: true, tagName: 'v1.0.0-beta.47' }]);
    expect(resolvePreviousReleaseTag(list, 'beta', 'v1.0.0-beta.48')).toBe(
      'v1.0.0-beta.47',
    );
  });

  test('stripAnsi leaves plain JSON unchanged', () => {
    const plain = '[{"tagName":"v1","isPrerelease":false}]';
    expect(stripAnsi(plain)).toBe(plain);
  });
});
