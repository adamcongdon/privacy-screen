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
  });

  return c.json({
    scrubbed: result.scrubbed,
    tokens: result.mintedTokens.map((t) => ({
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
