/**
 * Differential parity test for ScrubMap.apply() (#63).
 *
 * apply() was rewritten from a single longest-first alternation regex to a
 * prefix trie for performance. This test proves the rewrite is BEHAVIOUR-
 * PRESERVING: for many randomized vocabularies and inputs, the trie output must
 * be byte-identical to the original regex implementation (kept inline below as
 * the oracle). Because apply() is a PII-scrubbing security boundary, any
 * divergence — a missed match (leak) or an over-match (corruption) — is a hard
 * failure.
 *
 * The generator deliberately stresses the semantics that distinguish the two:
 *   - boundary adjacency (values touching word chars / punctuation / edges)
 *   - overlapping + nested values ("Acme" vs "Acme Corp")
 *   - mixed case (case-insensitive matching)
 *   - Unicode letters (accented names — the #60 case)
 *   - multi-word and punctuation-bearing values (emails, hostnames)
 */

import { describe, expect, test } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';

/**
 * The ORIGINAL apply() implementation, verbatim, as the reference oracle.
 * Builds a longest-first alternation regex and runs String.replace().
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function oracleApply(map: ScrubMap, text: string): string {
  // Reconstruct the lowercased real→token mapping from the public serialize().
  const realToToken = new Map<string, string>();
  for (const { token, real } of map.serialize().entries) {
    realToToken.set(real.toLowerCase(), token);
  }
  if (realToToken.size === 0) return text;

  const entries = [...realToToken.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  const pattern = entries
    .map(([k]) => `(?<![\\p{L}\\p{N}_])${escapeRegex(k)}(?![\\p{L}\\p{N}_])`)
    .join('|');
  const rx = new RegExp(pattern, 'giu');
  return text.replace(rx, (m) => realToToken.get(m.toLowerCase()) ?? m);
}

// Small deterministic PRNG (mulberry32) so failures reproduce.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUE_ATOMS = [
  'Acme',
  'Acme Corp',
  'Acme Corporation',
  'Bob',
  'Bob Loblaw',
  'server-host-1-prod',
  'server-host-12-prod',
  'user42@internal.example.local',
  'Zoë',
  'Zoë Müller',
  'José',
  'José Núñez',
  'André',
  '北京',
  'naïve',
  'O’Brien',
  'a',
  'ab',
  'abc',
];

const FILLER = [
  ' ',
  ', ',
  '\n',
  ' (',
  ') ',
  '; ',
  ' — ',
  '.',
  '@',
  '-',
  '_',
  'x',
  'see ',
  ' here ',
  'Cc: ',
  '',
];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomText(rng: () => number): string {
  const parts: string[] = [];
  const len = 1 + Math.floor(rng() * 14);
  for (let i = 0; i < len; i++) {
    parts.push(rng() < 0.55 ? pick(rng, VALUE_ATOMS) : pick(rng, FILLER));
  }
  return parts.join('');
}

describe('ScrubMap.apply() trie/regex parity (#63)', () => {
  test('trie output is byte-identical to the original regex across random cases', () => {
    let cases = 0;
    let replacements = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const map = new ScrubMap();

      // Random vocabulary: 1–10 distinct atoms minted as ITEM/PERSON/HOST.
      const vocabCount = 1 + Math.floor(rng() * 10);
      const used = new Set<string>();
      for (let v = 0; v < vocabCount; v++) {
        const real = pick(rng, VALUE_ATOMS);
        if (used.has(real)) continue;
        used.add(real);
        map.mint(pick(rng, ['ITEM', 'PERSON', 'HOST']), real);
      }

      // Several random inputs per vocabulary.
      for (let t = 0; t < 8; t++) {
        const text = randomText(rng);
        const expected = oracleApply(map, text);
        const actual = map.apply(text);
        if (actual !== expected) {
          throw new Error(
            `PARITY MISMATCH (seed=${seed}, t=${t})\n` +
              `vocab=${JSON.stringify([...used])}\n` +
              `input=${JSON.stringify(text)}\n` +
              `regex=${JSON.stringify(expected)}\n` +
              `trie =${JSON.stringify(actual)}`,
          );
        }
        expect(actual).toBe(expected);
        cases++;
        if (actual !== text) replacements++;
      }
    }
    // Sanity: the corpus actually exercised real substitutions (not all no-ops).
    expect(cases).toBeGreaterThan(2000);
    expect(replacements).toBeGreaterThan(200);
  });

  test('explicit boundary + longest-match cases match the oracle', () => {
    const map = new ScrubMap();
    map.mint('ITEM', 'Acme');
    map.mint('ITEM', 'Acme Corp');
    map.mint('PERSON', 'Zoë');
    const samples = [
      'Acme',
      'Acme Corp',
      'Acme Corporation', // longer key fails right-boundary → "Acme" wins
      'xAcme', // left-boundary blocked
      'Acmex', // right-boundary blocked
      'ACME corp', // case-insensitive, longest wins
      'Hello Zoë!',
      'Zoëzz', // boundary-blocked unicode
      'see Acme, then Acme Corp here',
    ];
    for (const s of samples) {
      expect(map.apply(s)).toBe(oracleApply(map, s));
    }
  });
});
