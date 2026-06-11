/**
 * POST /api/scrub — preview-only scrub.
 *
 * Body: { text: string, persist?: boolean }
 * - persist=true (default) — newly minted tokens are written to vocab.db
 * - persist=false — pure preview, no side effects (used by debounced UI typing)
 *
 * Response: { scrubbed, tokens: [{realValue, token, isNew, category}], unsureSpans, hasCredentials, credentialSnippets }
 */

import { Hono } from 'hono';
import { scrubText } from '../../src/scrubber';
import { getVocab, getMap } from '../lib/vocab-store';
import { loadConfig } from '../../src/config';

export const scrubRoute = new Hono();

scrubRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text : '';
  const persist = body.persist !== false; // default true
  const userPatterns: Array<{ text: string; cat: string }> = Array.isArray(body.patterns)
    ? body.patterns.filter((p: any) => p && typeof p.text === 'string' && typeof p.cat === 'string')
    : [];

  if (!text) {
    return c.json({
      scrubbed: '',
      tokens: [],
      unsureSpans: [],
      hasCredentials: false,
      credentialSnippets: [],
      modified: false,
    });
  }

  const cfg = loadConfig();
  const map = getMap();
  const vocab = persist ? getVocab() : null;

  const result = scrubText(text, map, vocab, {
    sourceEvent: 'app:preview',
    config: cfg,
    userPatterns,
  });

  // Enrich: scan scrubbed output for {TOKEN} patterns not captured by mintedTokens
  // (pre-minted customer/person names use mintAndPersist for guards but intentionally do not
  // appear in the per-scrub mintedTokens list returned to caller).
  // Guard: only enrich tokens that were NOT present in the original input — tokens already
  // in the caller's text must not be resolved to realValues (vocab enumeration oracle).
  const tokensInOriginal = new Set([...result.original.matchAll(/\{[A-Z][A-Z0-9_]*\}/g)].map((m) => m[0]));
  const tokenMap = new Map(result.mintedTokens.map((t) => [t.token, t]));
  const enrichVocab = getVocab();
  for (const m of result.scrubbed.matchAll(/\{[A-Z][A-Z0-9_]*\}/g)) {
    const tok = m[0];
    if (tokenMap.has(tok)) continue;
    if (tokensInOriginal.has(tok)) continue;
    const realValue = map.realFor(tok);
    if (!realValue) continue;
    const row = enrichVocab.findByToken(tok);
    const category = row?.category ?? inferCategoryFromToken(tok);
    tokenMap.set(tok, { type: category.toUpperCase(), realValue, token: tok, isNew: false, category, confidence: row?.confidence ?? 1.0 });
  }

  return c.json({
    scrubbed: result.scrubbed,
    tokens: [...tokenMap.values()].map((t) => ({
      realValue: t.realValue,
      token: t.token,
      isNew: t.isNew,
      category: t.category,
      confidence: t.confidence,
    })),
    unsureSpans: result.unsureSpans,
    hasCredentials: result.hasCredentials,
    credentialSnippets: result.credentialSnippets,
    modified: result.modified,
  });
});

// Maps token-type prefixes to category names. Fallback for when the DB row is unavailable
// (e.g. persist=false and the token was pre-minted from config this request).
const TOKEN_PREFIX_CATEGORY: Record<string, string> = {
  CUSTOMER: 'customer',
  PERSON: 'person',
  IP: 'ip',
  EMAIL: 'email',
  HOST: 'fqdn',
  PATH: 'path',
  USER: 'domain_user',
  MAC: 'mac',
  GUID: 'guid',
  PHONE: 'phone',
  ADDR: 'address',
  ACCOUNT: 'account_number',
  URL: 'url',
  SERVER: 'fqdn',
};

function inferCategoryFromToken(token: string): string {
  const m = token.match(/^\{([A-Z][A-Z0-9]*)(?:_\d+)?\}$/);
  if (!m) return 'unknown';
  return TOKEN_PREFIX_CATEGORY[m[1]] ?? m[1].toLowerCase();
}
