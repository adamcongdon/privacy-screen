/**
 * privacy-screen feedback relay — Cloudflare Worker.
 *
 * The privacy-screen desktop app (loopback-only) POSTs already-scrubbed feedback
 * here; this Worker holds a GitHub fine-grained PAT (a Worker secret) and files
 * an Issue on `adamcongdon/privacy-screen`. This is what makes feedback work for
 * ANY user — no GitHub account, no `gh` CLI.
 *
 * Request contract (must match server/lib/feedback-relay.ts in the app):
 *   POST /feedback
 *   Content-Type: application/json
 *   X-PS-Sig: <lowercase hex HMAC-SHA256 of the exact raw body, key=APP_HMAC_KEY>
 *   body: { title: string, body: string, type: 'bug'|'enhancement'|'question' }
 * Success → 200 { ok: true, issueNumber, issueUrl }
 * Failure → non-2xx { ok: false, error }   (generic — never leak the PAT)
 *
 * Abuse posture (moderate): HMAC app-key gate (obfuscation, not a true secret)
 * + per-IP fixed-window rate limit (KV) + 32 KB size cap. Every issue is
 * labeled `feedback/unverified` so a human can triage before trusting it.
 */

export interface Env {
  /** Fine-grained PAT, Issues:write on adamcongdon/privacy-screen. Worker secret. */
  GH_TOKEN: string;
  /** Shared HMAC key — MUST match the app's embedded key. Worker secret. */
  APP_HMAC_KEY: string;
  /** KV namespace for per-IP rate limiting. */
  RATE_LIMIT: KVNamespace;
  /** Max requests per IP per window. Default 10. */
  RATE_LIMIT_MAX?: string;
  /** Rate-limit window in seconds. Default 3600 (1 hour). */
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

const REPO = 'adamcongdon/privacy-screen';
/**
 * The placeholder key shipped in the source repo. If the Worker is deployed with
 * this value (or no key at all), the "secret" is publicly guessable, so we refuse
 * all requests rather than accept a signature anyone could forge. Set a real
 * random APP_HMAC_KEY before deploying (see README).
 */
const INSECURE_DEFAULT_KEY = 'ps_feedback_relay_v1_change_me_in_prod';
const MAX_BODY_BYTES = 32_768;
const MAX_TITLE_LEN = 120;
const MAX_ISSUE_BODY_LEN = 30_000;
const GITHUB_TIMEOUT_MS = 10_000;
const VALID_TYPES = ['bug', 'enhancement', 'question'] as const;
type FeedbackType = (typeof VALID_TYPES)[number];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/feedback') return jsonResponse({ ok: false, error: 'not found' }, 404);
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
    return handleFeedback(request, env);
  },
};

export async function handleFeedback(request: Request, env: Env): Promise<Response> {
  // 0. Refuse to run with an unset or publicly-guessable signing key — failing
  //    closed beats silently accepting forgeable signatures.
  if (!env.APP_HMAC_KEY || env.APP_HMAC_KEY === INSECURE_DEFAULT_KEY) {
    console.error('APP_HMAC_KEY is unset or the insecure default — refusing requests');
    return jsonResponse({ ok: false, error: 'relay misconfigured' }, 503);
  }

  // 1. Read the raw body once (needed verbatim for the HMAC check) + size cap.
  const raw = await request.text();
  if (byteLength(raw) > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: 'payload too large' }, 413);
  }

  // 2. HMAC app-key gate (constant-time).
  const provided = request.headers.get('X-PS-Sig') ?? '';
  const expected = await hmacHex(raw, env.APP_HMAC_KEY);
  if (!timingSafeEqualHex(provided, expected)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  // 3. Per-IP rate limit.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await underRateLimit(env, ip);
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'rate limit exceeded' }, 429);
  }

  // 4. Parse + validate payload.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse({ ok: false, error: 'invalid payload' }, 400);
  }
  const payload = parsed as Record<string, unknown>;
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const type = payload.type;
  if (
    title.length === 0 ||
    title.length > MAX_TITLE_LEN ||
    body.length === 0 ||
    body.length > MAX_ISSUE_BODY_LEN ||
    !isFeedbackType(type)
  ) {
    return jsonResponse({ ok: false, error: 'invalid payload' }, 400);
  }

  // 5. Create the issue.
  return createIssue(env, { title, body, type });
}

async function createIssue(
  env: Env,
  payload: { title: string; body: string; type: FeedbackType },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'privacy-screen-feedback-relay',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        labels: ['feedback', 'feedback/unverified', payload.type],
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout — log status-free and return a generic error.
    console.error('github request failed', (err as Error)?.name ?? 'error');
    return jsonResponse({ ok: false, error: 'failed to file issue' }, 502);
  }

  if (res.status !== 201) {
    console.error('github returned non-201', res.status);
    return jsonResponse({ ok: false, error: 'failed to file issue' }, 502);
  }

  const created = (await res.json().catch(() => ({}))) as {
    number?: number;
    html_url?: string;
  };
  if (typeof created.number !== 'number' || typeof created.html_url !== 'string') {
    console.error('github 201 but unexpected shape');
    return jsonResponse({ ok: false, error: 'failed to file issue' }, 502);
  }

  return jsonResponse(
    { ok: true, issueNumber: created.number, issueUrl: created.html_url },
    200,
  );
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/**
 * Fixed-window per-IP rate limit backed by KV. Returns true if the request is
 * allowed. KV is eventually consistent — acceptable for a low-volume feedback
 * endpoint where the goal is blunting abuse, not exact accounting.
 */
async function underRateLimit(env: Env, ip: string): Promise<boolean> {
  const max = parsePositiveInt(env.RATE_LIMIT_MAX, 10);
  const windowSeconds = parsePositiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 3600);
  const windowIndex = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${ip}:${windowIndex}`;

  const current = parsePositiveInt(await env.RATE_LIMIT.get(key), 0);
  if (current >= max) return false;

  // TTL slightly past the window so stale counters self-evict (KV min TTL 60s).
  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: Math.max(60, windowSeconds + 60),
  });
  return true;
}

// ── Crypto helpers (exported for tests) ──────────────────────────────────────

/** Lowercase-hex HMAC-SHA256 of `message` under `key`, via WebCrypto. */
export async function hmacHex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time comparison of two hex strings. Returns false on any length
 * mismatch; otherwise XOR-accumulates over all bytes so timing does not leak
 * the position of the first difference.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── Small utilities ───────────────────────────────────────────────────────────

export function isFeedbackType(v: unknown): v is FeedbackType {
  return typeof v === 'string' && (VALID_TYPES as readonly string[]).includes(v);
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function parsePositiveInt(v: string | null | undefined, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
