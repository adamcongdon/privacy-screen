/**
 * Induced pattern management routes.
 *   GET  /api/patterns         — pending + active patterns
 *   POST /api/patterns/suggest — run induction for qualifying categories
 *   POST /api/patterns/:id     — activate | reject | edit a pattern
 *   DELETE /api/patterns/:id   — delete a pattern
 */

import { Hono } from 'hono';
import { getVocab, resetVocab, invalidatePatternsCache } from '../lib/vocab-store';
import { induceRegex } from '../../src/induction';

export const patternsRoute = new Hono();

// Reuse rate-limit helpers from vocab.ts approach — per-IP bucket
const RL_WINDOW_MS = 10_000;
const RL_MAX = 10;
const RL_MAX_IPS = 1024;
const rlBuckets = new Map<string, number[]>();

const TRUST_XFF = process.env.TRUST_XFF === '1';

function getClientIp(c: any): string {
  if (TRUST_XFF) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return String(xff).split(',')[0].trim();
  }
  const remote = (c.env as any)?.incoming?.socket?.remoteAddress;
  return remote ? String(remote) : 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const bucket = rlBuckets.get(ip) ?? [];
  const fresh = bucket.filter((t) => t > cutoff);
  if (fresh.length >= RL_MAX) {
    rlBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  if (fresh.length === 1 && rlBuckets.size >= RL_MAX_IPS) {
    for (const [k, v] of rlBuckets) {
      if (v.length === 0 || v[v.length - 1] < cutoff) rlBuckets.delete(k);
    }
  }
  rlBuckets.set(ip, fresh);
  return false;
}

/**
 * Basic ReDoS guard: rejects nested quantifiers and checks timing against a
 * 1000-char string.
 */
export function validateUserRegex(src: string): { valid: boolean; error?: string } {
  if (src.length > 200) return { valid: false, error: 'pattern too long (max 200 chars)' };

  // Reject obvious ReDoS nested quantifiers
  const redos = /\(?:.*?\)[*+]|\(\..*?\)[*+]/;
  if (redos.test(src)) return { valid: false, error: 'nested quantifier pattern rejected (ReDoS risk)' };

  let rx: RegExp;
  try {
    rx = new RegExp(src);
  } catch (e) {
    return { valid: false, error: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Basic timing check — run against a 1000-char haystack, must complete < 10ms
  const haystack = 'a'.repeat(1000);
  const t0 = Date.now();
  try {
    rx.test(haystack);
  } catch {
    return { valid: false, error: 'regex threw during test execution' };
  }
  if (Date.now() - t0 > 10) return { valid: false, error: 'pattern too slow (potential ReDoS)' };

  return { valid: true };
}

patternsRoute.get('/', (c) => {
  const v = getVocab();
  const pending = v.pendingPatterns();
  const active = v.activePatterns();
  const items = [...pending, ...active].map((row) => ({
    ...row,
    source_examples: JSON.parse(row.source_examples) as string[],
  }));
  return c.json({ items });
});

patternsRoute.post('/suggest', async (c) => {
  if (rateLimited(getClientIp(c))) return c.json({ error: 'rate limited' }, 429);

  const body = await c.req.json().catch(() => ({}));
  const categoryFilter = body.category ? String(body.category) : undefined;
  const v = getVocab();
  const MIN_EXAMPLES = 3;

  const cats = categoryFilter
    ? [{ category: categoryFilter, count: v.vocabByCategory(categoryFilter).length }].filter(
        (c) => c.count >= MIN_EXAMPLES,
      )
    : v.categoriesAboveThreshold(MIN_EXAMPLES);

  const newRows: ReturnType<typeof v.pendingPatterns> = [];

  for (const { category } of cats) {
    const vocabRows = v.vocabByCategory(category);
    const examples = vocabRows.map((r) => r.real_value);
    const induced = induceRegex(examples, { minExamples: MIN_EXAMPLES });
    if (!induced) continue;

    const id = v.persistInducedPattern({
      category,
      regex_source: induced.source.source,
      skeleton: induced.skeleton,
      source_examples: induced.examples,
      confidence: induced.specificity,
    });

    const row = v.pendingPatterns().find((r) => r.id === id);
    if (row) newRows.push(row);
  }

  return c.json({
    items: newRows.map((row) => ({
      ...row,
      source_examples: JSON.parse(row.source_examples) as string[],
    })),
  });
});

patternsRoute.post('/:id', async (c) => {
  if (rateLimited(getClientIp(c))) return c.json({ error: 'rate limited' }, 429);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  const v = getVocab();

  if (action === 'activate') {
    v.setInducedStatus(id, 'active');
    invalidatePatternsCache();
    resetVocab();
    return c.json({ ok: true });
  }

  if (action === 'reject') {
    v.setInducedStatus(id, 'rejected');
    invalidatePatternsCache();
    resetVocab();
    return c.json({ ok: true });
  }

  if (action === 'edit') {
    const regexSrc = String(body.regex ?? '');
    const validation = validateUserRegex(regexSrc);
    if (!validation.valid) return c.json({ error: validation.error }, 400);

    // Verify coverage against source examples
    const allRows = [...v.pendingPatterns(), ...v.activePatterns()];
    const row = allRows.find((r) => r.id === id);
    if (!row) return c.json({ error: 'pattern not found' }, 404);

    const sourceExamples: string[] = JSON.parse(row.source_examples);
    const rx = new RegExp(regexSrc);
    const allMatch = sourceExamples.every((ex) => rx.test(ex));
    if (!allMatch) return c.json({ error: 'regex does not match all source examples' }, 400);

    v.updateInducedRegex(id, regexSrc);
    invalidatePatternsCache();
    resetVocab();
    return c.json({ ok: true });
  }

  return c.json({ error: 'unknown action' }, 400);
});

patternsRoute.delete('/:id', (c) => {
  if (rateLimited(getClientIp(c))) return c.json({ error: 'rate limited' }, 429);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);

  getVocab().deleteInducedPattern(id);
  invalidatePatternsCache();
  return c.json({ ok: true });
});
