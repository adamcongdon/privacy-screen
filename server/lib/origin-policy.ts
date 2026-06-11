/**
 * Origin / CORS policy (SRV-01 #74, SRV-08 #81).
 *
 * Pure, testable rules for which browser Origins may talk to the local API.
 * Kept out of server.ts (which self-starts Bun.serve on import) so it can be
 * unit-tested without booting a server.
 */

export interface OriginPolicyOptions {
  /** The loopback port the server listens on. */
  port: number;
  /**
   * True when the Vite dev server (5173/5174) should be trusted — i.e. a
   * source/dev checkout or PRIVACY_SCREEN_DEV=1. MUST be false for packaged
   * release builds so a local process on 5173 can't read the vocab dump.
   */
  isDevWeb: boolean;
}

/** Same-origin loopback origins, always trusted. */
export function sameOriginAllowlist(port: number): Set<string> {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

/** Vite dev-server origins, trusted only in dev web mode (SRV-08 #81). */
export const DEV_ORIGIN_ALLOWLIST: ReadonlySet<string> = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
]);

/** True if `origin` is permitted to call the API under the given policy. */
export function isAllowedOrigin(origin: string, opts: OriginPolicyOptions): boolean {
  if (sameOriginAllowlist(opts.port).has(origin)) return true;
  if (opts.isDevWeb && DEV_ORIGIN_ALLOWLIST.has(origin)) return true;
  return false;
}

/** State-mutating HTTP methods that the CSRF guard protects (SRV-01 #74). */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);
