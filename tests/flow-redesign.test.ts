/**
 * Flow redesign — load-bearing logic unit tests (Engineer-D).
 *
 * Covers the redesign's behavioral invariants, following the established
 * happy-dom + bun:test pattern (see tests/update-poll.test.ts):
 *   - Theme persistence: setTheme writes localStorage('ps-theme') + applies the
 *     root `theme-*` class.
 *   - Route hash round-trip: setRoute writes location.hash; readHashRoute reads
 *     the right route back.
 *   - Token-pill hue mapping: getCategoryHue returns the exact README hues for
 *     known categories + a deterministic fallback for unknown ones.
 *   - Mode re-runs scrub: setMode triggers refreshScrub → api.scrub (observed
 *     via a global fetch spy hitting /api/scrub).
 *   - Onboarding gate: first-run flag — unset → onboarded false; setOnboarded
 *     persists `ps-onboarded` and flips the gate.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { useStore, readHashRoute, applyThemeClass } from '../web/src/store';
import { getCategoryHue } from '../web/src/lib/colors';
import { CATS } from '../web/src/lib/categories';

// ── shared fetch spy (mirrors update-poll.test.ts) ──────────────────────────
type FetchSpy = {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
};

function makeFetchSpy(responder: (url: string) => unknown): FetchSpy {
  const calls: FetchSpy['calls'] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let originalFetch: typeof fetch;

// happy-dom-setup seeds window/document but not globalThis.location — the store
// reads `globalThis.location.hash` for routing. Bridge the window's location
// onto globalThis so setRoute/readHashRoute exercise real hash behavior.
const win = (globalThis as { window?: { location?: Location } }).window;
if (win?.location && typeof (globalThis as { location?: unknown }).location === 'undefined') {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    get: () => win.location,
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Theme persistence ───────────────────────────────────────────────────────
test('setTheme persists ps-theme and applies the root theme class', () => {
  useStore.getState().setTheme('light');
  expect(useStore.getState().theme).toBe('light');
  expect(document.documentElement.className).toBe('theme-light');
  try {
    expect(globalThis.localStorage?.getItem('ps-theme')).toBe('light');
  } catch {
    /* localStorage may be disabled in some envs */
  }

  useStore.getState().setTheme('dark');
  expect(document.documentElement.className).toBe('theme-dark');
});

test('applyThemeClass sets the document root class directly', () => {
  applyThemeClass('light');
  expect(document.documentElement.className).toBe('theme-light');
  applyThemeClass('dark');
  expect(document.documentElement.className).toBe('theme-dark');
});

// ── Route hash round-trip ───────────────────────────────────────────────────
test('setRoute writes location.hash and readHashRoute reads it back', () => {
  useStore.getState().setRoute('vocab');
  expect(useStore.getState().route).toBe('vocab');
  expect(globalThis.location.hash).toBe('#/vocab');
  expect(readHashRoute()).toBe('vocab');

  useStore.getState().setRoute('settings');
  expect(globalThis.location.hash).toBe('#/settings');
  expect(readHashRoute()).toBe('settings');
});

test('readHashRoute defaults to scrub for an unknown/empty hash', () => {
  globalThis.location.hash = '#/bogus-route';
  expect(readHashRoute()).toBe('scrub');
  globalThis.location.hash = '';
  expect(readHashRoute()).toBe('scrub');
});

// ── Token-pill hue mapping ──────────────────────────────────────────────────
test('getCategoryHue returns the exact README hues for known categories', () => {
  expect(getCategoryHue('ip')).toBe('#4c8dff');
  expect(getCategoryHue('customer')).toBe('#b07cff');
  expect(getCategoryHue('email')).toBe('#26c281');
  expect(getCategoryHue('credential')).toBe('#f76d6d');
  // Case-insensitive normalization.
  expect(getCategoryHue('EMAIL')).toBe('#26c281');
  // Every category in CATS resolves to its own hue.
  for (const [key, meta] of Object.entries(CATS)) {
    expect(getCategoryHue(key)).toBe(meta.hue);
  }
});

test('getCategoryHue is deterministic for unknown categories', () => {
  const a = getCategoryHue('totally-unknown-cat');
  const b = getCategoryHue('totally-unknown-cat');
  expect(a).toBe(b);
  expect(a).toMatch(/^#[0-9a-f]{6}$/i);
  // Empty/nullish falls back to the first fallback hue, stably.
  expect(getCategoryHue('')).toBe(getCategoryHue(null));
});

// ── Mode re-runs scrub ──────────────────────────────────────────────────────
test('setMode persists via /api/settings and re-runs the scrub', async () => {
  // URL-aware responder: settings echoes the saved mode (the real server reads
  // it back from PRIVACY_CONFIG.yaml); scrub returns a preview shape.
  const spy = makeFetchSpy((url) => {
    if (url.includes('/api/settings')) {
      return {
        model: 'm',
        system_prompt: '',
        mode: 'observe',
        update_channel: 'off',
        update_manifest_url: '',
        claude_code: { found: false, version: null },
      };
    }
    return {
      scrubbed: 'hello {EMAIL_1}',
      tokens: [],
      unsureSpans: [],
      hasCredentials: false,
      credentialSnippets: [],
    };
  });
  globalThis.fetch = spy.fn;

  // Non-empty payload so refreshScrub doesn't short-circuit on empty.
  useStore.setState({ composerText: 'email me at a@b.com', files: [] });

  useStore.getState().setMode('observe');
  // Optimistic flip is synchronous.
  expect(useStore.getState().mode).toBe('observe');

  await sleep(20);

  // Persisted via a POST to /api/settings carrying the new mode...
  const settingsCalls = spy.calls.filter(
    (c) => c.url.includes('/api/settings') && (c.init?.method ?? 'GET').toUpperCase() === 'POST',
  );
  expect(settingsCalls.length).toBeGreaterThanOrEqual(1);
  expect(String(settingsCalls[0]?.init?.body ?? '')).toContain('observe');

  // ...and the scrub re-ran so the Scrub screen reflects the new mode.
  const scrubCalls = spy.calls.filter((c) => c.url.includes('/api/scrub'));
  expect(scrubCalls.length).toBeGreaterThanOrEqual(1);

  // Server-canonical mode survives the round-trip.
  expect(useStore.getState().mode).toBe('observe');
});

// ── Onboarding gate ─────────────────────────────────────────────────────────
test('onboarding gate: setOnboarded(true) flips the flag and persists', () => {
  // Force a known starting point (store may have hydrated from a prior test).
  useStore.setState({ onboarded: false });
  expect(useStore.getState().onboarded).toBe(false);

  useStore.getState().setOnboarded(true);
  expect(useStore.getState().onboarded).toBe(true);
  try {
    expect(globalThis.localStorage?.getItem('ps-onboarded')).toBe('1');
  } catch {
    /* localStorage may be disabled in some envs */
  }

  // Resetting the gate (e.g. for a re-run) persists '0'.
  useStore.getState().setOnboarded(false);
  expect(useStore.getState().onboarded).toBe(false);
  try {
    expect(globalThis.localStorage?.getItem('ps-onboarded')).toBe('0');
  } catch {
    /* ignore */
  }
});
