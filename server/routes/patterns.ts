/**
 * Induced pattern management routes.
 *   GET  /api/patterns         — pending + active patterns
 *   POST /api/patterns/suggest — run induction for qualifying categories
 *   POST /api/patterns/:id     — activate | reject | edit a pattern
 *   DELETE /api/patterns/:id   — delete a pattern
 */

import { Hono } from 'hono';
import { getVocab, resetVocab, invalidatePatternsCache } from '../lib/vocab-store';
import { getClientIp, rateLimited } from '../lib/rate-limit';
import { induceRegex } from '../../src/induction';

export const patternsRoute = new Hono();

// Catches quantified groups: `(a+)+`, `(?:a+)+`, `(a{2,5})+`, `(a{2,})+`, etc.
const REDOS_RE = /\([^)]*[*+{][^)]*\)[*+{]/;

// Non-matching suffix forces the engine to backtrack — exercises catastrophic cases.
const RL_TIMING_HAYSTACK = 'a'.repeat(500) + '\x00';

export function validateUserRegex(src: string): { valid: boolean; rx?: RegExp; error?: string } {
  if (src.length > 200) return { valid: false, error: 'pattern too long (max 200 chars)' };
  if (REDOS_RE.test(src)) return { valid: false, error: 'nested quantifier pattern rejected (ReDoS risk)' };

  let rx: RegExp;
  try {
    rx = new RegExp(src);
  } catch (e) {
    return { valid: false, error: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Timing backstop against a non-matching haystack so backtracking is exercised.
  const t0 = Date.now();
  try { rx.test(RL_TIMING_HAYSTACK); } catch {
    return { valid: false, error: 'regex threw during test execution' };
  }
  if (Date.now() - t0 > 10) return { valid: false, error: 'pattern too slow (potential ReDoS)' };

  return { valid: true, rx };
}

patternsRoute.get('/', (c) => {
  const v = getVocab();
  const items = [...v.pendingPatterns(), ...v.activePatterns()].map((row) => ({
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
        (entry) => entry.count >= MIN_EXAMPLES,
      )
    : v.categoriesAboveThreshold(MIN_EXAMPLES);

  const insertedIds: number[] = [];

  for (const { category } of cats) {
    const examples = v.vocabByCategory(category).map((r) => r.real_value);
    const induced = induceRegex(examples, { minExamples: MIN_EXAMPLES });
    if (!induced) continue;

    insertedIds.push(v.persistInducedPattern({
      category,
      regex_source: induced.source.source,
      skeleton: induced.skeleton,
      source_examples: induced.examples,
      confidence: induced.specificity,
    }));
  }

  // Single query after all inserts — avoids N+1
  const newRows = v.pendingPatterns().filter((r) => insertedIds.includes(r.id));

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
    const validatedRx = validation.rx!;

    const row = [...v.pendingPatterns(), ...v.activePatterns()].find((r) => r.id === id);
    if (!row) return c.json({ error: 'pattern not found' }, 404);

    const sourceExamples: string[] = JSON.parse(row.source_examples);
    if (!sourceExamples.every((ex) => validatedRx.test(ex)))
      return c.json({ error: 'regex does not match all source examples' }, 400);

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
