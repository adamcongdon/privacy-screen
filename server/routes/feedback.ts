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
import { collectDiagnostics, type Diagnostics } from '../lib/feedback-diagnostics';

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
  const cfg = loadConfig();
  const diag = collectDiagnostics(cfg);
  const scrubbed = scrubDiagnostics(diag);
  return c.json(scrubbed, 200);
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
  const summaryScrub = scrubText(userSummary, map, vocab, {
    sourceEvent: 'app:feedback:summary',
    config: cfg,
  });

  // Run the diagnostics JSON string through the same scrubber. We re-serialize
  // afterwards so the output is still valid JSON-shaped for the issue body.
  const diagnosticsScrubJson = scrubText(
    JSON.stringify(scrubDiagnostics(diagnostics), null, 2),
    map,
    vocab,
    { sourceEvent: 'app:feedback:diagnostics', config: cfg },
  );

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
  //
  // spawnSync (not Bun.spawn) so we get a deterministic synchronous result
  // for the route. The 60s budget is enforced by the kernel via the timeout
  // option; on timeout, status is null and signal is 'SIGTERM'.
  const result = spawnSync(claudeBin, ['-p', prompt], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
    // env preserved verbatim — `gh` needs $HOME/$PATH/$GH_* to authenticate
    env: process.env,
    // Inherit no stdin so claude doesn't sit waiting on a tty
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return c.json(
      { ok: false, error: `claude spawn failed: ${result.error.message}` },
      502,
    );
  }
  if (result.signal === 'SIGTERM') {
    return c.json(
      { ok: false, error: `claude timed out after ${SPAWN_TIMEOUT_MS}ms` },
      504,
    );
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(0, STDOUT_TRUNCATE_LEN);
    return c.json(
      { ok: false, error: `claude exited ${result.status}: ${stderr}` },
      502,
    );
  }

  const stdout = (result.stdout ?? '').slice(0, STDOUT_TRUNCATE_LEN);
  return c.json({ ok: true, output: stdout }, 200);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve which `claude` binary to use. The default is the literal string
 * "claude" — relying on PATH like the rest of the server does. The test seam
 * env var lets the feedback-route test substitute a stub script so we can
 * exercise the 503 path and the anti-leak capture without touching PATH.
 */
function resolveClaudeBin(): string {
  return process.env.PRIVACY_SCREEN_FEEDBACK_TEST_CLAUDE_BIN ?? 'claude';
}

/**
 * Presence check for the resolved binary. If the test seam pointed us at a
 * specific file path (anything containing `/`), we check whether the path
 * resolves to an executable by running `--version`. Otherwise we delegate
 * to the same `checkClaudeCode()` helper the server uses at boot.
 */
function checkClaudeBinary(bin: string): { found: boolean; version: string | null } {
  if (bin === 'claude') return checkClaudeCode();
  // Test-seam path — run --version directly against the supplied binary.
  // A nonexistent file path becomes ENOENT, which we want to map to found:false.
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status === 0) return { found: true, version: (r.stdout ?? '').trim() };
    return { found: false, version: null };
  } catch {
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
