/**
 * Tests for server/routes/feedback.ts — the async POST /api/feedback flow (#22).
 *
 * Strategy: mount the route on a minimal Hono app and call
 * `app.fetch(new Request(…))` directly. We use a test seam
 * (__PRIVACY_SCREEN_TEST_GH_BIN) so the route spawns a stub script instead of
 * the real `gh` CLI — letting us:
 *   1. assert 503 when gh is "not on PATH" (stub absent)
 *   2. capture the title/body that gh sees (anti-leak)
 *   3. assert end-to-end success when the stub prints a fake issue URL
 *
 * Privacy invariant under test (ISC-32): the raw customer name set in
 * `cfg.customer_names` MUST NOT appear in the spawn argv OR in the issue body
 * piped over stdin — only {CUSTOMER}/{CUSTOMER_N} tokens.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { writeFileSync, mkdtempSync, rmSync, chmodSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  feedbackRoute,
  resolveGhBin,
  buildTitle,
  buildBody,
} from '../server/routes/feedback';
import { resetVocab } from '../server/lib/vocab-store';
import { _resetForTests as resetJobs, getJob } from '../server/lib/feedback-jobs';
import { assertRedacted } from '../server/lib/feedback-diagnostics';

let workDir: string;
let configPath: string;
let dbPath: string;
/** Path where the stub `gh` script will be written per-test. */
let stubPath: string;
/** Path the stub writes its captured argv JSON to. */
let argvCaptureFile: string;
/** Path the stub writes its captured stdin (issue body) to. */
let bodyCaptureFile: string;

const UNIQUE_CUSTOMER = 'TestCustomer_unique_xyz';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-feedback-'));
  dbPath = join(workDir, 'vocab.db');
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  stubPath = join(workDir, 'gh-stub.sh');
  argvCaptureFile = join(workDir, 'capture-argv.json');
  bodyCaptureFile = join(workDir, 'capture-body.txt');

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
});

