const RL_WINDOW_MS = 10_000;
export const RL_MAX = 10;
const RL_MAX_IPS = 1024;
const rlBuckets = new Map<string, number[]>();

const TRUST_XFF = process.env.TRUST_XFF === '1';

/**
 * The single, explicit key used for the honest global token-bucket (SRV-02 /
 * #75). privacy-screen binds loopback only, so under Bun.serve there is no
 * real per-client socket address to isolate on — Hono's context has no
 * `incoming.socket`, which made the old code silently fall back to the magic
 * string 'unknown'. We now name that bucket so the global-rate-limit contract
 * is explicit rather than an accident of a missing field.
 */
export const GLOBAL_BUCKET_KEY = '__global__';

/**
 * Resolve the rate-limit bucket key for a request.
 *
 * Contract:
 *  - When `TRUST_XFF=1` (a real reverse proxy sits in front) and an
 *    `x-forwarded-for` header is present, isolate per forwarded client
 *    address so distinct clients get independent buckets.
 *  - Otherwise — the default loopback deployment — use a single documented
 *    global bucket (`GLOBAL_BUCKET_KEY`). This is an honest global
 *    token-bucket, not per-client isolation, because loopback has no proxy
 *    and Bun.serve does not surface a socket address through Hono context.
 */
export function getClientIp(c: { req: { header: (k: string) => string | undefined }; env: unknown }): string {
  if (TRUST_XFF) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return String(xff).split(',')[0].trim();
  }
  return GLOBAL_BUCKET_KEY;
}

/** Test seam: clear all rate-limit buckets so cases start from a clean window. */
export function resetRateLimiter(): void {
  rlBuckets.clear();
}

export function rateLimited(ip: string): boolean {
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
    for (const [k, v] of rlBuckets) if (v.length === 0 || v[v.length - 1] < cutoff) rlBuckets.delete(k);
  }
  rlBuckets.set(ip, fresh);
  return false;
}
