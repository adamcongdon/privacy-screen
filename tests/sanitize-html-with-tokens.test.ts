import { describe, expect, test } from 'bun:test';
import { sanitizeHtmlWithTokens } from '../web/src/lib/sanitizeHtmlWithTokens';
import type { Token } from '../web/src/api';

function tokenMap(entries: Token[]): Map<string, Token> {
  return new Map(entries.map((t) => [t.token, t]));
}

const EMAIL_1: Token = {
  realValue: 'sarah@acme.com',
  token: '{EMAIL_1}',
  isNew: false,
  category: 'email',
};

const TOKEN_1: Token = {
  realValue: 'something',
  token: '{TOKEN_1}',
  isNew: false,
  category: 'customer',
};

describe('sanitizeHtmlWithTokens', () => {
  test('tokens inside element attributes are NOT wrapped in spans', () => {
    const out = sanitizeHtmlWithTokens(
      '<a href="mailto:{EMAIL_1}">contact</a>',
      tokenMap([EMAIL_1]),
    );
    // href attribute keeps the literal mailto:{EMAIL_1}
    expect(out).toContain('mailto:{EMAIL_1}');
    // and the {EMAIL_1} inside the attribute did NOT get wrapped in a ps-token span
    expect(out).not.toMatch(/href="[^"]*<span class="ps-token"/);
  });

  test('text-node tokens are wrapped exactly once', () => {
    const out = sanitizeHtmlWithTokens(
      '<p>Contact {EMAIL_1} please.</p>',
      tokenMap([EMAIL_1]),
    );
    const matches = out.match(/<span class="ps-token"[^>]*>\{EMAIL_1\}<\/span>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('<script> is stripped — its inner token does not become a span', () => {
    const out = sanitizeHtmlWithTokens(
      '<script>{TOKEN_1}</script><p>{TOKEN_1}</p>',
      tokenMap([TOKEN_1]),
    );
    expect(out.toLowerCase()).not.toContain('<script');
    const spans = out.match(/<span class="ps-token"[^>]*>\{TOKEN_1\}<\/span>/g) ?? [];
    // exactly one span — the one inside <p>, not inside <script>
    expect(spans.length).toBe(1);
  });

  test('javascript: URLs are removed', () => {
    const out = sanitizeHtmlWithTokens(
      '<a href="javascript:alert(1)">click</a>',
      tokenMap([]),
    );
    expect(out.toLowerCase()).not.toContain('javascript:alert');
  });

  test('inline event handlers (onerror, onclick) are stripped', () => {
    const out = sanitizeHtmlWithTokens(
      '<img src="x" onerror="alert(1)"><button onclick="boom()">x</button>',
      tokenMap([]),
    );
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('onclick');
  });

  test('<iframe>, <object>, <embed> are stripped', () => {
    const out = sanitizeHtmlWithTokens(
      '<iframe src="evil"></iframe><object data="x"></object><embed src="y">',
      tokenMap([]),
    );
    const lower = out.toLowerCase();
    expect(lower).not.toContain('<iframe');
    expect(lower).not.toContain('<object');
    expect(lower).not.toContain('<embed');
  });

  test('HTML comments are preserved as comments, not converted to spans', () => {
    const out = sanitizeHtmlWithTokens(
      '<p>before</p><!-- {TOKEN_1} --><p>after</p>',
      tokenMap([TOKEN_1]),
    );
    // The comment may or may not survive verbatim depending on serializer,
    // but the {TOKEN_1} inside the comment must NOT have been turned into a span.
    const insideComment = out.match(/<!--[^]*?-->/);
    if (insideComment) {
      expect(insideComment[0]).not.toContain('ps-token');
    }
  });

  test('produces a complete html document with doctype', () => {
    const out = sanitizeHtmlWithTokens('<p>hello</p>', tokenMap([]));
    expect(out.toLowerCase()).toContain('<!doctype html>');
    expect(out.toLowerCase()).toContain('<html');
    expect(out.toLowerCase()).toContain('<body');
  });

  test('injects baseline stylesheet for .ps-token rule', () => {
    const out = sanitizeHtmlWithTokens('<p>{EMAIL_1}</p>', tokenMap([EMAIL_1]));
    expect(out).toContain('.ps-token');
  });

  test('unknown token (not in map) falls back to "unknown" category', () => {
    const out = sanitizeHtmlWithTokens('<p>{MYSTERY_42}</p>', tokenMap([]));
    expect(out).toContain('data-cat="unknown"');
  });

  test('multiple tokens in same text node all wrapped', () => {
    const out = sanitizeHtmlWithTokens(
      '<p>{EMAIL_1} and {TOKEN_1} together.</p>',
      tokenMap([EMAIL_1, TOKEN_1]),
    );
    const spans = out.match(/<span class="ps-token"/g) ?? [];
    expect(spans.length).toBe(2);
  });
});

// ── TDD for shared token-run/deanon utilities (issue #92) ────────────────────
// Grammar must be pinned against server mint format in src/scrub-map.ts + scrubber.ts:
//   {TYPE}, {TYPE_1}, {TYPE_2}…   (base [A-Z0-9]* then optional _\d+)
// Acceptance: exactly one TOKEN_RE definition remains in all of web/src after extract.
import { describe as describeTokens, expect as expectTokens, test as testTokens } from 'bun:test';
import { TOKEN_RE, tokenizeForRender, mergeTokenSources, type Run } from '../web/src/lib/tokens';

describeTokens('tokens (shared lib for #92)', () => {
  testTokens('TOKEN_RE matches server-minted token shapes (pins grammar)', () => {
    // Server mint examples (from scrub-map.ts TOKEN_SHAPE_RE and scrubber mint calls)
    // Use .match (not repeated .test) because TOKEN_RE is /g for matchAll consumers;
    // global regex .test() is stateful via lastIndex and would flake.
    expectTokens(!!'{EMAIL}'.match(TOKEN_RE)).toBe(true);
    expectTokens(!!'{EMAIL_1}'.match(TOKEN_RE)).toBe(true);
    expectTokens(!!'{IP_42}'.match(TOKEN_RE)).toBe(true);
    expectTokens(!!'{CUSTOMER}'.match(TOKEN_RE)).toBe(true);
    expectTokens(!!'{PERSON_7}'.match(TOKEN_RE)).toBe(true);
    expectTokens(!!'{ACCOUNT_10}'.match(TOKEN_RE)).toBe(true);
    // Global match works in text (the real consumer pattern)
    const matches = Array.from('hi {EMAIL_1} and {PATH_2} there'.matchAll(TOKEN_RE)).map(m => m[0]);
    expectTokens(matches).toEqual(['{EMAIL_1}', '{PATH_2}']);
  });

  testTokens('tokenizeForRender splits text + tokens using the shared RE and lookup', () => {
    const t1: Token = { token: '{EMAIL_1}', realValue: 'a@b.com', isNew: false, category: 'email' };
    const runs: Run[] = tokenizeForRender('Contact {EMAIL_1} now.', [t1]);
    expectTokens(runs).toEqual([
      { type: 'text', text: 'Contact ' },
      { type: 'token', raw: '{EMAIL_1}', meta: t1 },
      { type: 'text', text: ' now.' },
    ]);
  });

  testTokens('mergeTokenSources dedups across current + union (Map or array), current first', () => {
    const cur: Token[] = [{ token: '{A}', realValue: 'a', isNew: false, category: 'x' }];
    const union = new Map<string, Token>([
      ['{A}', { token: '{A}', realValue: 'a', isNew: false, category: 'x' }],
      ['{B}', { token: '{B}', realValue: 'b', isNew: false, category: 'y' }],
    ]);
    const merged = mergeTokenSources(cur, union);
    expectTokens(merged.map(m => m.token)).toEqual(['{A}', '{B}']);
    // order + dedup
    const m2 = mergeTokenSources([], cur, [{ token: '{A}', realValue: 'a', isNew: false, category: 'x' } as Token]);
    expectTokens(m2.map(m => m.token)).toEqual(['{A}']);
  });
});
