/**
 * Vocab management routes.
 *   GET    /api/vocab            — list all vocab rows (?category=ip optional filter)
 *   POST   /api/vocab            — { realValue, token?, category? } add a customer name or other entry
 *   DELETE /api/vocab/:realValue — forget a vocab entry (also adds to allowlist)
 *   POST   /api/vocab/allowlist  — { pattern, isRegex } never-tokenize pattern
 */

import { Hono } from 'hono';
import { getVocab, getMap, resetVocab } from '../lib/vocab-store';
import { mkCredential } from '../../src/patterns';

export const vocabRoute = new Hono();

// Per-IP rate limit state: bucket of timestamps within the last window.
const RL_WINDOW_MS = 10_000;
const RL_MAX = 10;
const rlBuckets = new Map<string, number[]>();

function getClientIp(c: any): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  const env = c.env as any;
  const remote = env?.incoming?.socket?.remoteAddress;
  if (remote) return String(remote);
  return 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const bucket = rlBuckets.get(ip) ?? [];
  // Drop timestamps outside the window
  const fresh = bucket.filter((t) => t > cutoff);
  if (fresh.length >= RL_MAX) {
    rlBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  rlBuckets.set(ip, fresh);
  return false;
}

const CATEGORY_RE = /^[a-z][a-z0-9_]{0,15}$/;
const CONTROL_CHAR_RE = /[\x00-\x1f]/;

vocabRoute.get('/', (c) => {
  const category = c.req.query('category');
  const rows = getVocab().allVocab(category);
  return c.json({ rows });
});

vocabRoute.post('/', async (c) => {
  // Rate-limit first so abusive clients can't bypass via fast bursts.
  const ip = getClientIp(c);
  if (rateLimited(ip)) {
    return c.json({ error: 'rate limited' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const real = String(body.realValue ?? '').trim();
  const categoryRaw = String(body.category ?? 'customer');

  if (!real) return c.json({ error: 'realValue required' }, 400);
  if (real.length > 200) return c.json({ error: 'realValue too long' }, 400);
  if (CONTROL_CHAR_RE.test(real)) {
    return c.json({ error: 'control characters not allowed' }, 400);
  }
  if (!CATEGORY_RE.test(categoryRaw)) {
    return c.json({ error: 'invalid category' }, 400);
  }
  // Credential-shape guard: never let a secret slip into the vocab store.
  if (mkCredential().test(real)) {
    return c.json({ error: 'credential-shape rejected' }, 400);
  }

  const type = categoryRaw.toUpperCase();
  const map = getMap();
  const r = map.mint(type, real);
  getVocab().persistMint(real, r.token, categoryRaw, 1.0);
  return c.json({ realValue: real, token: r.token, isNew: r.isNew });
});

vocabRoute.delete('/:realValue', (c) => {
  const v = decodeURIComponent(c.req.param('realValue'));
  const ok = getVocab().forgetReal(v);
  if (ok) {
    // Also add to allowlist so future scrubs leave the value plain.
    getVocab().addAllowlist(v, false, 'forget-action: user clicked forget');
  }
  // Reset the cached ScrubMap so the deletion is reflected immediately
  resetVocab();
  return c.json({ ok });
});

vocabRoute.post('/allowlist', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pattern = String(body.pattern ?? '').trim();
  if (!pattern) return c.json({ error: 'pattern required' }, 400);
  getVocab().addAllowlist(pattern, !!body.isRegex, body.reason ?? null);
  resetVocab();
  return c.json({ ok: true });
});
