/**
 * Vocab management routes.
 *   GET    /api/vocab            — list all vocab rows (?category=ip optional filter)
 *   POST   /api/vocab            — { realValue, token?, category? } add a customer name or other entry
 *   DELETE /api/vocab/:realValue — forget a vocab entry
 *   POST   /api/vocab/allowlist  — { pattern, isRegex } never-tokenize pattern
 */

import { Hono } from 'hono';
import { getVocab, getMap, resetVocab } from '../lib/vocab-store';

export const vocabRoute = new Hono();

vocabRoute.get('/', (c) => {
  const category = c.req.query('category');
  const rows = getVocab().allVocab(category);
  return c.json({ rows });
});

vocabRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const real = String(body.realValue ?? '').trim();
  const type = (String(body.category ?? 'customer') || 'customer').toUpperCase();
  if (!real) return c.json({ error: 'realValue required' }, 400);

  const map = getMap();
  const r = map.mint(type, real);
  getVocab().persistMint(real, r.token, body.category ?? 'customer', 1.0);
  return c.json({ realValue: real, token: r.token, isNew: r.isNew });
});

vocabRoute.delete('/:realValue', (c) => {
  const v = decodeURIComponent(c.req.param('realValue'));
  const ok = getVocab().forgetReal(v);
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
