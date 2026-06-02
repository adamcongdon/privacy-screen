/**
 * Tests for server/routes/judge.ts — the POST /api/judge endpoint.
 *
 * We mount the route on a minimal Hono app and call `app.fetch(new Request(…))`
 * directly so we don't pay the cost of the full server smoke harness. The
 * route uses `PRIVACY_SCREEN_LLM_MOCK=1` as a seam to avoid spawning a real
 * model; the mock response is scripted via `PRIVACY_SCREEN_LLM_MOCK_RESPONSE`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { judgeRoute } from '../server/routes/judge';
import { resetVocab, getVocab } from '../server/lib/vocab-store';
import { ScrubMap } from '../src/scrub-map';

let workDir: string;
let configPath: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-judge-'));
  dbPath = join(workDir, 'vocab.db');
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  writeFileSync(
    configPath,
    [
      `db_path: ${dbPath}`,
      `mode: observe`,
      `llm_validate:`,
      `  enabled: true`,
      `  model_path: ${configPath}`, // any existing file is fine
      `  runtime: llama-server`,
      `  endpoint: http://127.0.0.1:9999`, // skip spawn
      `  max_tokens: 256`,
      `  timeout_ms: 2500`,
      `  min_confidence: 0.5`,
      ``,
    ].join('\n'),
  );
  process.env.PRIVACY_SCREEN_CONFIG = configPath;
});

afterAll(() => {
  resetVocab();
  delete process.env.PRIVACY_SCREEN_CONFIG;
  delete process.env.PRIVACY_SCREEN_LLM_MOCK;
  delete process.env.PRIVACY_SCREEN_LLM_MOCK_RESPONSE;
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test sets its own mock env, default to off
  delete process.env.PRIVACY_SCREEN_LLM_MOCK;
  delete process.env.PRIVACY_SCREEN_LLM_MOCK_RESPONSE;
});

/** Build a minimal app with only the judge route mounted. */
function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/judge', judgeRoute);
  return app;
}

/** Build a valid serialized tokenMap envelope for the request body. */
function makeTokenMap(): unknown {
  const m = new ScrubMap();
  m.mint('CUSTOMER', 'Acme Corp');
  return m.serialize();
}

/** Build a valid POST request to /api/judge. */
function makeRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/judge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/judge', () => {
  test('returns 202 within 50 ms when enabled + mock seam set', async () => {
    process.env.PRIVACY_SCREEN_LLM_MOCK = '1';
    process.env.PRIVACY_SCREEN_LLM_MOCK_RESPONSE = JSON.stringify({
      suspicious_spans: [],
    });
    const app = makeApp();
    const start = Date.now();
    const res = await app.fetch(
      makeRequest({
        scrubbed:
          'Customer {CUSTOMER} reports server is down at 10am — this is plenty of text for the judge to accept.',
        tokenMap: makeTokenMap(),
        sourceEvent: 'test-event',
      }),
    );
    const elapsed = Date.now() - start;
    expect(res.status).toBe(202);
    expect(elapsed).toBeLessThan(50);
    const j = (await res.json()) as { status: string };
    expect(j.status).toBe('accepted');
  });

  test('returns 200 status:disabled when llm_validate.enabled === false', async () => {
    // Swap config to a disabled one
    const disabledConfig = join(workDir, 'disabled.yaml');
    writeFileSync(
      disabledConfig,
      [
        `db_path: ${dbPath}`,
        `mode: observe`,
        `llm_validate:`,
        `  enabled: false`,
        ``,
      ].join('\n'),
    );
    const prev = process.env.PRIVACY_SCREEN_CONFIG;
    process.env.PRIVACY_SCREEN_CONFIG = disabledConfig;
    try {
      const app = makeApp();
      const res = await app.fetch(
        makeRequest({
          scrubbed:
            'plenty of scrubbed text here, more than the minimum input length we require',
          tokenMap: makeTokenMap(),
          sourceEvent: 'test',
        }),
      );
      expect(res.status).toBe(200);
      const j = (await res.json()) as { status: string; spansFound: number };
      expect(j.status).toBe('disabled');
      expect(j.spansFound).toBe(0);
    } finally {
      process.env.PRIVACY_SCREEN_CONFIG = prev;
    }
  });

  test('400 on missing scrubbed field', async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({
        tokenMap: makeTokenMap(),
        sourceEvent: 'test',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('400 on missing tokenMap field', async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({
        scrubbed: 'plenty of text here for the judge to process now',
        sourceEvent: 'test',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('413 when Content-Length exceeds 256 KB', async () => {
    const app = makeApp();
    // Build a request with a forged Content-Length header > 256 KB. The
    // body itself doesn't need to be that big; the header check is what
    // we're exercising.
    const req = new Request('http://127.0.0.1/api/judge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(300 * 1024),
      },
      body: JSON.stringify({
        scrubbed: 'x',
        tokenMap: makeTokenMap(),
        sourceEvent: 't',
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(413);
  });

  test('400 on invalid tokenMap shape (wrong version)', async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({
        scrubbed: 'plenty of text here for the judge to process now',
        tokenMap: { v: 99, entries: [] },
        sourceEvent: 'test',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('review_queue grows after microtask runs', async () => {
    process.env.PRIVACY_SCREEN_LLM_MOCK = '1';
    process.env.PRIVACY_SCREEN_LLM_MOCK_RESPONSE = JSON.stringify({
      suspicious_spans: [
        {
          text: 'Aanya',
          category: 'person',
          confidence: 0.8,
          reason: 'south asian given name',
        },
      ],
    });

    // Reset to pick up fresh config (PRIVACY_SCREEN_CONFIG points at enabled).
    resetVocab();
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({
        scrubbed:
          'Customer {CUSTOMER} called and Aanya answered, this is plenty of scrubbed text for the judge.',
        tokenMap: makeTokenMap(),
        sourceEvent: 'test-event',
      }),
    );
    expect(res.status).toBe(202);

    // Wait for the queueMicrotask handler to finish persisting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pending = getVocab().pendingReview();
    const hit = pending.find(
      (r) =>
        r.span === 'Aanya' && r.source_event === 'judge:test-event',
    );
    expect(hit).toBeDefined();
    expect(hit?.suggested_cat).toBe('person');
  });
});
