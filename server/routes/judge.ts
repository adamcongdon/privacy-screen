/**
 * POST /api/judge — opt-in LLM secondary validator (out-of-band).
 *
 * The hook fires here AFTER it has already returned its scrubbed output to
 * the model — this endpoint never blocks the hot path. We accept the
 * pre-scrubbed text, run `runJudge` against the configured LLM, and write
 * any surviving spans to the existing `review_queue`.
 *
 * Lifecycle:
 *   1. Apply rate-limit (shared bucket with other routes).
 *   2. 256 KB body cap (Content-Length check) — defense in depth.
 *   3. Shape-validate the body.
 *   4. If `llm_validate.enabled === false`, return `{status:'disabled'}` without
 *      scheduling work. Cheap, predictable, hook-friendly.
 *   5. Otherwise, return `202 Accepted` immediately and schedule the judge
 *      run via `queueMicrotask`. Failures during the run are logged once and
 *      swallowed — there is no client to surface them to.
 *
 * Test seam: when `PRIVACY_SCREEN_LLM_MOCK === '1'`, the route bypasses
 * `getLlmClient` and uses a `MockLlmClient` seeded from
 * `PRIVACY_SCREEN_LLM_MOCK_RESPONSE` (a JSON string or JSON array of strings
 * for multi-chunk scripted responses). This makes the seam multi-chunk capable
 * and lets us assert end-to-end behavior — including the review_queue write —
 * without spawning a real model. Array form supports testing chunked runJudge
 * paths (accumulation, maxSpans, dedup).
 */

import { Hono } from 'hono';
import { loadConfig } from '../../src/config';
import { ScrubMap } from '../../src/scrub-map';
import { runJudge } from '../../src/judge/judge';
import { MockLlmClient, type LlmClient } from '../../src/judge/llm-client';
import { getVocab } from '../lib/vocab-store';
import { getLlmClient } from '../lib/llm-process';
import { rateLimited, getClientIp } from '../lib/rate-limit';

/**
 * Inbound POST body for `/api/judge/sync` — the synchronous variant used by
 * the hook's auto-approve precheck (Issue #6). Same shape as the fire-and-
 * forget body except `tokenMap` is optional (the precheck does not need it).
 */
interface JudgeSyncRequestBody {
  scrubbed: string;
  sourceEvent: string;
}

/** Hard cap on the POST body via Content-Length. Matches the 256 KB doc-comment + test contract. */
const BODY_BYTE_LIMIT = 256 * 1024;
/** Defensive cap on the scrubbed-text field itself. Judge chunks internally at 1800 chars. */
const SCRUBBED_TEXT_LIMIT = 200_000;
/** Width of the surrounding-context snippet around each suspicious span. */
const SURROUNDING_WINDOW = 40;
/** Max spans returned per call (also communicated to the model). */
const MAX_SPANS = 16;

/** Inbound POST body. Validated at runtime, not just at the type level. */
interface JudgeRequestBody {
  scrubbed: string;
  tokenMap: unknown;
  sourceEvent: string;
}

export const judgeRoute = new Hono();

let _activeJudgeRequests = 0;
export function getActiveJudgeRequests(): number { return _activeJudgeRequests; }