afterAll(() => {
  resetVocab();
  delete process.env.PRIVACY_SCREEN_CONFIG;
  delete process.env.__PRIVACY_SCREEN_TEST_GH_BIN;
  delete process.env.PRIVACY_SCREEN_SKIP_CLAUDE_CHECK;
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the per-test seam envs
  delete process.env.__PRIVACY_SCREEN_TEST_GH_BIN;
  delete process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW;
  delete process.env.PRIVACY_SCREEN_SKIP_CLAUDE_CHECK;
  // Clean previous capture artefacts and stub
  if (existsSync(argvCaptureFile)) rmSync(argvCaptureFile, { force: true });
  if (existsSync(bodyCaptureFile)) rmSync(bodyCaptureFile, { force: true });
  if (existsSync(stubPath)) rmSync(stubPath, { force: true });
  // Always start with an empty job store so polling assertions are deterministic
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
 * Write an executable shell stub at stubPath that:
 *   - captures argv (without $0) to argvCaptureFile as a JSON array
 *   - copies stdin to bodyCaptureFile (so we can grep the issue body)
 *   - prints `stdoutContent` to stdout
 *   - exits with the requested status
 *
 * The stub also responds correctly to `--version` so the presence check
 * passes — gh's first call from the route is `gh --version`.
 */
function installGhStub(stdoutContent: string, exitCode = 0): void {
  const escapedCapture = argvCaptureFile.replace(/'/g, `'\\''`);
  const escapedBody = bodyCaptureFile.replace(/'/g, `'\\''`);
  const escapedStdout = stdoutContent.replace(/'/g, `'\\''`);

  // We write a small bash script:
  //   * For `--version`: print and exit 0 (so checkGhBinary passes).
  //   * For `auth status`: print success and exit 0 (so checkGhAuth passes).
  //     Tests that exercise the auth-failure path set
  //     __PRIVACY_SCREEN_TEST_GH_AUTH_FAIL=1 before calling the stub.
  //   * Otherwise: JSON-encode argv (escaping via python3 if available, then
  //     awk fallback) to the capture file, drain stdin into the body file,
  //     print the canned stdout, exit with requested code.
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    'if [ "${1:-}" = "--version" ]; then',
    '  echo "gh version 2.50.0 (stub)"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then',
    '  if [ "${__PRIVACY_SCREEN_TEST_GH_AUTH_FAIL:-0}" = "1" ]; then',
    '    echo "X You are not logged into any GitHub hosts. To log in, run: gh auth login" 1>&2',
    '    exit 1',
    '  fi',
    '  echo "github.com — Logged in as stub-user"',
    '  exit 0',
    'fi',
    '',
    '# Encode each argv element to JSON (python3 preferred for correctness).',
    'args_json="["',
    'first=1',
    'for a in "$@"; do',
    '  if command -v python3 >/dev/null 2>&1; then',
    '    esc=$(printf %s "$a" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")',
    '  else',
    '    esc=$(printf %s "$a" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\' | awk \'{printf "\\"%s\\"", $0}\')',
    '  fi',
    '  if [ $first -eq 1 ]; then args_json+="$esc"; first=0; else args_json+=", $esc"; fi',
    'done',
    'args_json+="]"',
    `printf %s "$args_json" > '${escapedCapture}'`,
    '',
    `cat > '${escapedBody}'`,
    '',
    `printf %s '${escapedStdout}'`,
    `exit ${exitCode}`,
    '',
  ].join('\n');
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
  process.env.__PRIVACY_SCREEN_TEST_GH_BIN = stubPath;
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

// ── Input validation + gating ────────────────────────────────────────────────

describe('POST /api/feedback — validation', () => {
  test('returns 400 on empty summary', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/1');
    const app = makeApp();
    const res = await app.fetch(makePostRequest({ summary: '   ' }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('summary');
  });

  test('returns 400 on non-object body', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/1');
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/feedback — credential refusal', () => {
  test('returns 400 when scrubber flags a credential in the summary', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/1');
    const app = makeApp();
    // A high-entropy bearer-style token will trip the credential detector.
    const summary =
      'Here is my key: ghp_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8';
    const res = await app.fetch(makePostRequest({ summary }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error.toLowerCase()).toContain('credential');
  });
});

describe('POST /api/feedback — 503 gating', () => {
  test('returns 503 when gh is not on PATH', async () => {
    // Point the seam at a nonexistent binary so checkGhBinary returns found=false
    process.env.__PRIVACY_SCREEN_TEST_GH_BIN = join(workDir, 'does-not-exist');
    const app = makeApp();
    const res = await app.fetch(
      makePostRequest({ summary: 'something is broken in the UI' }),
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('gh');
  });

  // Issue #42 — gh installed but unauthenticated must return 503 synchronously
  // with an actionable message, not let the spawn fail much later with a
  // generic HTTP 401 from GitHub.
  test('returns 503 with `gh auth login` hint when gh is unauthenticated', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/1');
    process.env.__PRIVACY_SCREEN_TEST_GH_AUTH_FAIL = '1';
    try {
      const app = makeApp();
      const res = await app.fetch(
        makePostRequest({ summary: 'unauth scenario' }),
      );
      expect(res.status).toBe(503);
      const j = (await res.json()) as { ok: boolean; error: string };
      expect(j.ok).toBe(false);
      expect(j.error).toContain('gh auth login');
    } finally {
      delete process.env.__PRIVACY_SCREEN_TEST_GH_AUTH_FAIL;
    }
  });
});

// ── Async submission shape ───────────────────────────────────────────────────

describe('POST /api/feedback — async accept', () => {
  test('returns 202 + jobId for a valid submission', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/77');
    const app = makeApp();
    const res = await app.fetch(makePostRequest({ summary: 'a small bug report' }));
    expect(res.status).toBe(202);
    const j = (await res.json()) as { ok: boolean; jobId: string };
    expect(j.ok).toBe(true);
    expect(typeof j.jobId).toBe('string');
    expect(j.jobId.length).toBeGreaterThan(0);

    // The job must be discoverable via the store immediately
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
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/88');
    const app = makeApp();
    const post = await app.fetch(makePostRequest({ summary: 'small bug' }));
    const { jobId } = (await post.json()) as { jobId: string };

    // The state may be in any phase here; assert structural shape only.
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
  test('submits, polls to done, surfaces issueNumber + issueUrl', async () => {
    const fakeUrl = 'https://github.com/adamcongdon/privacy-screen/issues/99';
    installGhStub(`Creating issue in adamcongdon/privacy-screen\n${fakeUrl}\n`);
    const app = makeApp();

    const post = await app.fetch(makePostRequest({ summary: 'end-to-end smoke test' }));
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final).not.toBeNull();
    expect(final.status).toBe('done');
    expect(final.issueUrl).toBe(fakeUrl);
    expect(final.issueNumber).toBe(99);
  });
});

// ── Anti-leak (ISC-32) ───────────────────────────────────────────────────────

describe('POST /api/feedback — anti-leak (ISC-32)', () => {
  test('raw customer name never appears in argv or issue body', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/500');
    const app = makeApp();
    const summary = `When I open ${UNIQUE_CUSTOMER}'s tenant the page goes white. ${UNIQUE_CUSTOMER} is on prod.`;
    const post = await app.fetch(makePostRequest({ summary }));
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe('done');

    // Both capture files must exist and be free of the raw customer name
    expect(existsSync(argvCaptureFile)).toBe(true);
    expect(existsSync(bodyCaptureFile)).toBe(true);
    const argv = readFileSync(argvCaptureFile, 'utf-8');
    const body = readFileSync(bodyCaptureFile, 'utf-8');

    expect(argv.includes(UNIQUE_CUSTOMER)).toBe(false);
    expect(body.includes(UNIQUE_CUSTOMER)).toBe(false);

    // And at least one of them must contain a {CUSTOMER} token — proves the
    // scrubber actually matched and replaced rather than dropping the field.
    expect(/\{CUSTOMER(_\d+)?\}/.test(argv + body)).toBe(true);
  });
});

// ── GET /preview ─────────────────────────────────────────────────────────────

describe('GET /api/feedback/preview — scrubbed diagnostics', () => {
  test('returns scrubbed diagnostics JSON without spawning gh', async () => {
    // Even with a deliberately-broken stub, preview must succeed without
    // touching gh — it's a pure read.
    process.env.__PRIVACY_SCREEN_TEST_GH_BIN = join(workDir, 'should-not-be-called');
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
  });
});

// ── Security regressions (preserved from the previous suite) ─────────────────

describe('security regressions', () => {
  test('POST returns 500 generic when scrubText throws', async () => {
    installGhStub('https://github.com/adamcongdon/privacy-screen/issues/1');
    process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW = '1';
    const app = makeApp();
    const summary = 'This is a secret summary that must not be echoed';
    const res = await app.fetch(makePostRequest({ summary }));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j).toEqual({ ok: false, error: 'scrub failed — feedback not sent' });
    expect(JSON.stringify(j)).not.toContain(summary);
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

  test('production-gated test-seam env var', () => {
    // Production mode: env override is ignored, resolver returns literal 'gh'.
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.__PRIVACY_SCREEN_TEST_GH_BIN = '/tmp/fake-gh-binary';

    process.env.NODE_ENV = 'production';
    expect(resolveGhBin()).toBe('gh');

    // Non-production: override IS honored.
    process.env.NODE_ENV = 'test';
    expect(resolveGhBin()).toBe('/tmp/fake-gh-binary');

    process.env.NODE_ENV = oldNodeEnv ?? '';
    delete process.env.__PRIVACY_SCREEN_TEST_GH_BIN;
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
