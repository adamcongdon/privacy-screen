/**
 * Server smoke tests — spawn the actual server process, hit endpoints, verify
 * the surface contract works end-to-end. Uses a throwaway PRIVACY_SCREEN_CONFIG
 * pointing at a temp DB so tests are isolated from the real vocab.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SERVER_PATH = new URL('../server/server.ts', import.meta.url).pathname;
const PORT = 31339; // separate from default to avoid colliding with a running server

let workDir: string;
let configPath: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForHealth(maxMs = 25_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Drain whatever the spawned server printed so the CI log explains the failure.
  if (proc) {
    const stdoutStream = proc.stdout instanceof ReadableStream ? proc.stdout : null;
    const stderrStream = proc.stderr instanceof ReadableStream ? proc.stderr : null;
    const serverStdout = stdoutStream ? await new Response(stdoutStream).text().catch(() => '') : '';
    const serverStderr = stderrStream ? await new Response(stderrStream).text().catch(() => '') : '';
    process.stderr.write(`[server-smoke] server failed to come up after ${maxMs}ms\n`);
    if (serverStdout) process.stderr.write(`[server-smoke] stdout:\n${serverStdout}\n`);
    if (serverStderr) process.stderr.write(`[server-smoke] stderr:\n${serverStderr}\n`);
  }
  throw new Error('server failed to come up');
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-server-'));
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  const dbPath = join(workDir, 'vocab.db');
  writeFileSync(
    configPath,
    `mode: observe\ndb_path: ${dbPath}\ncustomer_names:\n  - "Acme Corp"\n`,
  );

  proc = Bun.spawn(['bun', SERVER_PATH], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PRIVACY_SCREEN_CONFIG: configPath,
      PRIVACY_SCREEN_PORT: String(PORT),
      // Tests use x-forwarded-for headers to give each test its own rate-limit
      // bucket. Production defaults to TRUST_XFF=0 (loopback has no real proxy).
      TRUST_XFF: '1',
      // ubuntu-24.04 CI runners don't ship the `claude` CLI; smoke tests
      // exercise the routes that don't need inference, so bypass the gate.
      PRIVACY_SCREEN_SKIP_CLAUDE_CHECK: '1',
    },
  });
  await waitForHealth();
}, 30_000); // override Bun's 5s default — cold Linux runners can take >12s to boot the server

afterAll(async () => {
  if (proc) {
    proc.kill();
    await proc.exited;
  }
  rmSync(workDir, { recursive: true, force: true });
});

const api = (path: string): string => `http://127.0.0.1:${PORT}${path}`;

describe('server smoke — health + binding', () => {
  test('GET /api/health returns ok', async () => {
    const r = await fetch(api('/api/health'));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test('API requests with foreign Host header are rejected (DNS-rebind defense)', async () => {
    const r = await fetch(api('/api/vocab'), { headers: { Host: 'evil.example.com' } });
    expect(r.status).toBe(403);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('forbidden host');
  });

  test('POST /api/vocab rejects realValue containing zero-width chars', async () => {
    // Inject a credential prefix with a ZWSP — caught by expanded CONTROL_CHAR_RE.
    // Runs BEFORE the XFF-burst test so the rate-limit bucket has headroom.
    const sneaky = 'sk​-ant-abcdefghijklmnopqrstuvwx';
    const r = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue: sneaky, category: 'customer' }),
    });
    expect(r.status).toBe(400);
  });

});

describe('server smoke — /api/scrub', () => {
  test('preview scrub returns tokens and scrubbed text', async () => {
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Server 10.99.88.77 at acme.local', persist: false }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { scrubbed: string; tokens: unknown[] };
    expect(j.scrubbed).toContain('{IP');
    expect(j.scrubbed).toContain('{HOST');
    expect(j.tokens.length).toBeGreaterThanOrEqual(2);
    expect(j.scrubbed).not.toContain('10.99.88.77');
  });

  test('credential in text → hasCredentials true', async () => {
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12',
        persist: false,
      }),
    });
    const j = (await r.json()) as { hasCredentials: boolean };
    expect(j.hasCredentials).toBe(true);
  });

  test('empty text returns empty result', async () => {
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    const j = (await r.json()) as { scrubbed: string; modified: boolean };
    expect(j.scrubbed).toBe('');
    expect(j.modified).toBe(false);
  });
});

describe('server smoke — /api/vocab', () => {
  test('GET returns rows (may be empty initially)', async () => {
    const r = await fetch(api('/api/vocab'));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { rows: unknown[] };
    expect(Array.isArray(j.rows)).toBe(true);
  });

  test('POST adds a customer name', async () => {
    const r = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue: 'Smoke Test LLC', category: 'customer' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { realValue: string; token: string };
    expect(j.realValue).toBe('Smoke Test LLC');
    expect(j.token).toMatch(/^\{CUSTOMER/);
  });

  test('DELETE removes a vocab entry', async () => {
    await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue: 'Delete Me Inc' }),
    });
    const r = await fetch(api('/api/vocab/Delete%20Me%20Inc'), { method: 'DELETE' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test('POST rejects control character in realValue', async () => {
    const r = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue: 'Bad\x01Value', category: 'customer' }),
    });
    expect(r.status).toBe(400);
  });

  test('POST rejects invalid category shape', async () => {
    const r = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue: 'Acceptable Name', category: 'BAD-CAT' }),
    });
    expect(r.status).toBe(400);
  });

  test('POST rejects credential-shaped realValue', async () => {
    const r = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        realValue: 'sk-ant-abc123def456ghi789jklmnop',
        category: 'customer',
      }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('credential-shape rejected');
  });

  test('POST rate-limits beyond 10 requests in 10s window', async () => {
    // Burst 11 requests from the same client; the 11th must be 429.
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch(api('/api/vocab'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ realValue: `RL Burst ${i}`, category: 'customer' }),
      });
      results.push(r.status);
    }
    // Most early ones should be 200; the last one must be 429.
    expect(results[10]).toBe(429);
  });

  test('DELETE adds to allowlist so subsequent scrub leaves value plain', async () => {
    // Use a distinct X-Forwarded-For so the rate-limiter bucket from the burst
    // test above doesn't apply here — keeps the test fast (no real-time wait).
    const ipHeader = '203.0.113.7';
    const value = 'Forget Me Co';

    // Mint it first.
    const add = await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ realValue: value, category: 'customer' }),
    });
    expect(add.status).toBe(200);

    // Forget it (DELETE isn't rate-limited, but pass the header anyway).
    const del = await fetch(api(`/api/vocab/${encodeURIComponent(value)}`), {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ipHeader },
    });
    expect(del.status).toBe(200);

    // Fresh scrub of text containing the value — it must stay plain.
    const scrub = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ text: `Working with ${value} today.`, persist: false }),
    });
    const sj = (await scrub.json()) as { scrubbed: string; tokens: Array<{ realValue: string }> };
    expect(sj.scrubbed).toContain(value);
    expect(sj.tokens.some((t) => t.realValue === value)).toBe(false);
  });

  test('DELETE rejects credential-shaped value', async () => {
    const ipHeader = '203.0.113.21';
    const cred = 'sk-' + 'ant-' + 'abc123def456ghi789jklmnop';
    const r = await fetch(api(`/api/vocab/${encodeURIComponent(cred)}`), {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ipHeader },
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('credential-shape rejected');
  });

  test('DELETE rejects control chars and too-long values', async () => {
    const ipHeader = '203.0.113.22';
    const bad = await fetch(api(`/api/vocab/${encodeURIComponent('bad\x01value')}`), {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ipHeader },
    });
    expect(bad.status).toBe(400);

    const long = 'a'.repeat(205);
    const tooLong = await fetch(api(`/api/vocab/${encodeURIComponent(long)}`), {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ipHeader },
    });
    expect(tooLong.status).toBe(400);
  });

  test('DELETE does not allowlist values shorter than 4 chars', async () => {
    const ipHeader = '203.0.113.23';
    const short = 'ab';
    await fetch(api('/api/vocab'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ realValue: short, category: 'customer' }),
    });
    const del = await fetch(api(`/api/vocab/${encodeURIComponent(short)}`), {
      method: 'DELETE',
      headers: { 'x-forwarded-for': ipHeader },
    });
    expect(del.status).toBe(200);
    // Scrub text where the would-be substring "ab" appears as part of another word —
    // it must NOT be treated as allowlisted, so other detections still fire.
    const scrub = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ text: 'Visit https://about-something.example.com today.', persist: false }),
    });
    const sj = (await scrub.json()) as { tokens: Array<{ realValue: string; category: string }> };
    expect(sj.tokens.some((t) => t.category === 'fqdn' || t.category === 'url')).toBe(true);
  });

  test('POST /allowlist rejects regex that matches empty string', async () => {
    const ipHeader = '203.0.113.24';
    const r = await fetch(api('/api/vocab/allowlist'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ pattern: '.*', isRegex: true }),
    });
    expect(r.status).toBe(400);
  });

  test('POST /allowlist rejects too-short pattern', async () => {
    const ipHeader = '203.0.113.25';
    const r = await fetch(api('/api/vocab/allowlist'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ipHeader },
      body: JSON.stringify({ pattern: 'ab', isRegex: false }),
    });
    expect(r.status).toBe(400);
  });
});

describe('vocab — allowlist semantics (Silas HIGH 1 regression)', () => {
  test('literal allowlist is exact match, not substring', async () => {
    const { VocabStore } = await import('../src/vocab');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const path = join(tmpdir(), `vocab-exact-${Date.now()}.db`);
    const v = new VocabStore(path);
    v.addAllowlist('ab', false);
    expect(v.isAllowlisted('ab')).toBe(true);
    expect(v.isAllowlisted('AB')).toBe(true);
    expect(v.isAllowlisted('about-something.example.com')).toBe(false);
    expect(v.isAllowlisted('grab a cab')).toBe(false);
    v.close();
  });
});

describe('server smoke — /api/settings', () => {
  test('GET returns model + claude_code status, never a secret', async () => {
    const r = await fetch(api('/api/settings'));
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      model: string;
      system_prompt: string;
      claude_code: { found: boolean; version: string | null };
    };
    expect(typeof j.model).toBe('string');
    expect(typeof j.system_prompt).toBe('string');
    expect(typeof j.claude_code.found).toBe('boolean');
    // Critical: no secret-shaped strings anywhere in the response
    expect(JSON.stringify(j)).not.toMatch(/sk-ant-|sk_live_|ghp_|AKIA/);
  });

  test('settings response does not leak the legacy api-key shape', async () => {
    const r = await fetch(api('/api/settings'));
    const j = (await r.json()) as Record<string, unknown>;
    expect('has_key' in j).toBe(false);
    expect('key_source' in j).toBe(false);
    expect('anthropic_api_key' in j).toBe(false);
  });

  // SRV-01 (#74): a cross-origin state-mutating POST (even text/plain, no
  // preflight) must be rejected with 403 and must NOT change the mode.
  test('cross-origin POST to /api/settings is forbidden (403) and does not mutate mode', async () => {
    const before = (await (await fetch(api('/api/settings'))).json()) as { mode?: string };

    const forged = await fetch(api('/api/settings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain', // "simple" request: no CORS preflight
        Origin: 'http://evil.example.com',
      },
      body: JSON.stringify({ mode: 'disabled' }),
    });
    expect(forged.status).toBe(403);

    const after = (await (await fetch(api('/api/settings'))).json()) as { mode?: string };
    expect(after.mode).toBe(before.mode);
  });

  // SRV-01 (#74): a same-origin POST is still accepted (guard doesn't break
  // the real UI). 5173 is allowed here because the smoke server runs from a
  // source checkout (dev web mode).
  test('same-origin POST to /api/settings is accepted', async () => {
    const ok = await fetch(api('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ model: 'sonnet' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('server smoke — /api/files', () => {
  test('text file upload returns scrubbed content', async () => {
    const form = new FormData();
    const blob = new Blob(['Server 10.66.77.88 at customer.example'], { type: 'text/plain' });
    form.append('file', blob, 'notes.txt');
    const r = await fetch(api('/api/files'), { method: 'POST', body: form });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { files: Array<{ name: string; scrubbed: string }> };
    expect(j.files).toHaveLength(1);
    expect(j.files[0].name).toBe('notes.txt');
    expect(j.files[0].scrubbed).not.toContain('10.66.77.88');
    expect(j.files[0].scrubbed).toContain('{IP');
  });

  test('binary file type returns error', async () => {
    const form = new FormData();
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    form.append('file', blob, 'photo.jpg');
    const r = await fetch(api('/api/files'), { method: 'POST', body: form });
    const j = (await r.json()) as { files: Array<{ error?: string }> };
    expect(j.files[0].error).toBeDefined();
  });
});

// ── Bug 2: Pre-minted tokens must appear in /api/scrub response tokens ───────
//
// The server config (PRIVACY_CONFIG.yaml) mints "Acme Corp" → {CUSTOMER} before
// scrubText runs. Because preMint calls map.mint() (not maybeRecordMint), the
// token does NOT appear in mintedTokens. The route must also scan the scrubbed
// string for tokens and enrich them into the response.

describe('server smoke — pre-minted tokens in /api/scrub response (ISC-5, ISC-7)', () => {
  test('customer_names config: "Acme Corp" token appears in response tokens', async () => {
    // The server was started with customer_names: ["Acme Corp"] in the config
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Acme Corp ships.', persist: false }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      scrubbed: string;
      tokens: Array<{ realValue: string; token: string; category: string }>;
    };
    // scrubbed output must contain the token
    expect(j.scrubbed).toMatch(/\{CUSTOMER(_\d+)?\}/);
    expect(j.scrubbed).not.toContain('Acme Corp');
    // tokens array must contain an entry for Acme Corp
    const entry = j.tokens.find((t) => t.realValue === 'Acme Corp');
    expect(entry).toBeDefined();
    expect(entry!.token).toMatch(/^\{CUSTOMER(_\d+)?\}$/);
    expect(entry!.category).toBe('customer');
  });

  test('every token in scrubbed output appears in response tokens array (ISC-7)', async () => {
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Acme Corp server is at 10.55.66.77 and backup.acme.internal is fine.',
        persist: false,
      }),
    });
    const j = (await r.json()) as {
      scrubbed: string;
      tokens: Array<{ token: string }>;
    };
    // Extract all {TOKEN} patterns from scrubbed text
    const tokensInText = [...j.scrubbed.matchAll(/\{[A-Z][A-Z0-9_]*\}/g)].map((m) => m[0]);
    const tokenValues = new Set(j.tokens.map((t) => t.token));
    for (const tok of tokensInText) {
      expect(tokenValues.has(tok)).toBe(true);
    }
  });
});

describe('server smoke — vocab oracle guard (ISC-security)', () => {
  test('submitting a literal token string does not reveal its realValue', async () => {
    // First, ensure {CUSTOMER} is in the map by scrubbing with customer_names config.
    await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Acme Corp ships.', persist: false }),
    });
    // Now submit the literal token as input — should not get realValue back.
    const r = await fetch(api('/api/scrub'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '{CUSTOMER} is asking for help.', persist: false }),
    });
    const j = (await r.json()) as { tokens: Array<{ token: string; realValue: string }> };
    // The caller-supplied {CUSTOMER} token must NOT appear in the enriched token list.
    const leak = j.tokens.find((t) => t.token === '{CUSTOMER}');
    expect(leak).toBeUndefined();
  });
});

describe('server smoke — /api/send', () => {
  test('credential in payload → 400 without relaying', async () => {
    const r = await fetch(api('/api/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'KEY=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12' }],
      }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('credential detected');
  });

  test('empty messages → 400', async () => {
    const r = await fetch(api('/api/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(r.status).toBe(400);
  });
});
