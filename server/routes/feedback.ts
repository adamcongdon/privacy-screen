/**
 * /api/feedback — Send-feedback button backend (Issue #15, async rework #22).
 *
 * Three endpoints:
 *   GET  /preview      — returns the scrubbed diagnostics JSON. No spawn.
 *                        Used by the UI to show the user what's about to be sent.
 *   POST /             — accepts { summary: string }, runs scrub + credential
 *                        gating, then enqueues a background job that pipes a
 *                        deterministically-assembled body to
 *                        `gh issue create --body-file -`. Returns 202 + jobId
 *                        immediately. No LLM, no inline spawn wait.
 *   GET  /:jobId       — poll for status (queued | drafting | filing | done | error).
 *                        On done, returns issueNumber + issueUrl extracted from
 *                        gh's stdout.
 *
 * Test seam: __PRIVACY_SCREEN_TEST_GH_BIN overrides the gh binary used for
 * both the presence check AND the spawn. This lets tests stub the CLI without
 * touching PATH.
 *
 * Privacy invariant (ISC-32): every string that enters the spawn argv or the
 * issue body has been through scrubText() against the user's vocab + scrub
 * map. The anti-leak test captures the argv + body via the same stub pattern
 * and asserts no raw customer name appears, only {CUSTOMER}/{CUSTOMER_N}
 * tokens.
 */

import { Hono } from 'hono';
import { spawnSync } from 'child_process';
import { loadConfig } from '../../src/config';
import { scrubText } from '../../src/scrubber';
import { ScrubMap } from '../../src/scrub-map';
import { getVocab } from '../lib/vocab-store';
import { collectDiagnostics, type Diagnostics, assertRedacted } from '../lib/feedback-diagnostics';
import { createJob, getJob, updateJob } from '../lib/feedback-jobs';

export const feedbackRoute = new Hono();

