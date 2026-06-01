const RL_WINDOW_MS = 10_000;
const RL_MAX = 10;
const RL_MAX_IPS = 1024;
const rlBuckets = new Map<string, number[]>();

const TRUST_XFF = process.env.TRUST_XFF === '1';

export function getClientIp(c: { req: { header: (k: string) => string | undefined }; env: unknown }): string {
  if (TRUST_XFF) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return String(xff).split(',')[0].trim();
  }
  const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | null)?.incoming?.socket?.remoteAddress;
  return remote ? String(remote) : 'unknown';
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
