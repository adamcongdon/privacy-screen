/**
 * hooks/lib/judge-sync.ts — synchronous judge precheck for auto-approve.
 *
 * Companion to the existing fire-and-forget judge dispatch in
 * `PrivacyScreen.hook.ts`. Where that path POSTs to `/api/judge` and ignores
 * the response, this one POSTs to `/api/judge/sync` and *waits* for an
 * inline `{ ok: true, suspicious_count: number }` answer so the hook can
 * decide whether to auto-approve a payload without blocking.
 *
 * Safety rails:
 *   - Loopback-only. Refuses any URL whose hostname is not 127.0.0.1 /
 *     localhost / ::1. Defense in depth against env-var misconfig.
 *   - Tight `AbortSignal.timeout(budgetMs)` — default budget is 400 ms.
 *   - Fail-CLOSED. Any error, timeout, malformed response, or non-zero
 *     suspicious_count collapses to `{ clean: false, available: false }`.
 *     Auto-approve is opt-in; uncertainty must never produce a silent pass.
 *
 * The hook decides what to do with the result: if `clean === true` AND the
 * scrubber found no PII, it skips the block. In every other case the normal
 * scrub/block path runs unchanged.
 */

import type { PrivacyConfig } from '../../src/config';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Result of a sync judge precheck. */
export interface JudgeSyncResult {
  /** True iff the judge confirmed `suspicious_count === 0`. */
  clean: boolean;
  /**
   * True iff the endpoint responded with a well-formed JSON body within the
   * budget. False on connection refused, timeout, parse error, non-200, or
   * malformed shape. When `available === false`, `clean` is always `false`.
   */
  available: boolean;
}

const SYNC_RESULT_FAIL_CLOSED: JudgeSyncResult = Object.freeze({
  clean: false,
  available: false,
});

/**
 * POST `text` to the loopback judge sync endpoint, parse the response, and
 * return whether the judge considers the payload clean.
 *
 * Behavior:
 *   1. If `cfg.llm_validate.enabled === false` → returns
 *      `{ clean: false, available: false }`. Auto-approve is gated on a real,
 *      enabled judge; we don't want a misconfigured judge to grant approvals.
 *   2. If the resolved endpoint URL fails parse or is not loopback → same
 *      fail-CLOSED return value.
 *   3. POSTs `{ scrubbed: <text>, sourceEvent: 'hook-precheck' }` with a
 *      tight `AbortSignal.timeout(budgetMs)`.
 *   4. On any error, timeout, non-200 status, JSON parse failure, missing
 *      `ok: true`, or non-numeric `suspicious_count` → fail-CLOSED.
 *   5. On `{ ok: true, suspicious_count: 0 }` → `{ clean: true, available: true }`.
 *   6. On `{ ok: true, suspicious_count: N }` where N > 0 →
 *      `{ clean: false, available: true }`.
 */
export async function checkJudgeSync(
  text: string,
  cfg: PrivacyConfig,
  budgetMs: number,
): Promise<JudgeSyncResult> {
  if (!cfg.llm_validate.enabled) return SYNC_RESULT_FAIL_CLOSED;

  const endpoint = resolveSyncEndpoint();
  if (endpoint === null) return SYNC_RESULT_FAIL_CLOSED;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scrubbed: text, sourceEvent: 'hook-precheck' }),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!res.ok) return SYNC_RESULT_FAIL_CLOSED;

    const parsed: unknown = await res.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object') return SYNC_RESULT_FAIL_CLOSED;
    const body = parsed as Record<string, unknown>;
    if (body.ok !== true) return SYNC_RESULT_FAIL_CLOSED;
    if (typeof body.suspicious_count !== 'number') return SYNC_RESULT_FAIL_CLOSED;

    return { clean: body.suspicious_count === 0, available: true };
  } catch {
    return SYNC_RESULT_FAIL_CLOSED;
  }
}

/**
 * Resolve the sync judge endpoint URL. Same env-var contract as the
 * fire-and-forget dispatcher: `PRIVACY_SCREEN_JUDGE_ENDPOINT` overrides for
 * tests; otherwise build `http://127.0.0.1:${PRIVACY_SCREEN_PORT ?? 31338}/api/judge/sync`.
 *
 * The override URL keeps its full path (so a test receiver can scope itself
 * to whatever path it likes). For the production default, we explicitly
 * append `/sync` to disambiguate the route from the existing fire-and-forget
 * `/api/judge` POST.
 *
 * Returns `null` if the URL fails parse or its host is not loopback.
 */
function resolveSyncEndpoint(): string | null {
  const override = process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT;
  const port = process.env.PRIVACY_SCREEN_PORT ?? '31338';
  const url = override ?? `http://127.0.0.1:${port}/api/judge/sync`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return url;
}
