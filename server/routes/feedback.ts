/**
 * /api/feedback — Send-feedback button backend (Issue #15).
 *
 * Two endpoints:
 *   GET  /preview — returns the scrubbed diagnostics JSON. No claude spawn.
 *                   Used by the UI to show the user what's about to be sent.
 *   POST /        — accepts { summary: string } and runs the full pipeline:
 *                     1. Refuses 503 if `claude` is not on PATH (mirrors the
 *                        boot-time gate in server.ts).
 *                     2. Collects diagnostics.
 *                     3. Scrubs the user's summary + a stringified copy of the
 *                        diagnostics through scrubText() against a fresh
 *                        ScrubMap + the user's VocabStore.
 *                     4. Spawns `claude -p <prompt>` with a 60s wall-clock
 *                        timeout, env preserved (so `gh` can use the user's
 *                        auth). The prompt asks claude to file a GitHub issue
 *                        at adamcongdon/privacy-screen via `gh` CLI.
 *
 * Test seam: PRIVACY_SCREEN_FEEDBACK_TEST_CLAUDE_BIN overrides the binary
 * used for both the presence check AND the spawn. This lets tests stub the
 * CLI without touching PATH (the rest of the server still uses real claude).
 *
 * Privacy invariant (ISC-32): every string that enters the spawn argv has
 * been through scrubText() against the user's vocab + scrub map. The
 * anti-leak test captures the argv and asserts no raw customer name appears,
 * only {CUSTOMER}/{CUSTOMER_N} tokens.
 */

import { Hono } from 'hono';
import { spawnSync } from 'child_process';
import { loadConfig } from '../../src/config';
import { scrubText } from '../../src/scrubber';
import { ScrubMap } from '../../src/scrub-map';
import { getVocab } from '../lib/vocab-store';
import { checkClaudeCode } from '../lib/claude-code-check';
import { collectDiagnostics, type Diagnostics, assertRedacted } from '../lib/feedback-diagnostics';

export const feedbackRoute = new Hono();

/** Hard cap on the user summary so we don't blow the argv length on Linux. */
const MAX_SUMMARY_LEN = 8_000;
/** Wall-clock budget for the claude spawn. */
const SPAWN_TIMEOUT_MS = 60_000;
/** Truncate captured stdout to keep the JSON response bounded. */
const STDOUT_TRUNCATE_LEN = 4_000;

interface PostBody {
  summary: string;
}

/**
 * GET /api/feedback/preview — return the diagnostics in their scrubbed form
 * so the UI can show the user exactly what's about to be sent. Pure read —
 * no spawn, no network egress.
 */
