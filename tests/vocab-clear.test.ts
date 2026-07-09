/**
 * Regression test for #141/#87: "Clear vocab" must issue a single bulk
 * DELETE /api/vocab request instead of looping a DELETE per stored value.
 *
 * The per-row loop (SettingsPage.tsx's old DataPrivacyCard.onClear) drove
 * store.forgetVocab once per row, which on a vocabulary of hundreds/thousands
 * of entries blew through the server's 10-req/10s rate limit (server/lib/
 * rate-limit.ts) — surfacing as a wall of 429s and a toast per failed row.
 * A bulk `DELETE /api/vocab` route already existed server-side
 * (server/routes/vocab.ts:58, vs.clearAll()) but nothing on the client called
 * it. This pins store.clearVocab() to that single-request contract, and
 * pins SettingsPage's Clear-vocab button to calling it instead of looping.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useStore } from '../web/src/store';

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PAGE_PATH = resolve(here, '../web/src/components/flow/SettingsPage.tsx');

type FetchSpy = {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
};

function makeFetchSpy(responder: (url: string, init?: RequestInit) => unknown): FetchSpy {
  const calls: FetchSpy['calls'] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url, init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  useStore.setState({ vocab: [], toasts: [] });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('clearVocab() issues exactly one DELETE /api/vocab request, not one per row', async () => {
  useStore.setState({
    vocab: Array.from({ length: 250 }, (_, i) => ({
      real_value: `value-${i}`,
      token: `TOKEN_${i}`,
      category: 'customer',
      confidence: 1,
      first_seen: '',
      last_seen: '',
      hit_count: 1,
      confirmed_by: null,
    })),
  });

  const spy = makeFetchSpy((url, init) => {
    if (url.endsWith('/api/vocab') && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      return { deleted: 250, remaining: 0 };
    }
    if (url.includes('/api/vocab')) return { rows: [] }; // refreshVocab GET
    return { scrubbed: '', tokens: [], unsureSpans: [], hasCredentials: false, credentialSnippets: [] };
  });
  globalThis.fetch = spy.fn;

  await useStore.getState().clearVocab();

  const vocabDeletes = spy.calls.filter(
    (c) => c.url.includes('/api/vocab') && (c.init?.method ?? 'GET').toUpperCase() === 'DELETE',
  );
  expect(vocabDeletes).toHaveLength(1);
  expect(vocabDeletes[0]?.url.endsWith('/api/vocab')).toBe(true);
});

test('clearVocab() refreshes vocab and pushes exactly one success toast', async () => {
  useStore.setState({
    vocab: [
      { real_value: 'a', token: 'T1', category: 'customer', confidence: 1, first_seen: '', last_seen: '', hit_count: 1, confirmed_by: null },
    ],
  });

  const spy = makeFetchSpy((url, init) => {
    if (url.endsWith('/api/vocab') && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
      return { deleted: 1, remaining: 0 };
    }
    if (url.includes('/api/vocab')) return { rows: [] };
    return { scrubbed: '', tokens: [], unsureSpans: [], hasCredentials: false, credentialSnippets: [] };
  });
  globalThis.fetch = spy.fn;

  await useStore.getState().clearVocab();

  expect(useStore.getState().vocab).toEqual([]);
  expect(useStore.getState().toasts).toHaveLength(1);
  expect(useStore.getState().toasts[0]?.kind).toBe('success');
  expect(useStore.getState().toasts[0]?.message).toContain('Cleared 1 value');
});

test('DataPrivacyCard (Settings → Data & privacy) calls clearVocab, not a per-row forgetVocab loop (mount-guard)', () => {
  const src = readFileSync(SETTINGS_PAGE_PATH, 'utf8');
  const cardStart = src.indexOf('function DataPrivacyCard');
  expect(cardStart).toBeGreaterThan(-1);
  const cardEnd = src.indexOf('\n}\n', cardStart);
  const card = src.slice(cardStart, cardEnd);

  expect(card).toContain('clearVocab');
  expect(card).not.toMatch(/for\s*\(.*of.*\)\s*{[^}]*forgetVocab/s);
});
