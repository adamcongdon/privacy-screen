/**
 * Pattern Suggestions UI — restoration tests (Engineer).
 *
 * The pattern-induction backend (server/routes/patterns.ts) and the Zustand
 * wiring (patterns + refreshPatterns/suggestPatterns/patternAction) survived the
 * Flow redesign, but the UI that drove them — components/PatternSuggestions.tsx —
 * was deleted in 3a15e30 and never ported into flow/. These tests pin the
 * behavior back down so it can't silently vanish again:
 *
 *   1. Store contract (fetch-spy, mirrors flow-redesign.test.ts):
 *      - suggestPatterns() POSTs /api/patterns/suggest and populates store.patterns
 *      - patternAction(id,'activate') POSTs /api/patterns/:id with action=activate
 *      - patternAction(id,'reject')   POSTs /api/patterns/:id with action=reject
 *      - refreshPatterns() GETs /api/patterns and populates store.patterns
 *   2. Static mount-guard: flow/ReviewPage.tsx references the patterns store
 *      actions + renders the pattern UI section (regression fence — the feature
 *      can't be dropped without breaking this test).
 *   3. Render smoke: the restored section mounts inside ReviewPage and shows the
 *      Suggest control + a pending pattern's activate/reject affordances.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useStore } from '../web/src/store';
import { ReviewPage } from '../web/src/components/flow/ReviewPage';
import type { InducedPatternDto } from '../web/src/api';

const here = dirname(fileURLToPath(import.meta.url));
const REVIEW_PAGE_PATH = resolve(here, '../web/src/components/flow/ReviewPage.tsx');
const PATTERN_UI_PATH = resolve(here, '../web/src/components/flow/PatternSuggestions.tsx');

// React 18 testing env opt-in (mirrors update-banner.test.ts).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── shared fetch spy (mirrors flow-redesign.test.ts) ────────────────────────
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pattern(over: Partial<InducedPatternDto> = {}): InducedPatternDto {
  return {
    id: 1,
    category: 'customer',
    regex_source: 'ACME-\\d{4}',
    skeleton: 'ACME-####',
    source_examples: ['ACME-1234', 'ACME-5678', 'ACME-9012'],
    example_count: 3,
    confidence: 0.91,
    status: 'pending',
    hit_count: 0,
    first_seen: 0,
    last_seen: 0,
    ...over,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  useStore.setState({ patterns: [] });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── 1. Store contract ───────────────────────────────────────────────────────

test('suggestPatterns POSTs /api/patterns/suggest and populates store.patterns', async () => {
  const items = [pattern({ id: 7, skeleton: 'INV-####' })];
  const spy = makeFetchSpy((url) =>
    url.includes('/api/patterns/suggest') ? { items } : { items: [] },
  );
  globalThis.fetch = spy.fn;

  await useStore.getState().suggestPatterns();

  const suggestCall = spy.calls.find((c) => c.url.includes('/api/patterns/suggest'));
  expect(suggestCall).toBeDefined();
  expect((suggestCall?.init?.method ?? 'GET').toUpperCase()).toBe('POST');
  expect(useStore.getState().patterns).toHaveLength(1);
  expect(useStore.getState().patterns[0]?.skeleton).toBe('INV-####');
});

test('suggestPatterns forwards a category in the request body', async () => {
  const spy = makeFetchSpy(() => ({ items: [] }));
  globalThis.fetch = spy.fn;

  await useStore.getState().suggestPatterns('customer');

  const suggestCall = spy.calls.find((c) => c.url.includes('/api/patterns/suggest'));
  expect(String(suggestCall?.init?.body ?? '')).toContain('customer');
});

test("patternAction('activate') POSTs /api/patterns/:id with action=activate", async () => {
  // activate triggers a refresh + a re-scrub; the responder must satisfy all of
  // /api/patterns/:id, GET /api/patterns, and /api/scrub.
  const spy = makeFetchSpy((url) => {
    if (url.includes('/api/scrub')) {
      return { scrubbed: '', tokens: [], unsureSpans: [], hasCredentials: false, credentialSnippets: [] };
    }
    if (/\/api\/patterns\/\d+/.test(url)) return { ok: true };
    return { items: [] }; // GET /api/patterns
  });
  globalThis.fetch = spy.fn;

  await useStore.getState().patternAction(42, 'activate');

  const actionCall = spy.calls.find((c) => /\/api\/patterns\/42$/.test(c.url));
  expect(actionCall).toBeDefined();
  expect((actionCall?.init?.method ?? 'GET').toUpperCase()).toBe('POST');
  expect(String(actionCall?.init?.body ?? '')).toContain('activate');
});

test("patternAction('reject') POSTs /api/patterns/:id with action=reject", async () => {
  const spy = makeFetchSpy((url) => (/\/api\/patterns\/\d+/.test(url) ? { ok: true } : { items: [] }));
  globalThis.fetch = spy.fn;

  await useStore.getState().patternAction(99, 'reject');

  const actionCall = spy.calls.find((c) => /\/api\/patterns\/99$/.test(c.url));
  expect(actionCall).toBeDefined();
  expect((actionCall?.init?.method ?? 'GET').toUpperCase()).toBe('POST');
  expect(String(actionCall?.init?.body ?? '')).toContain('reject');
});

test("patternAction('edit') forwards the new regex in the body", async () => {
  const spy = makeFetchSpy((url) => (/\/api\/patterns\/\d+/.test(url) ? { ok: true } : { items: [] }));
  globalThis.fetch = spy.fn;

  await useStore.getState().patternAction(5, 'edit', 'NEW-\\d+');

  const actionCall = spy.calls.find((c) => /\/api\/patterns\/5$/.test(c.url));
  expect(String(actionCall?.init?.body ?? '')).toContain('edit');
  expect(String(actionCall?.init?.body ?? '')).toContain('NEW-');
});

test('refreshPatterns GETs /api/patterns and populates store.patterns', async () => {
  const items = [pattern({ id: 3 }), pattern({ id: 4, skeleton: 'X-##' })];
  const spy = makeFetchSpy((url) => (url.includes('/api/patterns') ? { items } : { items: [] }));
  globalThis.fetch = spy.fn;

  await useStore.getState().refreshPatterns();

  const getCall = spy.calls.find(
    (c) => c.url.includes('/api/patterns') && (c.init?.method ?? 'GET').toUpperCase() === 'GET',
  );
  expect(getCall).toBeDefined();
  expect(useStore.getState().patterns).toHaveLength(2);
  expect(useStore.getState().patterns.map((p) => p.id)).toEqual([3, 4]);
});

// ── 2. Static mount-guard (regression fence) ────────────────────────────────

test('ReviewPage mounts the pattern suggestions UI (mount-guard)', () => {
  // ReviewPage is the Flow shell's home for the induced-pattern UI. It must
  // actually render the section — asserting on the rendered tag (not just an
  // import) is what makes this a real regression fence: a dropped <PatternSuggestions/>
  // breaks this test even if the import lingers.
  const review = readFileSync(REVIEW_PAGE_PATH, 'utf8');
  expect(review).toMatch(/<PatternSuggestions\s*\/>/);
  expect(review).toContain("from './PatternSuggestions'");
});

test('PatternSuggestions wires all three pattern store actions (mount-guard)', () => {
  // The induced-pattern UI must consume every pattern action so the feature can
  // never be silently reduced to a dead shell without a test failing.
  const ui = readFileSync(PATTERN_UI_PATH, 'utf8');
  expect(ui).toContain('refreshPatterns');
  expect(ui).toContain('suggestPatterns');
  expect(ui).toContain('patternAction');
  expect(ui).toMatch(/activate/);
  expect(ui).toMatch(/reject/);
  expect(ui).toMatch(/edit/);
});

// ── 3. Render smoke ─────────────────────────────────────────────────────────

let container: HTMLElement;
let root: Root;

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

test('ReviewPage renders the pattern suggestions section with a pending pattern', async () => {
  const items = [pattern({ id: 11, skeleton: 'ACME-####' })];
  const spy = makeFetchSpy((url) => {
    if (url.includes('/api/patterns')) return { items };
    return { items: [] }; // /api/review returns { items }
  });
  globalThis.fetch = spy.fn;
  useStore.setState({ reviewItems: [], patterns: [] });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  render(React.createElement(ReviewPage));
  // Allow mount effects (refreshReview + refreshPatterns) to resolve.
  await act(async () => {
    await sleep(30);
  });

  const html = container.innerHTML;
  // Section is present and shows the pending pattern + its action affordances.
  expect(html).toMatch(/pattern/i);
  expect(html).toContain('ACME-####');
  expect(html.toLowerCase()).toContain('activate');
  expect(html.toLowerCase()).toContain('reject');

  act(() => {
    root.unmount();
  });
  container.remove();
});
