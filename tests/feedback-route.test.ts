/**
 * Tests for server/routes/feedback.ts — the POST /api/feedback endpoint.
 *
 * Strategy: mount the route on a minimal Hono app and call `app.fetch(new Request(…))`
 * directly. We use a test seam (`PRIVACY_SCREEN_FEEDBACK_TEST_CLAUDE_BIN`) so the
 * route spawns a stub script instead of the real `claude` CLI — letting us:
 *   1. assert 503 when claude is "not on PATH" (stub absent)
 *   2. capture the prompt argv passed to the stub (anti-leak)
 *   3. assert success when the stub prints a fake issue URL
 *
 * Privacy invariant under test (ISC-32): the raw customer name set in
 * `cfg.customer_names` MUST NOT appear anywhere in the spawn argv — only
 * {CUSTOMER}/{CUSTOMER_N} tokens.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { writeFileSync, mkdtempSync, rmSync, chmodSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { feedbackRoute, resolveClaudeBin } from '../server/routes/feedback';
import { resetVocab } from '../server/lib/vocab-store';
import { assertRedacted } from '../server/lib/feedback-diagnostics';

let workDir: string;
let configPath: string;
let dbPath: string;
/** Path where the stub `claude` script will be written per-test. */
let stubPath: string;
/** Path the stub writes its captured argv JSON to, so the test can read it. */
let captureFile: string;

const UNIQUE_CUSTOMER = 'TestCustomer_unique_xyz';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-feedback-'));
  dbPath = join(workDir, 'vocab.db');
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  stubPath = join(workDir, 'claude-stub.sh');
  captureFile = join(workDir, 'capture.json');

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
  delete process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN;
  delete process.env.PRIVACY_SCREEN_FEEDBACK_TEST_CAPTURE;
  delete process.env.PRIVACY_SCREEN_SKIP_CLAUDE_CHECK;
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the per-test seam envs
  delete process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN;
  delete process.env.PRIVACY_SCREEN_FEEDBACK_TEST_CAPTURE;
  delete process.env.PRIVACY_SCREEN_SKIP_CLAUDE_CHECK;
  // Clean any previous capture file
  if (existsSync(captureFile)) rmSync(captureFile, { force: true });
  if (existsSync(stubPath)) rmSync(stubPath, { force: true });
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/feedback', feedbackRoute);
  return app;
}

function makeRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Write an executable shell stub at stubPath that:
 *   - captures argv to captureFile as a JSON array
 *   - exits with the requested status, printing `out` to stdout
 */
function installClaudeStub(out: string, exitCode = 0): void {
  // shell stub: writes JSON of args (skipping $0), prints `out`, exits with code
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    'args_json="["',
    'first=1',
    'for a in "$@"; do',
    '  esc=$(printf %s "$a" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || printf %s "$a" | sed \'s/"/\\\\"/g\' | awk \'{print "\\""$0"\\""}\')',
    '  if [ $first -eq 1 ]; then args_json+="$esc"; first=0; else args_json+=", $esc"; fi',
    'done',
    'args_json+="]"',
    `printf %s "$args_json" > "${captureFile}"`,
    `printf %s ${JSON.stringify(out)}`,
    `exit ${exitCode}`,
    '',
  ].join('\n');
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
  process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN = stubPath;
}

describe('POST /api/feedback — 503 gating', () => {
  test('returns 503 when claude is not on PATH and skip-check is unset', async () => {
    // Point the seam at a nonexistent binary so checkClaudeCode() returns found=false
    process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN = join(workDir, 'does-not-exist');
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({ summary: 'something is broken in the UI' }),
    );
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('claude');
  });
});

describe('POST /api/feedback — anti-leak (ISC-32)', () => {
  test('raw customer name never appears in the spawned claude argv', async () => {
    installClaudeStub(JSON.stringify({ url: 'https://github.com/adamcongdon/privacy-screen/issues/999' }));
    const app = makeApp();
    // Summary that mentions the customer by name + the customer in passing.
    const summary = `When I open ${UNIQUE_CUSTOMER}'s tenant the page goes white. ${UNIQUE_CUSTOMER} is on prod.`;
    const res = await app.fetch(makeRequest({ summary }));
    expect(res.status).toBe(200);

    // Read the captured argv that the stub wrote to disk
    expect(existsSync(captureFile)).toBe(true);
    const captured = readFileSync(captureFile, 'utf-8');
    // Must NOT contain the raw customer name anywhere
    expect(captured.includes(UNIQUE_CUSTOMER)).toBe(false);
    // Must contain a CUSTOMER token (proves scrubbing actually ran on a real match)
    expect(/\{CUSTOMER(_\d+)?\}/.test(captured)).toBe(true);
  });
});

describe('POST /api/feedback — success path', () => {
  test('returns 200 with truncated stdout when claude exits 0', async () => {
    const fakeUrl = 'https://github.com/adamcongdon/privacy-screen/issues/123';
    installClaudeStub(`opened ${fakeUrl}`);
    const app = makeApp();
    const res = await app.fetch(
      makeRequest({ summary: 'small bug report from the success-path test' }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; output: string };
    expect(j.ok).toBe(true);
    expect(j.output).toContain(fakeUrl);
  });
});

describe('GET /api/feedback/preview — scrubbed diagnostics', () => {
  test('returns scrubbed diagnostics JSON without spawning claude', async () => {
    // Even with a deliberately-broken stub, preview must succeed without
    // touching claude — it's a pure read.
    process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN = join(workDir, 'should-not-be-called');
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
    // The raw unique customer name must not appear in the preview body
    expect(JSON.stringify(j)).not.toContain(UNIQUE_CUSTOMER);
  });
});

// TDD: new tests for the pentester remediation

describe('security regressions', () => {
  test('POST returns 500 generic when scrubText throws', async () => {
    installClaudeStub('ok');
    process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW = '1';
    const app = makeApp();
    const summary = 'This is a secret summary that must not be echoed';
    const res = await app.fetch(makeRequest({ summary }));
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
    // Production mode: env override is ignored, resolver returns literal 'claude'.
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN = '/tmp/fake-claude-binary';

    process.env.NODE_ENV = 'production';
    expect(resolveClaudeBin()).toBe('claude');

    // Non-production: override IS honored.
    process.env.NODE_ENV = 'test';
    expect(resolveClaudeBin()).toBe('/tmp/fake-claude-binary');

    process.env.NODE_ENV = oldNodeEnv ?? '';
    delete process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN;
  });
});
