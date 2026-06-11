/**
 * Feedback relay client (#15 universal-feedback rework).
 *
 * The "Send feedback" flow used to shell out to `gh issue create`, which only
 * works on a machine with the GitHub CLI installed AND authenticated — i.e. the
 * developer's. To let ANY user submit feedback, the app now POSTs the
 * (already-scrubbed) issue to a small hosted relay (a Cloudflare Worker, see
 * `relay/`) that holds the GitHub credential server-side and files the issue.
 *
 * This module owns the client half of that contract:
 *   - resolving the relay base URL (env → config → built-in default),
 *   - resolving + HMAC-signing the request with the shared app key,
 *   - the typed POST itself.
 *
 * Privacy posture: this is the ONLY new egress destination. It is reached only
 * when the user clicks Send, and only with text that has already been through
 * `scrubText()` + the `hasCredentials` refusal in the route. Nothing here
 * collects or sends anything on its own.
 *
 * Security note: `APP_HMAC_KEY` is embedded in the distributed app, so it is
 * obfuscation rather than a true secret — it raises the bar above casual
 * scripting. The real abuse backstops live on the relay (per-IP rate limit +
 * the `feedback/unverified` triage label).
 */

import { createHmac } from 'crypto';
import { loadConfig, FEEDBACK_RELAY_DEFAULT_URL } from '../../src/config';

/** Feedback type → GitHub label. Mirrors the segmented control in the UI. */
export type FeedbackType = 'bug' | 'enhancement' | 'question';

/** The set of accepted types, exported so the route can validate input. */
export const FEEDBACK_TYPES: readonly FeedbackType[] = ['bug', 'enhancement', 'question'];

export function isFeedbackType(v: unknown): v is FeedbackType {
  return typeof v === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(v);
}

/**
 * Default shared app-gate identifier. This is a PUBLIC value on purpose: it
 * must ship inside every distributed binary so feedback works for any user,
 * which means it is extractable and therefore NOT a secret. It is a soft gate
 * that blocks casual scripting; the real abuse backstops are the relay's per-IP
 * rate limit + the `feedback/unverified` triage label. It is deliberately a
 * low-entropy readable identifier (not a random key) so it is honest about what
 * it is and does not masquerade as a credential. MUST match the relay's
 * `APP_HMAC_KEY`. Override per-install with `PRIVACY_SCREEN_FEEDBACK_APP_KEY`.
 */
const FEEDBACK_APP_KEY_DEFAULT = 'privacy-screen-feedback-public-gate';

/** Wall-clock budget for the relay round-trip. */
const RELAY_TIMEOUT_MS = 15_000;

/**
 * Resolve the relay base URL (no trailing slash). Resolution order:
 *   1. `__PRIVACY_SCREEN_TEST_RELAY_URL` (non-production test seam only)
 *   2. `PRIVACY_SCREEN_FEEDBACK_RELAY_URL` (runtime override — e.g. staging)
 *   3. `feedback_relay_url` from PRIVACY_CONFIG.yaml
 *   4. built-in default
 */
export function relayBaseUrl(): string {
  return sanitizeRelayUrl(resolveRelayCandidate());
}

function resolveRelayCandidate(): string {
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.__PRIVACY_SCREEN_TEST_RELAY_URL
  ) {
    return process.env.__PRIVACY_SCREEN_TEST_RELAY_URL;
  }
  const envOverride = process.env.PRIVACY_SCREEN_FEEDBACK_RELAY_URL;
  if (envOverride && envOverride.length > 0) return envOverride;
  try {
    const cfg = loadConfig();
    if (cfg.feedback_relay_url) return cfg.feedback_relay_url;
  } catch {
    // fall through to default
  }
  return FEEDBACK_RELAY_DEFAULT_URL;
}

/**
 * Constrain the resolved relay URL to https (or http on loopback, for the local
 * test seam / a self-hosted dev relay). This closes the gap where the env
 * override / a tampered PRIVACY_CONFIG.yaml could redirect feedback egress to a
 * plaintext or attacker-controlled host — the config-file path is already
 * https-validated, but env + the built-in default flow through here too. Any
 * disallowed URL falls back to the built-in default with a stderr warning.
 */
function sanitizeRelayUrl(raw: string): string {
  const stripped = stripTrailingSlash(raw);
  try {
    const u = new URL(stripped);
    const isLoopback =
      u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    if (u.protocol === 'https:' || (isLoopback && u.protocol === 'http:')) {
      return stripped;
    }
    process.stderr.write(
      `[privacy-screen] feedback_relay_url must use https:// (got '${u.protocol}//${u.hostname}') — falling back to default.\n`,
    );
  } catch {
    process.stderr.write(
      '[privacy-screen] feedback_relay_url is not a valid URL — falling back to default.\n',
    );
  }
  return stripTrailingSlash(FEEDBACK_RELAY_DEFAULT_URL);
}

/** Resolve the shared app key (env override → default constant). */
export function appKey(): string {
  const env = process.env.PRIVACY_SCREEN_FEEDBACK_APP_KEY;
  return env && env.length > 0 ? env : FEEDBACK_APP_KEY_DEFAULT;
}

/**
 * Lowercase-hex HMAC-SHA256 of `raw` under the shared app key. The relay
 * recomputes this over the exact request body bytes and constant-time compares
 * it to the `X-PS-Sig` header.
 */
export function signBody(raw: string, key: string = appKey()): string {
  return createHmac('sha256', key).update(raw, 'utf8').digest('hex');
}

export interface RelayPayload {
  title: string;
  body: string;
  type: FeedbackType;
}

export type RelayResult =
  | { ok: true; issueNumber: number; issueUrl: string }
  | { ok: false; error: string };

/**
 * POST a (already-scrubbed) issue to the relay's `/feedback` endpoint. Signs the
 * exact serialized body with the shared app key. Never throws — transport,
 * timeout, and non-2xx are all mapped to `{ ok: false, error }`.
 */
export async function postToRelay(
  payload: RelayPayload,
  base: string = relayBaseUrl(),
): Promise<RelayResult> {
  const raw = JSON.stringify(payload);
  const sig = signBody(raw);
  const url = `${stripTrailingSlash(base)}/feedback`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PS-Sig': sig,
      },
      body: raw,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg.toLowerCase().includes('abort')) {
      return { ok: false, error: `feedback relay timed out after ${RELAY_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `could not reach feedback relay: ${msg}` };
  }

  let parsed: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON body — fall through to status-based error
    }
  }

  if (!res.ok) {
    const error =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `feedback relay returned HTTP ${res.status}`;
    return { ok: false, error };
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const issueUrl = typeof obj.issueUrl === 'string' ? obj.issueUrl : undefined;
  const issueNumber = typeof obj.issueNumber === 'number' ? obj.issueNumber : undefined;
  if (!issueUrl || typeof issueNumber !== 'number') {
    return { ok: false, error: 'feedback relay returned an unexpected response shape' };
  }
  return { ok: true, issueNumber, issueUrl };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