feedbackRoute.get('/preview', (c) => {
  try {
    const cfg = loadConfig();
    const diag = collectDiagnostics(cfg);
    const scrubbed = scrubDiagnostics(diag);
    try {
      assertRedacted(scrubbed.config);
    } catch (err) {
      process.stderr.write('[privacy-screen] feedback.redaction.check.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
      return c.json({ error: 'preview unavailable' }, 500);
    }
    return c.json(scrubbed, 200);
  } catch (err) {
    process.stderr.write('[privacy-screen] feedback.preview.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
    return c.json({ error: 'preview unavailable' }, 500);
  }
});

/**
 * POST /api/feedback — file a GitHub issue via the local claude CLI.
 */
feedbackRoute.post('/', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== 'object') {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
    return c.json({ ok: false, error: 'summary is required' }, 400);
  }

  // ── 1. Gate on local claude CLI presence (mirrors the boot check) ───────
  const claudeBin = resolveClaudeBin();
  const presence = checkClaudeBinary(claudeBin);
  if (!presence.found) {
    return c.json(
      {
        ok: false,
        error:
          'claude CLI not found on PATH — install Claude Code and run `claude login` ' +
          'before submitting feedback.',
      },
      503,
    );
  }

  const cfg = loadConfig();
  const diagnostics = collectDiagnostics(cfg);

  // ── 2. Scrub everything that's about to leave the process ───────────────
  //
  // Use a fresh ScrubMap rather than the server-wide singleton so we do not
  // pollute the shared vocab state with one-off summary tokens. The user's
  // VocabStore is still consulted for allowlist + pre-minted customer names.
  const map = new ScrubMap();
  const vocab = getVocab();

  const userSummary = String(body.summary).slice(0, MAX_SUMMARY_LEN);

  // Defensive scrub: wrap scrubText invocations to avoid a crashing user
  // input from bubbling up and echoing sensitive data.
  let summaryScrub;
  let diagnosticsScrubJson;
  try {
    if (
      process.env.NODE_ENV !== 'production' &&
      process.env.__PRIVACY_SCREEN_TEST_SCRUB_THROW === '1'
    ) {
      throw new Error('simulated scrub failure (test seam)');
    }

    summaryScrub = scrubText(userSummary, map, vocab, {
      sourceEvent: 'app:feedback:summary',
      config: cfg,
    });

    const scrubbedDiagnosticsObj = scrubDiagnostics(diagnostics);
    try {
      assertRedacted(scrubbedDiagnosticsObj.config);
    } catch (err) {
      process.stderr.write('[privacy-screen] feedback.redaction.check.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
      return c.json({ ok: false, error: 'redaction integrity check failed' }, 500);
    }

    diagnosticsScrubJson = scrubText(
      JSON.stringify(scrubbedDiagnosticsObj, null, 2),
      map,
      vocab,
      { sourceEvent: 'app:feedback:diagnostics', config: cfg },
    );
  } catch (err) {
    process.stderr.write('[privacy-screen] feedback.scrub.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
    return c.json({ ok: false, error: 'scrub failed — feedback not sent' }, 500);
  }

  // Defense in depth: if the user pasted a credential into the summary, the
  // scrubber sets hasCredentials. Refuse to relay — same posture as /api/send.
  if (summaryScrub.hasCredentials || diagnosticsScrubJson.hasCredentials) {
    return c.json(
      {
        ok: false,
        error:
          'a credential was detected in the feedback payload — remove it before submitting.',
      },
      400,
    );
  }

  const prompt = buildPrompt(summaryScrub.scrubbed, diagnosticsScrubJson.scrubbed);

  // ── 3. Spawn claude -p <prompt> ─────────────────────────────────────────
  // Use Bun.spawn so the event loop is not blocked by a long-running
  // external process. AbortSignal.timeout enforces the wall-clock budget.
  try {
    const proc = Bun.spawn({
      cmd: [claudeBin, '-p', prompt],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
      signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
    });

    const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
    const stderrPromise = new Response(proc.stderr).text().catch(() => '');
    const exitCode = await proc.exited;
    const stdout = (await stdoutPromise).slice(0, STDOUT_TRUNCATE_LEN);
    const stderr = (await stderrPromise).slice(0, STDOUT_TRUNCATE_LEN);

    if (exitCode === null) {
      return c.json({ ok: false, error: `claude timed out after ${SPAWN_TIMEOUT_MS}ms` }, 504);
    }
    if (exitCode !== 0) {
      return c.json({ ok: false, error: `claude exited ${exitCode}: ${stderr}` }, 502);
    }

    // MEDIUM-2: only return a github.com URL if present
    const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const output = urlMatch ? urlMatch[0] : '(no url in output)';
    return c.json({ ok: true, output }, 200);
  } catch (err) {
    // AbortError or spawn failure — map to 502/504 as appropriate
    const msg = (err as Error)?.message ?? String(err);
    if (msg && msg.toLowerCase().includes('aborted')) {
      return c.json({ ok: false, error: `claude timed out after ${SPAWN_TIMEOUT_MS}ms` }, 504);
    }
    return c.json({ ok: false, error: `claude spawn failed: ${msg}` }, 502);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve which `claude` binary to use. The default is the literal string
 * "claude" — relying on PATH like the rest of the server does. The test seam
 * env var lets the feedback-route test substitute a stub script so we can
 * exercise the 503 path and the anti-leak capture without touching PATH.
 */
export function resolveClaudeBin(): string {
  if (process.env.NODE_ENV === 'production') return 'claude';
  return process.env.__PRIVACY_SCREEN_TEST_CLAUDE_BIN ?? 'claude';
}

/**
 * Presence check for the resolved binary. If the test seam pointed us at a
 * specific file path (anything containing `/`), we check whether the path
 * resolves to an executable by running `--version`. Otherwise we delegate
 * to the same `checkClaudeCode()` helper the server uses at boot.
 */
function checkClaudeBinary(bin: string): { found: boolean; version: string | null } {
  if (bin === 'claude') {
    try {
      const r = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 1500 });
      if (r && r.status === 0) return { found: true, version: (r.stdout ?? '').trim() };
      return { found: false, version: null };
    } catch (err) {
      process.stderr.write('[privacy-screen] feedback.binary.check.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
      return { found: false, version: null };
    }
  }

  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 1500 });
    if (r.status === 0) return { found: true, version: (r.stdout ?? '').trim() };
    return { found: false, version: null };
  } catch (err) {
    process.stderr.write('[privacy-screen] feedback.binary.check.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
    return { found: false, version: null };
  }
}

/**
 * Scrub the structured diagnostics object. `collectDiagnostics` already
 * redacts identifying lists and paths down to counts and booleans, so the
 * only field that can carry user-shaped strings here is `claudeCode.version`
 * (which we keep — it's the upstream CLI version string, no user data).
 *
 * We return a NEW object so callers can serialize it without worrying about
 * shared references with the unscrubbed source.
 */
function scrubDiagnostics(d: Diagnostics): Diagnostics {
  return {
    version: d.version,
    claudeCode: { found: d.claudeCode.found, version: d.claudeCode.version },
    judge: { enabled: d.judge.enabled, configured: d.judge.configured },
    config: { ...d.config },
  };
}

/**
 * Build the prompt for `claude -p`. The prompt instructs claude to file a
 * GitHub issue against this repository using the local `gh` CLI. Everything
 * variable in here (`summary`, `diagnosticsJson`) has already been through
 * scrubText() in the caller.
 */
function buildPrompt(summary: string, diagnosticsJson: string): string {
  return [
    'You are filing a GitHub issue on behalf of a privacy-screen user who clicked',
    'the in-app "Send feedback" button. Use the local `gh` CLI (already',
    'authenticated for the user) to open an issue at adamcongdon/privacy-screen.',
    'When invoking gh, always pass --repo adamcongdon/privacy-screen; do not rely on the current working directory.',
    '',
    'Title: pick a short, specific title derived from the user summary below.',
    'Body: use the scrubbed user summary verbatim, then append a',
    '"<details><summary>Diagnostics</summary>" block containing the diagnostics JSON.',
    '',
    'Do NOT add any extra prose, do NOT add labels, do NOT @-mention anyone.',
    'When done, print the URL of the issue you opened on stdout and exit.',
    '',
    '--- USER SUMMARY (already scrubbed) ---',
    summary,
    '--- END USER SUMMARY ---',
    '',
    '--- DIAGNOSTICS (already scrubbed) ---',
    diagnosticsJson,
    '--- END DIAGNOSTICS ---',
    '',
  ].join('\n');
}
