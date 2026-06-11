/**
 * Tests for server/lib/update-check.ts.
 *
 * Covers:
 *   - compareVersions numeric semantics (no string compare).
 *   - compareVersions for beta prereleases (1.2.3 > 1.2.3-beta.N, higher beta > lower).
 *   - checkForUpdate behavior across newer/equal/older/missing-platform,
 *     channel matching, and malformed-manifest cases.
 *   - Timeout via AbortController doesn't leak past timeoutMs + slack.
 *
 * Mocks fetch via the `fetchImpl` option — this avoids monkey-patching
 * `globalThis.fetch` and keeps the tests deterministic.
 */

import { describe, test, expect } from 'bun:test';
import { compareVersions, checkForUpdate, type ReleaseManifest } from '../server/lib/update-check';

const GOOD_SHA = 'a'.repeat(64);
const URL_ARM64 = 'https://example.invalid/releases/v1.2.3/darwin-arm64';
const URL_X64 = 'https://example.invalid/releases/v1.2.3/darwin-x64';

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: '1.2.3',
    channel: 'stable',
    released_at: '2026-06-02T00:00:00Z',
    notes_url: 'https://example.invalid/notes',
    minimum_supported_version: '1.0.0',
    platforms: {
      'darwin-arm64': { url: URL_ARM64, sha256: GOOD_SHA, size_bytes: 1234 },
      'darwin-x64': { url: URL_X64, sha256: GOOD_SHA, size_bytes: 1235 },
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(body: unknown, init?: { ok?: boolean; status?: number }): typeof fetch {
  return (async () => jsonResponse(body, init)) as unknown as typeof fetch;
}

describe('compareVersions', () => {
  test('equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  test('older first arg', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  test('newer first arg', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });

  test('numeric compare on minor (1.2 < 1.10)', () => {
    // String compare would say 1.10 < 1.2 — must be numeric.
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.2.0')).toBe(1);
  });

  test('major dominates minor + patch', () => {
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });

  test('malformed versions compare as equal (graceful fallback)', () => {
    expect(compareVersions('not-a-version', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'also-bad')).toBe(0);
  });

  // Beta prerelease ordering (for auto beta builds)
  test('beta vs clean release of same base', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBe(1);
  });

  test('higher beta number is newer (run-number style)', () => {
    expect(compareVersions('1.0.0-beta.9', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.42', '1.0.0-beta.42')).toBe(0);
  });

  test('beta with non-numeric id falls back to lexical (sha style)', () => {
    // lexical is acceptable for sha suffixes when we don't have numeric run ids
    expect(compareVersions('1.0.0-beta.abc', '1.0.0-beta.def')).toBe(-1);
    expect(compareVersions('1.0.0-beta.def', '1.0.0-beta.abc')).toBe(1);
  });

  test('beta ids compare across mixed numeric/lexical gracefully (numeric wins if both numeric)', () => {
    // One numeric, one not — fall to lexical on the strings
    const r = compareVersions('1.0.0-beta.10', '1.0.0-beta.abc');
    // We don't assert a specific direction here beyond "defined and consistent"
    expect([-1, 0, 1]).toContain(r);
  });
});

describe('checkForUpdate', () => {
  test('returns null when current matches latest', async () => {
    const result = await checkForUpdate('1.2.3', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(manifest()),
    });
    expect(result).toBeNull();
  });

  test('returns UpdateInfo when latest is newer', async () => {
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(manifest()),
    });
    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.2.3');
    expect(result?.url).toBe(URL_ARM64);
    expect(result?.sha256).toBe(GOOD_SHA);
    expect(result?.channel).toBe('stable');
    expect(result?.notesUrl).toBe('https://example.invalid/notes');
  });

  test('returns null when latest is OLDER (never downgrade)', async () => {
    const result = await checkForUpdate('2.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(manifest()),
    });
    expect(result).toBeNull();
  });

  test('rejects manifest with malformed sha256', async () => {
    const bad = manifest({
      platforms: {
        'darwin-arm64': { url: URL_ARM64, sha256: 'abc', size_bytes: 100 },
      },
    });
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(bad),
    });
    expect(result).toBeNull();
  });

  test('rejects manifest with uppercase sha256 (must be lowercase hex)', async () => {
    const bad = manifest({
      platforms: {
        'darwin-arm64': { url: URL_ARM64, sha256: 'A'.repeat(64), size_bytes: 100 },
      },
    });
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(bad),
    });
    expect(result).toBeNull();
  });

  test('returns null when platform key missing from manifest', async () => {
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'win32-x64', // not in our manifest fixture
      fetchImpl: mockFetch(manifest()),
    });
    expect(result).toBeNull();
  });

  test('returns null when channel does not match', async () => {
    const result = await checkForUpdate('1.0.0', {
      channel: 'beta',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(manifest()), // channel: 'stable'
    });
    expect(result).toBeNull();
  });

  test('beta channel accepts beta manifest and treats higher beta run as newer', async () => {
    const betaManifest = manifest({
      version: '1.0.0-beta.42',
      channel: 'beta',
      notes_url: 'https://example.invalid/releases/tag/v1.0.0-beta.42',
    });
    const result = await checkForUpdate('1.0.0-beta.7', {
      channel: 'beta',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(betaManifest),
    });
    expect(result).not.toBeNull();
    expect(result?.version).toBe('1.0.0-beta.42');
    expect(result?.channel).toBe('beta');
  });

  test('beta client on a beta does not see a stable manifest (channel filter)', async () => {
    const stableManifest = manifest({ version: '1.0.0', channel: 'stable' });
    const result = await checkForUpdate('1.0.0-beta.7', {
      channel: 'beta',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(stableManifest),
    });
    expect(result).toBeNull();
  });

  // Issue #34: beta-channel subscribers running a clean release of the same
  // base must still see the latest beta (e.g. current 0.0.1 → manifest
  // 0.0.1-beta.10 should be offered, because the user opted into beta).
  test('beta channel — clean release sees matching-base beta as upgrade', async () => {
    const betaManifest = manifest({ version: '0.0.1-beta.10', channel: 'beta' });
    const result = await checkForUpdate('0.0.1', {
      channel: 'beta',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(betaManifest),
    });
    expect(result).not.toBeNull();
    expect(result?.version).toBe('0.0.1-beta.10');
    expect(result?.channel).toBe('beta');
  });

  test('stable channel — clean release does NOT see matching-base beta (carve-out is beta-only)', async () => {
    // Symmetric guard: the beta-channel carve-out must not leak into stable.
    // A stable user on 1.0.0 must never be told to "upgrade" to 1.0.0-beta.X.
    const betaManifest = manifest({ version: '1.0.0-beta.5', channel: 'beta' });
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(betaManifest),
    });
    // Either channel-mismatch or carve-out-not-applied — both must yield null.
    expect(result).toBeNull();
  });

  test('beta channel — older clean release does NOT regress to lower-base beta', async () => {
    // Current 1.1.0 (clean), manifest 1.0.0-beta.10. compareVersions returns -1
    // because of major/minor difference; the carve-out requires SAME base, so
    // this must NOT be offered as an "upgrade."
    const betaManifest = manifest({ version: '1.0.0-beta.10', channel: 'beta' });
    const result = await checkForUpdate('1.1.0', {
      channel: 'beta',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(betaManifest),
    });
    expect(result).toBeNull();
  });

  test('returns null on non-2xx response', async () => {
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch({}, { ok: false, status: 404 }),
    });
    expect(result).toBeNull();
  });

  test('returns null on totally malformed JSON (not an object)', async () => {
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch('hello'),
    });
    expect(result).toBeNull();
  });

  test('returns null on missing required field (no version)', async () => {
    const broken: unknown = {
      channel: 'stable',
      released_at: '2026-06-02T00:00:00Z',
      platforms: { 'darwin-arm64': { url: URL_ARM64, sha256: GOOD_SHA, size_bytes: 1 } },
    };
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: mockFetch(broken),
    });
    expect(result).toBeNull();
  });

  test('returns null when fetch throws (network error)', async () => {
    const failing: typeof fetch = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: failing,
    });
    expect(result).toBeNull();
  });

  test('times out cleanly within timeoutMs + slack', async () => {
    // fetch that respects AbortSignal — resolves never, rejects on abort.
    const neverFetch: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      })) as unknown as typeof fetch;

    const timeoutMs = 100;
    const slack = 300;
    const start = Date.now();
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      timeoutMs,
      fetchImpl: neverFetch,
    });
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(timeoutMs + slack);
  });

  // Pentester hardening (issue #16): cross-origin redirects on the manifest
  // GET are a beacon-forwarding vector. The fetch is invoked with
  // `redirect: 'error'`, which causes the platform fetch to throw on a 30x.
  // checkForUpdate's catch returns null. We verify the contract by passing
  // an init-aware fetchImpl that asserts the option, and a throwing one
  // that simulates the redirect-error throw.
  test('fetch is called with redirect: "error" (no cross-origin redirect follow)', async () => {
    let observedInit: RequestInit | undefined;
    const spyingFetch = (async (_url: string, init?: RequestInit) => {
      observedInit = init;
      return jsonResponse(manifest());
    }) as unknown as typeof fetch;
    await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: spyingFetch,
    });
    expect(observedInit?.redirect).toBe('error');
  });

  test('fetch bypasses HTTP cache so "check now" never reports a stale release', async () => {
    // Regression: a long-running app process honored the manifest's
    // Cache-Control max-age and kept returning the version it first fetched
    // (e.g. still beta.13 after beta.14 published). The check must always
    // request a fresh manifest.
    let observedInit: RequestInit | undefined;
    const spyingFetch = (async (_url: string, init?: RequestInit) => {
      observedInit = init;
      return jsonResponse(manifest());
    }) as unknown as typeof fetch;
    await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: spyingFetch,
    });
    expect(observedInit?.cache).toBe('no-store');
    const headers = (observedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['cache-control']).toBe('no-cache');
  });

  test('manifest GET that errors on redirect returns null (no beacon forwarded)', async () => {
    const redirectErrorFetch = (async () => {
      throw new TypeError("Failed to fetch: redirect mode 'error' got redirect");
    }) as unknown as typeof fetch;
    const result = await checkForUpdate('1.0.0', {
      channel: 'stable',
      manifestUrl: 'https://example.invalid/manifest.json',
      platform: 'darwin-arm64',
      fetchImpl: redirectErrorFetch,
    });
    expect(result).toBeNull();
  });
});
