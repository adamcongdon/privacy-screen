/**
 * Regression test for #141: clearing vocab issued one DELETE request per
 * stored value (`forgetVocab` in a loop), so any collection larger than the
 * server's rate limit (10 req / 10s, server/lib/rate-limit.ts) failed
 * partway through with 429s, leaving the vocab half-cleared.
 *
 * The server already exposes a bulk `DELETE /api/vocab` (issue #87,
 * server/routes/vocab.ts:58-67) — this wires the frontend to call it once
 * instead of looping. See tests/update-poll.test.ts for the fetch-spy
 * pattern this borrows.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { useStore } from '../web/src/store';

type FetchSpy = {
  fn: typeof fetch;
  calls: Array<{ url: string; method: string }>;
};

function makeFetchSpy(): FetchSpy {
  const calls: FetchSpy['calls'] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'DELETE' && url === '/api/vocab') {
      return new Response(JSON.stringify({ deleted: 42, remaining: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'GET' && url === '/api/vocab') {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in clear-vocab test: ${method} ${url}`);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Empty composer payload so refreshScrub() short-circuits without a fetch.
  useStore.setState({ composerText: '', files: [] });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('SCR-141 clearAllVocab issues a single bulk DELETE, not one per row', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;

  const result = await useStore.getState().clearAllVocab();

  expect(result).toEqual({ deleted: 42, remaining: 0 });
  const deletes = spy.calls.filter((c) => c.method === 'DELETE');
  expect(deletes).toEqual([{ url: '/api/vocab', method: 'DELETE' }]);
});
