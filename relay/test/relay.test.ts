/**
 * Unit tests for the feedback relay Worker. Run with `bun test` inside relay/.
 *
 * We call the Worker's exported `default.fetch(request, env)` directly with a
 * mocked KV namespace and a mocked global `fetch` (for the GitHub call), so the
 * tests never touch the network.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import worker, { hmacHex, timingSafeEqualHex, type Env } from '../src/index';

const KEY = 'test-hmac-key';

/** In-memory KV stub implementing just get/put. */
function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GH_TOKEN: 'fake-token',
    APP_HMAC_KEY: KEY,
    RATE_LIMIT: makeKV(),
    ...overrides,
  };
}

async function signedRequest(
  payload: unknown,
  opts: { key?: string; sig?: string; ip?: string } = {},
): Promise<Request> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = opts.sig ?? (await hmacHex(raw, opts.key ?? KEY));
  return new Request('https://relay.example/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PS-Sig': sig,
      'CF-Connecting-IP': opts.ip ?? '1.2.3.4',
    },
    body: raw,
  });
}

const VALID_PAYLOAD = { title: 'Something broke', body: 'steps to repro', type: 'bug' };

let originalFetch: typeof globalThis.fetch;
let ghCall: { url: string; init: RequestInit | undefined } | null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  ghCall = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockGithub(status = 201, payload: unknown = { number: 123, html_url: 'https://github.com/adamcongdon/privacy-screen/issues/123' }): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    ghCall = { url: String(url), init };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

// ── Routing ──────────────────────────────────────────────────────────────────

describe('routing', () => {
  test('404 on unknown path', async () => {
    const res = await worker.fetch(new Request('https://relay.example/nope', { method: 'POST' }), makeEnv());
    expect(res.status).toBe(404);
  });

  test('405 on wrong method', async () => {
    const res = await worker.fetch(new Request('https://relay.example/feedback', { method: 'GET' }), makeEnv());
    expect(res.status).toBe(405);
  });
});

// ── Misconfiguration guard ────────────────────────────────────────────────────

describe('misconfiguration guard', () => {
  test('503 when APP_HMAC_KEY is the insecure default', async () => {
    const env = makeEnv({ APP_HMAC_KEY: 'ps_feedback_relay_v1_change_me_in_prod' });
    const req = await signedRequest(VALID_PAYLOAD, { key: 'ps_feedback_relay_v1_change_me_in_prod' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);
  });

  test('503 when APP_HMAC_KEY is empty', async () => {
    const env = makeEnv({ APP_HMAC_KEY: '' });
    // The guard fires before HMAC, so the signature value is irrelevant here.
    const req = await signedRequest(VALID_PAYLOAD, { sig: 'deadbeef' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);
  });
});

// ── HMAC gate ────────────────────────────────────────────────────────────────

describe('HMAC auth', () => {
  test('401 on a bad signature', async () => {
    const req = await signedRequest(VALID_PAYLOAD, { sig: 'deadbeef' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  test('401 on a missing signature', async () => {
    const raw = JSON.stringify(VALID_PAYLOAD);
    const req = new Request('https://relay.example/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });

  test('401 when the key does not match', async () => {
    const req = await signedRequest(VALID_PAYLOAD, { key: 'wrong-key' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });
});

// ── Size cap ─────────────────────────────────────────────────────────────────

describe('size cap', () => {
  test('413 on an oversized body', async () => {
    const big = { title: 'x', body: 'y'.repeat(40_000), type: 'bug' };
    const req = await signedRequest(big);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(413);
  });
});

// ── Payload validation ───────────────────────────────────────────────────────

describe('payload validation', () => {
  test('400 on an invalid type', async () => {
    const req = await signedRequest({ title: 't', body: 'b', type: 'spam' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  test('400 on a missing body field', async () => {
    const req = await signedRequest({ title: 't', type: 'bug' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  test('400 on a non-JSON (but correctly-signed) body', async () => {
    const req = await signedRequest('this is not json');
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });
});

// ── Rate limiting ────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  test('429 once the per-IP window is exhausted', async () => {
    mockGithub();
    const env = makeEnv({ RATE_LIMIT_MAX: '1' });
    const first = await worker.fetch(await signedRequest(VALID_PAYLOAD), env);
    expect(first.status).toBe(200);
    const second = await worker.fetch(await signedRequest(VALID_PAYLOAD), env);
    expect(second.status).toBe(429);
  });

  test('separate IPs have independent budgets', async () => {
    mockGithub();
    const env = makeEnv({ RATE_LIMIT_MAX: '1' });
    const a = await worker.fetch(await signedRequest(VALID_PAYLOAD, { ip: '9.9.9.9' }), env);
    const b = await worker.fetch(await signedRequest(VALID_PAYLOAD, { ip: '8.8.8.8' }), env);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

// ── Happy path → GitHub issue ────────────────────────────────────────────────

describe('issue creation', () => {
  test('200 with issueNumber + issueUrl on a GitHub 201', async () => {
    mockGithub(201, { number: 123, html_url: 'https://github.com/adamcongdon/privacy-screen/issues/123' });
    const res = await worker.fetch(await signedRequest(VALID_PAYLOAD), makeEnv());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; issueNumber: number; issueUrl: string };
    expect(j.ok).toBe(true);
    expect(j.issueNumber).toBe(123);
    expect(j.issueUrl).toBe('https://github.com/adamcongdon/privacy-screen/issues/123');
  });

  test('forwards Bearer auth + the three labels to GitHub', async () => {
    mockGithub();
    await worker.fetch(await signedRequest({ title: 't', body: 'b', type: 'enhancement' }), makeEnv());
    expect(ghCall).not.toBeNull();
    const headers = ghCall!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fake-token');
    const sent = JSON.parse(String(ghCall!.init?.body)) as { labels: string[] };
    expect(sent.labels).toEqual(['feedback', 'feedback/unverified', 'enhancement']);
  });

  test('502 (generic) when GitHub returns non-201', async () => {
    mockGithub(422, { message: 'Validation Failed' });
    const res = await worker.fetch(await signedRequest(VALID_PAYLOAD), makeEnv());
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('failed to file issue');
    // The PAT must never appear in a client-facing error.
    expect(JSON.stringify(j)).not.toContain('fake-token');
  });
});

// ── Crypto helpers ───────────────────────────────────────────────────────────

describe('crypto helpers', () => {
  test('hmacHex is stable + 64 hex chars', async () => {
    const a = await hmacHex('hello', KEY);
    const b = await hmacHex('hello', KEY);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('timingSafeEqualHex: equal vs unequal vs length-mismatch', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(false);
  });
});