judgeRoute.post('/', async (c) => {
  if (rateLimited(getClientIp(c))) {
    return c.json({ error: 'rate limited' }, 429);
  }

  const lenHeader = c.req.header('content-length');
  if (lenHeader !== undefined) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > BODY_BYTE_LIMIT) {
      return c.json({ error: 'payload too large' }, 413);
    }
  }

  const raw: unknown = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== 'object') {
    return c.json({ error: 'invalid json' }, 400);
  }
  const body = raw as Record<string, unknown>;

  if (
    typeof body.scrubbed !== 'string' ||
    typeof body.sourceEvent !== 'string' ||
    body.tokenMap === undefined ||
    body.tokenMap === null
  ) {
    return c.json({ error: 'invalid body shape' }, 400);
  }
  if (body.scrubbed.length > SCRUBBED_TEXT_LIMIT) {
    return c.json({ error: 'scrubbed too large' }, 400);
  }

  // Validate token-map shape eagerly so we can 400 on garbage before scheduling.
  let tokenMap: ScrubMap;
  try {
    tokenMap = ScrubMap.deserialize(body.tokenMap);
  } catch {
    return c.json({ error: 'invalid tokenMap' }, 400);
  }

  const cfg = loadConfig();
  if (!cfg.llm_validate.enabled) {
    return c.json({ status: 'disabled', spansFound: 0 }, 200);
  }

  const validated: JudgeRequestBody = {
    scrubbed: body.scrubbed,
    tokenMap: body.tokenMap,
    sourceEvent: body.sourceEvent,
  };

  // Schedule the heavy work after we've returned 202.
  queueMicrotask(() => {
    void runJudgeAndPersist(validated, tokenMap, cfg.llm_validate);
  });

  return c.json({ status: 'accepted' }, 202);
});

/**
 * POST /api/judge/sync — synchronous confidence-gauge for the hook's
 * auto-approve precheck (Issue #6).
 *
 * Returns inline `{ ok: true, suspicious_count: number }` on success.
 * Bounded by `cfg.llm_validate.timeout_ms` — the same wall-clock budget
 * used by the existing async path. On any error or disabled judge, returns
 * a non-200 status; the hook treats every non-200 as fail-CLOSED.
 *
 * This is intentionally a *separate* route from the fire-and-forget POST /
 * because the contract differs (inline result, no review_queue write) and
 * mixing modes on one path would make the rate-limit + validation logic
 * harder to reason about.
 */
judgeRoute.post('/sync', async (c) => {
  if (rateLimited(getClientIp(c))) {
    return c.json({ error: 'rate limited' }, 429);
  }

  const lenHeader = c.req.header('content-length');
  if (lenHeader !== undefined) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > BODY_BYTE_LIMIT) {
      return c.json({ error: 'payload too large' }, 413);
    }
  }

  const raw: unknown = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== 'object') {
    return c.json({ error: 'invalid json' }, 400);
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.scrubbed !== 'string' || typeof body.sourceEvent !== 'string') {
    return c.json({ error: 'invalid body shape' }, 400);
  }
  if (body.scrubbed.length > SCRUBBED_TEXT_LIMIT) {
    return c.json({ error: 'scrubbed too large' }, 400);
  }

  const cfg = loadConfig();
  if (!cfg.llm_validate.enabled) {
    return c.json({ error: 'judge disabled' }, 503);
  }

  const validated: JudgeSyncRequestBody = {
    scrubbed: body.scrubbed,
    sourceEvent: body.sourceEvent,
  };

  // For the sync path we do not require a caller-supplied tokenMap — the
  // precheck only cares about *whether* the judge sees anything suspicious,
  // not what it would do with the tokens. Pass an empty map so judge filtering
  // still works (no overlap suppressions to apply).
  const tokenMap = new ScrubMap();

  try {
    const client = await acquireClient(cfg.llm_validate);
    if (!client) {
      return c.json({ error: 'judge unavailable' }, 503);
    }

    const result = await runJudge(validated.scrubbed, tokenMap, {
      client,
      timeoutMs: cfg.llm_validate.timeout_ms,
      maxTokens: cfg.llm_validate.max_tokens,
      maxSpans: MAX_SPANS,
      minConfidence: cfg.llm_validate.min_confidence,
    });

    if (result.errorReason) {
      const cTotal = (result as any).chunksTotal ?? '?';
      const cFailed = (result as any).chunksFailed ?? '?';
      process.stderr.write(
        `[privacy-screen] judge.sync.error: ${result.errorReason} (chunks ${cTotal}/${cFailed} failed)\n`,
      );
      // Fail-CLOSED: any judge-internal error (incl. partial chunk failures) denies the
      // precheck, even if spans.length >0 from other chunks. (JDG-05 contract test)
      return c.json({ error: result.errorReason }, 503);
    }

    return c.json({ ok: true, suspicious_count: result.spans.length }, 200);
  } catch (err) {
    process.stderr.write(
      `[privacy-screen] judge.sync.failed: ${errMessage(err)}\n`,
    );
    return c.json({ error: errMessage(err) }, 503);
  }
});

