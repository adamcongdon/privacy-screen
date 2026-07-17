/**
 * #84 option A — Disabled = true emergency bypass (matches hook early-return).
 *
 * Acceptance:
 *   1. Header shows a real Disabled state (no disabled→observe coercion).
 *   2. Scrub footer + Settings agree: text passes through untouched (no tokens).
 *   3. Confirm-before-Send while disabled.
 *   4. Client preview + send skip scrub when mode is disabled (raw payload).
 *   5. Server /api/send passthrough when cfg.mode === 'disabled'.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useStore } from '../web/src/store';
import { ScrubMap } from '../src/scrub-map';
import type { PrivacyConfig } from '../src/config';
import { resolveSystemPrompt } from '../server/routes/send';

const ROOT = join(import.meta.dir, '..');

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

// ── Source contracts (UI truth) ─────────────────────────────────────────────

describe('#84 UI source contracts', () => {
  test('ScrubHeaderRight exposes Disabled and does not coerce to Observe', () => {
    const src = readSrc('web/src/components/flow/ScrubSend.tsx');
    // Real third option present.
    expect(src).toMatch(/value:\s*['"]disabled['"]\s*,\s*label:\s*['"]Disabled['"]/);
    // Coercion of disabled → observe is gone.
    expect(src).not.toMatch(/mode\s*===\s*['"]disabled['"]\s*\?\s*['"]observe['"]/);
    // Segmented value is the true mode.
    expect(src).toMatch(/value=\{mode\}/);
  });

  test('footer copy agrees with Settings: passthrough, not tokenized', () => {
    const scrub = readSrc('web/src/components/flow/ScrubSend.tsx');
    const settings = readSrc('web/src/components/flow/SettingsPage.tsx');
    expect(settings).toMatch(/passes through untouched/);
    // Old lying copy must be gone.
    expect(scrub).not.toMatch(/values are still tokenized before sending/);
    // New copy must claim passthrough / untouched / raw.
    expect(scrub).toMatch(/passes through untouched|raw (text|prompts?) pass|Emergency bypass/i);
  });

  test('Send while disabled requires window.confirm', () => {
    const src = readSrc('web/src/components/flow/ScrubSend.tsx');
    expect(src).toMatch(/window\.confirm|globalThis\.confirm/);
    // Confirm path is gated on disabled mode.
    expect(src).toMatch(/mode\s*===\s*['"]disabled['"]|disabled\)/);
    expect(src).toMatch(/confirm/);
  });
});

// ── Store: refreshScrub + send passthrough ──────────────────────────────────

type FetchSpy = {
  fn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
};

function makeFetchSpy(responder: (url: string, init?: RequestInit) => unknown): FetchSpy {
  const calls: FetchSpy['calls'] = [];
  const fn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    // SSE-ish empty body for /api/send — store only needs stream close for done path;
    // we short-circuit by never completing stream in unit tests that don't await fully.
    if (url.includes('/api/send')) {
      return new Response('', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
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
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('#84 store disabled passthrough', () => {
  test('refreshScrub in disabled mode sets raw text and skips /api/scrub', async () => {
    const raw = 'email me at alice@corp.example and host 10.1.2.3';
    const spy = makeFetchSpy((url) => {
      if (url.includes('/api/scrub')) {
        return {
          scrubbed: 'SHOULD_NOT_USE {EMAIL_1} {IP_1}',
          tokens: [{ token: '{EMAIL_1}', category: 'email', real: 'alice@corp.example' }],
          unsureSpans: [],
          hasCredentials: false,
          credentialSnippets: [],
        };
      }
      return {
        model: 'm',
        system_prompt: '',
        mode: 'disabled',
        update_channel: 'off',
        update_manifest_url: '',
        claude_code: { found: false, version: null },
      };
    });
    globalThis.fetch = spy.fn;

    useStore.setState({
      mode: 'disabled',
      composerText: raw,
      files: [],
      scrubbed: '',
      tokens: [],
      isScrubbing: false,
      scrubError: null,
      hasCredentials: false,
    });

    await useStore.getState().refreshScrub();

    const scrubCalls = spy.calls.filter((c) => c.url.includes('/api/scrub'));
    expect(scrubCalls.length).toBe(0);
    expect(useStore.getState().scrubbed).toBe(raw);
    expect(useStore.getState().tokens).toEqual([]);
    expect(useStore.getState().hasCredentials).toBe(false);
    expect(useStore.getState().isScrubbing).toBe(false);
    expect(useStore.getState().scrubError).toBeNull();
  });

  test('send in disabled mode skips scrub-before-send and posts raw content', async () => {
    const raw = 'contact bob@acme.test about 192.168.1.50';
    const spy = makeFetchSpy(() => ({
      model: 'm',
      system_prompt: '',
      mode: 'disabled',
      update_channel: 'off',
      update_manifest_url: '',
      claude_code: { found: false, version: null },
    }));
    globalThis.fetch = spy.fn;

    useStore.setState({
      mode: 'disabled',
      composerText: raw,
      files: [],
      messages: [],
      isStreaming: false,
      hasCredentials: false,
      scrubbed: raw,
      tokens: [],
      settings: {
        model: 'sonnet',
        system_prompt: '',
        mode: 'disabled',
        update_channel: 'off',
        update_manifest_url: '',
        claude_code: { found: true, version: '1.0.0' },
      },
    });

    // Fire-and-forget: send opens SSE; we only assert the scrub skip + first message.
    const p = useStore.getState().send();
    // Give microtasks a beat for the scrub-skip + fetch to /api/send.
    await new Promise((r) => setTimeout(r, 30));
    // Abort any open stream so the test doesn't hang.
    useStore.getState().abortSend();
    await p.catch(() => undefined);

    const scrubCalls = spy.calls.filter((c) => c.url.includes('/api/scrub'));
    expect(scrubCalls.length).toBe(0);

    const sendCalls = spy.calls.filter((c) => c.url.includes('/api/send'));
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const body = String(sendCalls[0]?.init?.body ?? '');
    expect(body).toContain('bob@acme.test');
    expect(body).toContain('192.168.1.50');
    expect(body).not.toMatch(/\{EMAIL|\{IP/);
  });
});

// ── Server send route: disabled = raw ───────────────────────────────────────

const baseCfg = (): PrivacyConfig => ({
  fqdn_allowlist_extra: [],
  customer_names: [],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  skip_scrub_fields: {},
  update_channel: 'off',
  update_manifest_url:
    'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json',
  feedback_relay_url: 'https://privacy-screen-feedback.example.workers.dev',
  llm_validate: {
    enabled: false,
    model_path: null,
    runtime: 'llama-server',
    endpoint: null,
    max_tokens: 256,
    timeout_ms: 2500,
    min_confidence: 0.6,
  },
  hook: { auto_approve_clean: false, block_pii_in_tool_output: false },
});

describe('#84 server disabled passthrough', () => {
  test('send.ts early-returns raw messages when mode is disabled', () => {
    const src = readSrc('server/routes/send.ts');
    // Must branch on disabled mode before scrubText for message content.
    expect(src).toMatch(/mode\s*===\s*['"]disabled['"]/);
    expect(src).toMatch(/passthrough|disabled/i);
  });

  test('resolveSystemPrompt in disabled mode returns raw system text', () => {
    const cfg = { ...baseCfg(), mode: 'disabled' as const };
    const raw = 'You assist Acme. Contact admin@corp.example at 10.20.30.40';
    const out = resolveSystemPrompt(raw, new ScrubMap(), null, cfg);
    expect(out.hasCredentials).toBe(false);
    expect(out.system).toBe(raw);
    expect(out.system).toContain('admin@corp.example');
    expect(out.system).toContain('10.20.30.40');
  });

  test('resolveSystemPrompt still scrubs in enforce mode', () => {
    const cfg = baseCfg();
    const out = resolveSystemPrompt(
      'You assist Acme. Contact admin@corp.example at 10.20.30.40',
      new ScrubMap(),
      null,
      cfg,
    );
    expect(out.hasCredentials).toBe(false);
    expect(out.system).toBeDefined();
    expect(out.system!).not.toContain('10.20.30.40');
    expect(out.system!).not.toContain('admin@corp.example');
  });
});
