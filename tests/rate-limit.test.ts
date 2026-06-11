/**
 * Rate-limiter unit tests (SRV-02 / #75).
 *
 * Under Bun.serve, Hono's context has no `incoming.socket`, so the old
 * getClientIp() always returned 'unknown' and every caller shared one bucket
 * — ineffective isolation and a footgun for bulk UI ops. These tests pin the
 * documented contract:
 *   - when a trusted proxy header is present, distinct addresses get
 *     independent buckets;
 *   - otherwise a single, explicit global bucket key is used (honest global
 *     token-bucket), never a per-call surprise.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getClientIp,
  rateLimited,
  resetRateLimiter,
  GLOBAL_BUCKET_KEY,
  RL_MAX,
} from '../server/lib/rate-limit';

function ctx(headers: Record<string, string> = {}, env: unknown = null) {
  return {
    req: { header: (k: string) => headers[k.toLowerCase()] },
    env,
  };
}

beforeEach(() => resetRateLimiter());

describe('getClientIp', () => {
  test('returns the documented global key when no trusted proxy header is present', () => {
    // TRUST_XFF defaults to off; the honest contract is a single global bucket.
    expect(getClientIp(ctx())).toBe(GLOBAL_BUCKET_KEY);
  });
});

describe('rateLimited — global bucket (default, loopback)', () => {
  test('blocks after RL_MAX requests from the shared global key', () => {
    const key = GLOBAL_BUCKET_KEY;
    for (let i = 0; i < RL_MAX; i++) {
      expect(rateLimited(key)).toBe(false);
    }
    expect(rateLimited(key)).toBe(true);
  });
});

describe('rateLimited — independent buckets per distinct key', () => {
  test('two distinct addresses get independent buckets', () => {
    // Saturate bucket A.
    for (let i = 0; i < RL_MAX; i++) rateLimited('10.0.0.1');
    expect(rateLimited('10.0.0.1')).toBe(true);
    // Bucket B is untouched.
    expect(rateLimited('10.0.0.2')).toBe(false);
  });
});
