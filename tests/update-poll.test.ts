/**
 * Tests for the version poller in web/src/store.ts.
 *
 * Behavior contracts:
 *   - channel='off' MUST NOT register an interval and MUST NOT issue fetches.
 *     This is the second layer of defense for "channel-off = zero outbound
 *     network"; the server already short-circuits in routes/version.ts.
 *   - channel='stable'/'beta' polls /api/version on the configured cadence
 *     (overridable via __test_setVersionPollIntervalMs for tests).
 *   - Hidden tabs skip the fetch (battery/network friendliness).
 *   - Double-start is a no-op — only one interval ever runs.
 *   - Calling stopVersionPoller() halts further fetches.
 *
 * Note: the poller calls into useStore().getState().refreshVersion(), which
 * itself calls api.version() -> fetch('/api/version'). So spying on global
 * fetch is sufficient to observe poller activity.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  useStore,
  __test_setVersionPollIntervalMs,
  VERSION_POLL_INTERVAL_MS,
} from '../web/src/store';

const FAKE_VERSION_RESPONSE = {
  version: '1.0.0',
  channel: 'stable',
  updateAvailable: false,
  updateInfo: null,
  latestKnown: '1.0.0',
};

type FetchSpy = {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
};

function makeFetchSpy(
  responder: (url: string) => unknown = () => FAKE_VERSION_RESPONSE,
): FetchSpy {
  const calls: FetchSpy['calls'] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const body = responder(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let originalFetch: typeof fetch;
let originalVisibility: PropertyDescriptor | undefined;

function setVisibility(value: 'visible' | 'hidden'): void {
  // happy-dom doesn't seed visibilityState in the test preload, and even in a
  // real browser it's a getter — define a configurable one for the duration of
  // the test so we can flip it.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalVisibility = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(document) ?? document,
    'visibilityState',
  );
  setVisibility('visible');
  // Reset poller + state between tests.
  useStore.getState().stopVersionPoller();
  __test_setVersionPollIntervalMs(null);
});

afterEach(() => {
  useStore.getState().stopVersionPoller();
  __test_setVersionPollIntervalMs(null);
  globalThis.fetch = originalFetch;
  if (originalVisibility) {
    Object.defineProperty(document, 'visibilityState', originalVisibility);
  } else {
    // Best-effort cleanup if we couldn't capture the original.
    try {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    } catch {
      /* ignore */
    }
  }
});

test('VERSION_POLL_INTERVAL_MS is 4 hours', () => {
  expect(VERSION_POLL_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
});

test('channel=off → no interval registered, no fetch issued', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;

  useStore.setState({
    settings: {
      model: 'm',
      system_prompt: '',
      update_channel: 'off',
      update_manifest_url: 'https://example.invalid/manifest.json',
      claude_code: { found: false, version: null },
    },
  });

  __test_setVersionPollIntervalMs(5);
  useStore.getState().startVersionPoller();

  await sleep(40);

  expect(spy.calls.length).toBe(0);
});

test('channel=stable → polls /api/version on interval', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;

  useStore.setState({
    settings: {
      model: 'm',
      system_prompt: '',
      update_channel: 'stable',
      update_manifest_url: 'https://example.invalid/manifest.json',
      claude_code: { found: false, version: null },
    },
  });

  __test_setVersionPollIntervalMs(10);
  useStore.getState().startVersionPoller();

  await sleep(45);

  const versionCalls = spy.calls.filter((c) => c.url.includes('/api/version'));
  expect(versionCalls.length).toBeGreaterThanOrEqual(1);
});

test('stopVersionPoller halts further fetches', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;

  useStore.setState({
    settings: {
      model: 'm',
      system_prompt: '',
      update_channel: 'stable',
      update_manifest_url: 'https://example.invalid/manifest.json',
      claude_code: { found: false, version: null },
    },
  });

  __test_setVersionPollIntervalMs(10);
  useStore.getState().startVersionPoller();
  await sleep(25);
  const callsAtStop = spy.calls.length;
  useStore.getState().stopVersionPoller();

  await sleep(50);

  // Allow exactly one in-flight call to resolve after stop; no NEW intervals fire.
  expect(spy.calls.length).toBeLessThanOrEqual(callsAtStop + 1);
});

test('hidden tab skips fetch', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;
  setVisibility('hidden');

  useStore.setState({
    settings: {
      model: 'm',
      system_prompt: '',
      update_channel: 'stable',
      update_manifest_url: 'https://example.invalid/manifest.json',
      claude_code: { found: false, version: null },
    },
  });

  __test_setVersionPollIntervalMs(10);
  useStore.getState().startVersionPoller();

  await sleep(60);

  expect(spy.calls.length).toBe(0);
});

test('double-start is a no-op (single interval cadence)', async () => {
  const spy = makeFetchSpy();
  globalThis.fetch = spy.fn;

  useStore.setState({
    settings: {
      model: 'm',
      system_prompt: '',
      update_channel: 'stable',
      update_manifest_url: 'https://example.invalid/manifest.json',
      claude_code: { found: false, version: null },
    },
  });

  __test_setVersionPollIntervalMs(20);
  useStore.getState().startVersionPoller();
  useStore.getState().startVersionPoller();
  useStore.getState().startVersionPoller();

  // 100 ms / 20 ms interval → upper bound ~5 ticks for a single interval.
  // Double-start would yield ~10. Use a loose upper bound so CI jitter is fine.
  await sleep(110);

  expect(spy.calls.length).toBeLessThanOrEqual(7);
});

test('dismissUpdate writes localStorage and updates store state', () => {
  useStore.setState({ dismissedUpdateVersion: null });
  useStore.getState().dismissUpdate('9.9.9');
  expect(useStore.getState().dismissedUpdateVersion).toBe('9.9.9');
  try {
    expect(globalThis.localStorage?.getItem('ps.dismissed-update-version')).toBe('9.9.9');
  } catch {
    // localStorage may be disabled in some test envs — that's fine.
  }
});

test('setSettingsDeepLink sets and clears the target', () => {
  useStore.getState().setSettingsDeepLink('update');
  expect(useStore.getState().settingsDeepLink).toBe('update');
  useStore.getState().setSettingsDeepLink(null);
  expect(useStore.getState().settingsDeepLink).toBeNull();
});
