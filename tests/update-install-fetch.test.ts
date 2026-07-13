/**
 * Unit tests for update-install fetchReleaseAsset redirect allowlist (issue #102).
 */
import { describe, test, expect } from 'bun:test';
import { fetchReleaseAsset } from '../server/lib/update-install';

const GOOD_URL =
  'https://github.com/adamcongdon/privacy-screen/releases/download/v1.2.3/privacy-screen-darwin-arm64';

describe('fetchReleaseAsset (issue #102)', () => {
  test('rejects non-allowlisted declared URL before any fetch', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response('nope');
    }) as unknown as typeof fetch;

    await expect(
      fetchReleaseAsset('https://evil.example.com/payload', fetchImpl),
    ).rejects.toThrow(/allowlist/);
    expect(called).toBe(0);
  });

  test('uses redirect:manual on the initial GET', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchReleaseAsset(GOOD_URL, fetchImpl);
    expect(res.ok).toBe(true);
    expect(seen?.redirect).toBe('manual');
  });

  test('follows allowlisted redirect to release-assets CDN', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u === GOOD_URL) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc',
          },
        });
      }
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchReleaseAsset(GOOD_URL, fetchImpl);
    expect(res.ok).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('release-assets.githubusercontent.com');
  });

  test('rejects redirect to evil host', async () => {
    const fetchImpl = (async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/malware.bin' },
      });
    }) as unknown as typeof fetch;

    await expect(fetchReleaseAsset(GOOD_URL, fetchImpl)).rejects.toThrow(
      /redirect host not allowlisted/,
    );
  });

  test('rejects http redirect scheme', async () => {
    const fetchImpl = (async () => {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'http://release-assets.githubusercontent.com/asset',
        },
      });
    }) as unknown as typeof fetch;

    await expect(fetchReleaseAsset(GOOD_URL, fetchImpl)).rejects.toThrow(
      /redirect scheme not https/,
    );
  });
});
