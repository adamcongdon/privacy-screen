/**
 * hooks/lib/judge-endpoint.ts — shared loopback-only judge URL resolver.
 *
 * Both the fire-and-forget `/api/judge` dispatch and the sync
 * `/api/judge/sync` precheck must refuse non-loopback hosts so PII never
 * leaves the box via a misconfigured env var. Duplicating that check was
 * a divergence risk (HOOK-07 / #99); this module is the single source of
 * truth.
 *
 * Contract:
 *   - `PRIVACY_SCREEN_JUDGE_ENDPOINT` overrides the full URL (tests).
 *   - Default: `http://127.0.0.1:${PRIVACY_SCREEN_PORT ?? 31338}` + path
 *     for `kind` (`/api/judge` or `/api/judge/sync`).
 *   - Only `http:` is accepted (no https, no other schemes).
 *   - Hostname must be loopback: 127.0.0.1, localhost, or ::1.
 *   - Returns `null` on parse failure, wrong scheme, or non-loopback host.
 */

export type JudgeEndpointKind = 'async' | 'sync';

// Bun's URL.hostname for IPv6 keeps brackets (`[::1]`); other runtimes may
// strip them. Accept both so the loopback gate is real for ::1.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const PATH_BY_KIND: Record<JudgeEndpointKind, string> = {
  async: '/api/judge',
  sync: '/api/judge/sync',
};

/**
 * Resolve a judge endpoint URL for the given kind.
 *
 * Override (when set) keeps its full path so test receivers can listen on
 * whatever path they like. The production default appends the path for
 * `kind` so async and sync hit distinct routes.
 */
export function resolveJudgeEndpoint(kind: JudgeEndpointKind): string | null {
  const override = process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT;
  const port = process.env.PRIVACY_SCREEN_PORT ?? '31338';
  const url = override ?? `http://127.0.0.1:${port}${PATH_BY_KIND[kind]}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return url;
}
