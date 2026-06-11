/**
 * Tests for server/routes/feedback.ts — the async POST /api/feedback flow,
 * reworked to post through the feedback relay (#15 universal-relay design)
 * instead of shelling out to `gh issue create`.
 *
 * Strategy: mount the route on a minimal Hono app and call
 * `app.fetch(new Request(…))` directly. A local stub relay (Bun.serve) stands
 * in for the Cloudflare Worker; the route is pointed at it via the test seam
 * `__PRIVACY_SCREEN_TEST_RELAY_URL`. The stub captures the exact body POSTed so
 * we can:
 *   1. assert end-to-end success when it returns a fake issue number/url
 *   2. assert the job goes to `error` when the relay fails
 *   3. capture the relay payload (anti-leak) and prove no raw customer name
 *      ever leaves the process
 *
 * Privacy invariant under test (ISC-32): the raw customer name set in
 * `cfg.customer_names` MUST NOT appear in the body POSTed to the relay — only
 * {CUSTOMER}/{CUSTOMER_N} tokens.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { feedbackRoute, buildTitle, buildBody } from '../server/routes/feedback';
import { resetVocab } from '../server/lib/vocab-store';
import { _resetForTests as resetJobs, getJob } from '../server/lib/feedback-jobs';
import { assertRedacted } from '../server/lib/feedback-diagnostics';

let workDir: string;
let configPath: string;
let dbPath: string;

const UNIQUE_CUSTOMER = 'TestCustomer_unique_xyz';

// ── Stub relay state ──────────────────────────────────────────────────────────
let relayServer: ReturnType<typeof Bun.serve> | null = null;
let relayUrl = '';
/** The exact request body the stub relay last received. */
let lastRelayBody: string | null = null;
/** Toggle the stub between success and failure responses per-test. */
let relayMode: 'ok' | 'fail' = 'ok';
/** Issue number the stub returns on success. */
let relayIssueNumber = 123;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-feedback-'));
  dbPath = join(workDir, 'vocab.db');
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');

  writeFileSync(
    configPath,
    [
      `db_path: ${dbPath}`,
      `mode: observe`,
      `customer_names:`,
      `  - "${UNIQUE_CUSTOMER}"`,
      `llm_validate:`,
      `  enabled: false`,
      ``,
    ].join('\n'),
  );
  process.env.PRIVACY_SCREEN_CONFIG = configPath;

  // Start the stub relay. Captures the POST body and answers per `relayMode`.
  relayServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/feedback') {
        lastRelayBody = await req.text();
        if (relayMode === 'fail') {
          return new Response(JSON.stringify({ ok: false, error: 'relay boom' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            issueNumber: relayIssueNumber,
            issueUrl: `https://github.com/adamcongdon/privacy-screen/issues/${relayIssueNumber}`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  relayUrl = `http://127.0.0.1:${relayServer.port}`;
  process.env.__PRIVACY_SCREEN_TEST_RELAY_URL = relayUrl;
});

afterAll(() => {
  resetVocab();
  relayServer?.stop(true);
  delete process.env.PRIVACY_SCREEN_CONFIG;
  delete process.env.__PRIVACY_SCREEN_TEST_RELAY_URL;
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW;
  // Reset stub relay + job store so assertions are deterministic.
  lastRelayBody = null;
  relayMode = 'ok';
  relayIssueNumber = 123;
  resetJobs();
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/feedback', feedbackRoute);
  return app;
}

function makePostRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(jobId: string): Request {
  return new Request(`http://127.0.0.1/api/feedback/${jobId}`, { method: 'GET' });
}

/**
 * Poll GET /:jobId until status leaves {queued, drafting, filing} or until
 * the 5s ceiling is reached. Returns the last observed state.
 */
async function pollUntilTerminal(app: Hono, jobId: string, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await app.fetch(makeGetRequest(jobId));
    last = await res.json();
    if (last && (last.status === 'done' || last.status === 'error')) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

// ── Input validation ──────────────────────────────────────────────────────────

describe('POST /api/feedback — validation', () => {
  test('returns 400 on empty summary', async () => {
    const app = makeApp();
    const res = await app.fetch(makePostRequest({ summary: '   ' }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('summary');
    expect(lastRelayBody).toBeNull(); // never reached the relay
  });

  test('returns 400 on non-object body', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(res.status).toBe(400);
    expect(lastRelayBody).toBeNull();
  });
});

describe('POST /api/feedback — credential refusal', () => {
  test('returns 400 when scrubber flags a credential in the summary', async () => {
    const app = makeApp();
    // A high-entropy bearer-style token will trip the credential detector.
    const summary = 'Here is my key: ghp_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8';
    const res = await app.fetch(makePostRequest({ summary }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error.toLowerCase()).toContain('credential');
    expect(lastRelayBody).toBeNull(); // refused before any egress
  });
});

// ── Async submission shape ───────────────────────────────────────────────────

describe('POST /api/feedback — async accept', () => {
  test('returns 202 + jobId for a valid submission', async () => {
    const app = makeApp();
    const res = await app.fetch(makePostRequest({ summary: 'a small bug report' }));
    expect(res.status).toBe(202);
    const j = (await res.json()) as { ok: boolean; jobId: string };
    expect(j.ok).toBe(true);
    expect(typeof j.jobId).toBe('string');
    expect(j.jobId.length).toBeGreaterThan(0);
    // The job must be discoverable via the store immediately.
    expect(getJob(j.jobId)).not.toBeNull();
  });
});

// ── Polling endpoint ─────────────────────────────────────────────────────────

describe('GET /api/feedback/:jobId — polling', () => {
  test('returns 404 for an unknown jobId', async () => {
    const app = makeApp();
    const res = await app.fetch(makeGetRequest('does-not-exist'));
    expect(res.status).toBe(404);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe('not found');
  });

  test('returns the current job state for a known jobId', async () => {
    const app = makeApp();
    const post = await app.fetch(makePostRequest({ summary: 'small bug' }));
    const { jobId } = (await post.json()) as { jobId: string };

    const res = await app.fetch(makeGetRequest(jobId));
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      jobId: string;
      status: string;
      startedAt: number;
      updatedAt: number;
    };
    expect(state.jobId).toBe(jobId);
    expect(['queued', 'drafting', 'filing', 'done', 'error']).toContain(state.status);
    expect(typeof state.startedAt).toBe('number');
    expect(typeof state.updatedAt).toBe('number');
  });
});

// ── End-to-end happy path ────────────────────────────────────────────────────

describe('POST + poll — end to end', () => {
  test('submits, polls to done, surfaces issueNumber + issueUrl from the relay', async () => {
    relayIssueNumber = 99;
    const app = makeApp();

    const post = await app.fetch(makePostRequest({ summary: 'end-to-end smoke test' }));
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final).not.toBeNull();
    expect(final.status).toBe('done');
    expect(final.issueUrl).toBe('https://github.com/adamcongdon/privacy-screen/issues/99');
    expect(final.issueNumber).toBe(99);

    // The relay received a payload carrying the type label.
    expect(lastRelayBody).not.toBeNull();
    const payload = JSON.parse(lastRelayBody as string) as {
      title: string;
      body: string;
      type: string;
    };
    expect(payload.type).toBe('bug'); // default when omitted
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.body).toContain('<details><summary>Diagnostics</summary>');
  });

  test('passes the chosen feedback type through to the relay', async () => {
    const app = makeApp();
    const post = await app.fetch(
      makePostRequest({ summary: 'a feature idea', type: 'enhancement' }),
    );
    const { jobId } = (await post.json()) as { jobId: string };
    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe('done');
    const payload = JSON.parse(lastRelayBody as string) as { type: string };
    expect(payload.type).toBe('enhancement');
  });
});

// ── Relay failure → job error ────────────────────────────────────────────────

describe('POST + poll — relay failure', () => {
  test('marks the job error (not done) when the relay returns non-2xx', async () => {
    relayMode = 'fail';
    const app = makeApp();
    const post = await app.fetch(makePostRequest({ summary: 'will fail at the relay' }));
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe('error');
    expect(typeof final.error).toBe('string');
    expect(final.error).toContain('relay boom');
    expect(final.issueUrl).toBeUndefined();
  });
});

// ── Anti-leak (ISC-32) ───────────────────────────────────────────────────────

describe('POST /api/feedback — anti-leak (ISC-32)', () => {
  test('raw customer name never appears in the relay payload', async () => {
    const app = makeApp();
    const summary = `When I open ${UNIQUE_CUSTOMER}'s tenant the page goes white. ${UNIQUE_CUSTOMER} is on prod.`;
    const post = await app.fetch(makePostRequest({ summary }));
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe('done');

    // The exact body POSTed to the relay must be free of the raw customer name.
    expect(lastRelayBody).not.toBeNull();
    const body = lastRelayBody as string;
    expect(body.includes(UNIQUE_CUSTOMER)).toBe(false);

    // And it must contain a {CUSTOMER} token — proves the scrubber actually
    // matched and replaced rather than dropping the field.
    expect(/\{CUSTOMER(_\d+)?\}/.test(body)).toBe(true);
  });
});

// ── GET /preview ─────────────────────────────────────────────────────────────

describe('GET /api/feedback/preview — scrubbed diagnostics', () => {
  test('returns scrubbed diagnostics JSON without egress', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/feedback/preview', { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      version: string;
      config: { mode: string; llm_validate: { enabled: boolean } };
      claudeCode: { found: boolean };
    };
    expect(typeof j.version).toBe('string');
    expect(j.config.mode).toBe('observe');
    expect(j.config.llm_validate.enabled).toBe(false);
    expect(JSON.stringify(j)).not.toContain(UNIQUE_CUSTOMER);
    expect(lastRelayBody).toBeNull(); // preview is a pure read
  });
});

// ── Security regressions (preserved from the previous suite) ─────────────────

describe('security regressions', () => {
  test('POST returns 500 generic when scrubText throws', async () => {
    process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW = '1';
    const app = makeApp();
    const summary = 'This is a secret summary that must not be echoed';
    const res = await app.fetch(makePostRequest({ summary }));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j).toEqual({ ok: false, error: 'scrub failed — feedback not sent' });
    expect(JSON.stringify(j)).not.toContain(summary);
    expect(lastRelayBody).toBeNull();
    delete process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW;
  });

  test('GET /preview returns 500 generic when collectDiagnostics throws', async () => {
    process.env.__PRIVACY_SCREEN_TEST_PREVIEW_THROW = '1';
    const app = makeApp();
    const res = await app.fetch(new Request('http://127.0.0.1/api/feedback/preview', { method: 'GET' }));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j).toEqual({ error: 'preview unavailable' });
    delete process.env.__PRIVACY_SCREEN_TEST_PREVIEW_THROW;
  });

  test('assertRedacted throws on oversized string', () => {
    const bad: any = {
      mode: 'enforce',
      llm_validate: { enabled: false },
      hook: { auto_approve_clean: false },
      update_channel: 'a'.repeat(65),
      fqdn_allowlist_extra_count: 0,
      customer_names_count: 0,
      person_names_count: 0,
      name_allowlist_count: 0,
    };
    expect(() => assertRedacted(bad as any)).toThrow();
  });

  test('assertRedacted throws on array in nested', () => {
    const bad2: any = {
      mode: 'observe',
      llm_validate: { enabled: false },
      hook: { auto_approve_clean: false },
      update_channel: 'stable',
      fqdn_allowlist_extra_count: 0,
      customer_names_count: 0,
      person_names_count: 0,
      name_allowlist_count: 0,
    };
    (bad2 as any).extra = [1, 2, 3];
    expect(() => assertRedacted(bad2 as any)).toThrow();
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('buildTitle / buildBody — pure helpers', () => {
  test('buildTitle truncates to 60 chars and strips newlines', () => {
    const long = 'x'.repeat(200);
    expect(buildTitle(long).length).toBe(60);
    expect(buildTitle('hello\nworld\r\nfoo')).toBe('hello world foo');
  });

  test('buildTitle falls back to "Feedback" on empty input', () => {
    expect(buildTitle('')).toBe('Feedback');
    expect(buildTitle('   \n   ')).toBe('Feedback');
  });

  test('buildBody wraps diagnostics in a <details> block with json fence', () => {
    const out = buildBody('the summary', '{"k":1}');
    expect(out).toContain('the summary');
    expect(out).toContain('<details><summary>Diagnostics</summary>');
    expect(out).toContain('```json');
    expect(out).toContain('{"k":1}');
    expect(out).toContain('</details>');
  });
});