/** Hard cap on the user summary so a pathological paste can't blow argv length. */
const MAX_SUMMARY_LEN = 8_000;
/** Wall-clock budget for the `gh issue create` spawn. */
const SPAWN_TIMEOUT_MS = 60_000;
/** Maximum stderr we keep around when surfacing a gh failure. */
const STDERR_TRUNCATE_LEN = 1_000;
/** Maximum issue-title length we send to gh. */
const TITLE_MAX_LEN = 60;
/** GitHub repo the issue is filed against. */
const TARGET_REPO = 'adamcongdon/privacy-screen';

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
 * POST /api/feedback — scrub-and-validate inline, then enqueue a background
 * job and return 202 + jobId. Never blocks the caller on the gh spawn.
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

  // ── 1. Gate on local gh CLI presence ─────────────────────────────────────
  const ghBin = resolveGhBin();
  const presence = checkGhBinary(ghBin);
  if (!presence.found) {
    return c.json(
      {
        ok: false,
        error:
          'gh CLI not found on PATH — install GitHub CLI and run `gh auth login` ' +
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

  // ── 3. Enqueue the background job and return immediately ────────────────
  const job = createJob();
  // Fire-and-forget. The worker owns all subsequent state transitions; if it
  // throws unexpectedly the catch below records the error on the job so a
  // polling client still gets a final state instead of hanging forever.
  void runJob(job.jobId, ghBin, summaryScrub.scrubbed, diagnosticsScrubJson.scrubbed).catch(
    (err) => {
      const msg = (err as Error)?.message ?? String(err);
      process.stderr.write('[privacy-screen] feedback.job.unexpected: ' + msg + '\n');
      updateJob(job.jobId, { status: 'error', error: msg.slice(0, STDERR_TRUNCATE_LEN) });
    },
  );

  return c.json({ ok: true, jobId: job.jobId }, 202);
});

/**
 * GET /api/feedback/:jobId — poll for status of an enqueued submission.
 * Returns the JobState verbatim on hit, 404 on miss.
 */
feedbackRoute.get('/:jobId', (c) => {
  const jobId = c.req.param('jobId');
  const state = getJob(jobId);
  if (!state) {
    return c.json({ ok: false, error: 'not found' }, 404);
  }
  return c.json(state, 200);
});

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * Background worker for a single feedback submission. Walks the job through
 * its phases (drafting → filing → done|error) and never throws to the caller —
 * any failure is recorded on the job itself.
 */
export async function runJob(
  jobId: string,
  ghBin: string,
  summary: string,
  diagnosticsJson: string,
): Promise<void> {
  updateJob(jobId, { status: 'drafting' });

  const title = buildTitle(summary);
  const issueBody = buildBody(summary, diagnosticsJson);

  updateJob(jobId, { status: 'filing' });

  try {
    const proc = Bun.spawn({
      cmd: [
        ghBin,
        'issue',
        'create',
        '--repo',
        TARGET_REPO,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
      signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
    });

    // Write the body to stdin and close it. `proc.stdin` is a FileSink in Bun.
    try {
      proc.stdin.write(issueBody);
      await proc.stdin.end();
    } catch (err) {
      // If the child died before we finished writing, fall through to exit code
      // handling — stderr usually has the real reason.
      process.stderr.write('[privacy-screen] feedback.gh.stdin.failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
    }

    const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
    const stderrPromise = new Response(proc.stderr).text().catch(() => '');
    const exitCode = await proc.exited;
    const stdout = await stdoutPromise;
    const stderr = (await stderrPromise).slice(0, STDERR_TRUNCATE_LEN);

    if (exitCode !== 0) {
      updateJob(jobId, {
        status: 'error',
        error: stderr.trim() || `gh issue create failed (exit ${exitCode})`,
      });
      return;
    }

    const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const issueUrl = urlMatch ? urlMatch[0] : undefined;
    const numberMatch = issueUrl ? issueUrl.match(/\/issues\/(\d+)/) : null;
    const issueNumber = numberMatch ? Number.parseInt(numberMatch[1], 10) : undefined;

    if (!issueUrl) {
      updateJob(jobId, {
        status: 'error',
        error: 'gh exited 0 but no github.com URL appeared in stdout',
      });
      return;
    }

    updateJob(jobId, { status: 'done', issueUrl, issueNumber });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg && msg.toLowerCase().includes('aborted')) {
      updateJob(jobId, { status: 'error', error: `gh timed out after ${SPAWN_TIMEOUT_MS}ms` });
      return;
    }
    updateJob(jobId, { status: 'error', error: `gh spawn failed: ${msg.slice(0, STDERR_TRUNCATE_LEN)}` });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Produce a single-line, length-capped title from the (already-scrubbed) user
 * summary. Falls back to a sentinel when the summary is empty after trimming.
 */
export function buildTitle(summary: string): string {
  const flattened = summary.replace(/[\r\n]+/g, ' ').trim();
  if (flattened.length === 0) return 'Feedback';
  return flattened.slice(0, TITLE_MAX_LEN);
}

/**
 * Assemble the deterministic issue body. The scrubbed summary goes on top so
 * the issue preview shows the user's words; diagnostics live in a collapsed
 * <details> block so triagers can expand them without cluttering the feed.
 *
 * The diagnostics JSON is already a pretty-printed string from the caller.
 */
export function buildBody(summary: string, diagnosticsJson: string): string {
  return [
    summary,
    '',
    '<details><summary>Diagnostics</summary>',
    '',
    '```json',
    diagnosticsJson,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

/**
 * Resolve which `gh` binary to use. Default is the literal "gh" — relying on
 * PATH like the rest of the system. The test seam env var lets tests stub the
 * CLI without touching PATH.
 */
export function resolveGhBin(): string {
  if (process.env.NODE_ENV === 'production') return 'gh';
  return process.env.__PRIVACY_SCREEN_TEST_GH_BIN ?? 'gh';
}

/**
 * Presence check for the resolved gh binary. Mirrors the shape of
 * checkClaudeBinary() in the previous design — short timeout, no exceptions
 * escape.
 */
export function checkGhBinary(bin: string): { found: boolean; version: string | null } {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 1500 });
    if (r && r.status === 0) return { found: true, version: (r.stdout ?? '').trim() };
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