/** Actual judge invocation + review_queue write. Failures are logged + swallowed. */
async function runJudgeAndPersist(
  body: JudgeRequestBody,
  tokenMap: ScrubMap,
  llmCfg: import('../../src/config').LlmValidateConfig,
): Promise<void> {
  _activeJudgeRequests++;
  try {
    const client = await acquireClient(llmCfg);
    if (!client) return;

    const result = await runJudge(body.scrubbed, tokenMap, {
      client,
      timeoutMs: llmCfg.timeout_ms,
      maxTokens: llmCfg.max_tokens,
      maxSpans: MAX_SPANS,
      minConfidence: llmCfg.min_confidence,
    });

    const vocab = getVocab();
    for (const span of result.spans) {
      const surrounding = sliceSurrounding(body.scrubbed, span.text);
      vocab.addReviewItem({
        span: span.text,
        surrounding,
        suggested_cat: span.category,
        confidence: span.confidence,
        source_event: `judge:${body.sourceEvent}`,
      });
    }

    if (result.errorReason) {
      // JDG-05: log partial failures explicitly even when some chunks succeeded and produced spans.
      const cTotal = (result as any).chunksTotal ?? '?';
      const cFailed = (result as any).chunksFailed ?? '?';
      process.stderr.write(
        `[privacy-screen] judge.error: ${result.errorReason} (chunks ${cTotal}/${cFailed} failed)\n`,
      );
    }
    process.stderr.write(
      `[privacy-screen] judge.completed: ${result.spans.length} spans\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[privacy-screen] judge.failed: ${errMessage(err)}\n`,
    );
  } finally {
    _activeJudgeRequests--;
  }
}

/**
 * Pick the LLM client. Test seam: `PRIVACY_SCREEN_LLM_MOCK=1` returns a
 * `MockLlmClient` scripted from `PRIVACY_SCREEN_LLM_MOCK_RESPONSE`.
 * The value may be:
 *  - a plain JSON object string (single response, for 1-chunk or repeated use)
 *  - a JSON-encoded *array* of response strings (for multi-chunk inputs; each
 *    element is the raw string one `complete()` call will return). This makes
 *    the seam multi-chunk capable for testing accumulation / maxSpans saturation
 *    / dedup in runJudge without hitting "queue empty".
 * Falls back to single-element array for backward compat.
 */
async function acquireClient(
  llmCfg: import('../../src/config').LlmValidateConfig,
): Promise<LlmClient | null> {
  if (process.env.PRIVACY_SCREEN_LLM_MOCK === '1') {
    const scripted = process.env.PRIVACY_SCREEN_LLM_MOCK_RESPONSE ?? '{}';
    let responses: string[];
    try {
      const parsed = JSON.parse(scripted);
      responses = Array.isArray(parsed) ? parsed : [scripted];
    } catch {
      responses = [scripted];
    }
    return new MockLlmClient(responses);
  }
  return getLlmClient(llmCfg);
}

/**
 * Pull a 40-char-before/after window around the first occurrence of `span` in
 * `scrubbed`. Falls back to the span text itself if not found.
 */
function sliceSurrounding(scrubbed: string, span: string): string {
  const idx = scrubbed.indexOf(span);
  if (idx === -1) return span;
  const start = Math.max(0, idx - SURROUNDING_WINDOW);
  const end = Math.min(scrubbed.length, idx + span.length + SURROUNDING_WINDOW);
  return scrubbed.slice(start, end);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
