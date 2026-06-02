/**
 * Tests for `server/routes/judge-control.ts` — the GUI surface for managing
 * the LLM judge. Spins up a minimal Hono app exposing only this route, plus
 * a per-test tempdir for the PRIVACY_CONFIG.yaml the route reads/writes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { judgeControlRoute } from '../server/routes/judge-control';

let workDir: string;
let configPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-judge-control-'));
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  process.env.PRIVACY_SCREEN_CONFIG = configPath;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.PRIVACY_SCREEN_CONFIG;
});

function newApp(): Hono {
  const app = new Hono();
  app.route('/api/judge-control', judgeControlRoute);
  return app;
}

describe('GET /api/judge-control/status', () => {
  test('returns disabled defaults when no config exists', async () => {
    const app = newApp();
    const res = await app.fetch(new Request('http://localhost/api/judge-control/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { enabled: boolean };
      runtime: { installed: boolean };
      model: { installed: boolean };
      available_models: Array<{ name: string }>;
    };
    expect(body.config.enabled).toBe(false);
    expect(body.model.installed).toBe(false);
    expect(body.available_models.some((m) => m.name === 'qwen2.5-1.5b')).toBe(true);
  });

  test('reads enabled flag from YAML', async () => {
    writeFileSync(
      configPath,
      `llm_validate:\n  enabled: true\n  model_path: /tmp/fake.gguf\n`,
    );
    const app = newApp();
    const res = await app.fetch(new Request('http://localhost/api/judge-control/status'));
    const body = (await res.json()) as { config: { enabled: boolean; model_path: string | null } };
    expect(body.config.enabled).toBe(true);
    expect(body.config.model_path).toBe('/tmp/fake.gguf');
  });
});

describe('POST /api/judge-control/enable', () => {
  test('refuses to enable without a model on disk', async () => {
    const app = newApp();
    const res = await app.fetch(
      new Request('http://localhost/api/judge-control/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('install first');
  });

  test('enables when model file exists', async () => {
    const modelPath = join(workDir, 'fake.gguf');
    writeFileSync(modelPath, new Uint8Array([0, 1, 2, 3]));
    writeFileSync(configPath, `llm_validate:\n  enabled: false\n  model_path: ${modelPath}\n`);

    const app = newApp();
    const res = await app.fetch(
      new Request('http://localhost/api/judge-control/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Confirm the YAML was actually mutated.
    expect(readFileSync(configPath, 'utf-8')).toContain('enabled: true');
  });

  test('disable always works even without a model', async () => {
    const app = newApp();
    const res = await app.fetch(
      new Request('http://localhost/api/judge-control/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('enabled: false');
  });

  test('rejects non-boolean enabled', async () => {
    const app = newApp();
    const res = await app.fetch(
      new Request('http://localhost/api/judge-control/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/judge-control/install', () => {
  test('rejects unknown model', async () => {
    const app = newApp();
    const res = await app.fetch(
      new Request('http://localhost/api/judge-control/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-7' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown model');
  });
});
