/**
 * Review queue routes — heuristic detection triage.
 *   GET  /api/review           — pending items
 *   POST /api/review/:id       — { action: 'confirm' | 'allowlist' | 'ignore', type?: 'CUSTOMER' }
 */

import { Hono } from 'hono';
import { getVocab, getMap, resetVocab } from '../lib/vocab-store';

export const reviewRoute = new Hono();

reviewRoute.get('/', (c) => {
  const items = getVocab().pendingReview();
  return c.json({ items });
});

reviewRoute.post('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  const v = getVocab();
  const map = getMap();

  const item = v.pendingReview().find((x) => x.id === id);
  if (!item) return c.json({ error: 'not found' }, 404);

  if (action === 'confirm') {
    const type = String(body.type ?? 'CUSTOMER').toUpperCase();
    const r = map.mint(type, item.span);
    v.persistMint(item.span, r.token, item.suggested_cat ?? 'customer', 1.0);
    v.setReviewStatus(id, 'confirmed');
    resetVocab();
    return c.json({ ok: true, token: r.token });
  }
  if (action === 'allowlist') {
    v.addAllowlist(item.span, false, 'user via review queue');
    v.setReviewStatus(id, 'allowlisted');
    resetVocab();
    return c.json({ ok: true });
  }
  if (action === 'ignore') {
    v.setReviewStatus(id, 'ignored');
    return c.json({ ok: true });
  }
  return c.json({ error: 'unknown action' }, 400);
});
