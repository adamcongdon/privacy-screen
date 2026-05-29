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

async function waitForHealth(maxMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    },
  });
  await waitForHealth();
});

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
