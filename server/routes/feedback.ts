/**
 * /api/feedback — Send-feedback button backend (Issue #15; universal-relay
 * rework supersedes the gh-CLI async design of #22).
 *
 * Three endpoints:
 *   GET  /preview      — returns the scrubbed diagnostics JSON. No egress.
 *                        Used by the UI to show the user what's about to be sent.
 *   POST /             — accepts { summary: string, type?: 'bug'|'enhancement'|
 *                        'question' }, runs scrub + credential gating, then
 *                        enqueues a background job that POSTs a
 *                        deterministically-assembled issue to the feedback relay
 *                        (see server/lib/feedback-relay.ts + relay/). Returns
 *                        202 + jobId immediately. No LLM, no `gh`, no inline wait.
 *   GET  /:jobId       — poll for status (queued | drafting | filing | done | error).
 *                        On done, returns issueNumber + issueUrl from the relay.
 *
 * Why a relay: creating a GitHub issue needs an `Issues: write` credential. That
 * cannot be shipped in a distributed desktop binary, so it lives server-side
 * behind a small Cloudflare Worker we control. This is what makes feedback work
 * for ANY user — no GitHub account, no `gh` CLI.
 *
 * Test seam: __PRIVACY_SCREEN_TEST_RELAY_URL (non-production) points the relay
 * client at a local stub server so tests never touch the network.
 *
 * Privacy invariant (ISC-32): every string that enters the relay payload has
 * been through scrubText() against the user's vocab + scrub map. The anti-leak
 * test captures the exact body POSTed to the (stub) relay and asserts no raw
 * customer name appears, only {CUSTOMER}/{CUSTOMER_N} tokens.
 */

import { Hono } from 'hono';
import { loadConfig } from '../../src/config';
import { scrubText } from '../../src/scrubber';
import { ScrubMap } from '../../src/scrub-map';
import { getVocab } from '../lib/vocab-store';
import { collectDiagnostics, type Diagnostics, assertRedacted } from '../lib/feedback-diagnostics';
import { createJob, getJob, updateJob } from '../lib/feedback-jobs';
import {
  postToRelay,
  isFeedbackType,
  type FeedbackType,
} from '../lib/feedback-relay';

export const feedbackRoute = new Hono();

/** Hard cap on the user summary so a pathological paste can't blow the payload. */
const MAX_SUMMARY_LEN = 8_000;
/** Maximum error length we keep around when surfacing a relay failure. */
const ERROR_TRUNCATE_LEN = 1_000;
/** Maximum issue-title length we send to the relay. */
const TITLE_MAX_LEN = 60;

/**
 * GET /api/feedback/preview — return the diagnostics in their scrubbed form
 * so the UI can show the user exactly what's about to be sent. Pure read —
 * no egress.
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
 * job and return 202 + jobId. Never blocks the caller on the relay round-trip.
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

  // Optional feedback type → GitHub label. Defaults to 'bug' for back-compat
  // with older clients that only send { summary }.
  const type: FeedbackType = isFeedbackType(body.type) ? body.type : 'bug';

  const cfg = loadConfig();
  const diagnostics = collectDiagnostics(cfg);

  // ── Scrub everything that's about to leave the process ──────────────────
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

  // ── Enqueue the background job and return immediately ───────────────────
  const job = createJob();
  // Fire-and-forget. The worker owns all subsequent state transitions; if it
  // throws unexpectedly the catch below records the error on the job so a
  // polling client still gets a final state instead of hanging forever.
  void runJob(job.jobId, summaryScrub.scrubbed, diagnosticsScrubJson.scrubbed, type).catch(
    (err) => {
      const msg = (err as Error)?.message ?? String(err);
      process.stderr.write('[privacy-screen] feedback.job.unexpected: ' + msg + '\n');
      updateJob(job.jobId, { status: 'error', error: msg.slice(0, ERROR_TRUNCATE_LEN) });
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
  summary: string,
  diagnosticsJson: string,
  type: FeedbackType,
): Promise<void> {
  updateJob(jobId, { status: 'drafting' });

  const title = buildTitle(summary);
  const issueBody = buildBody(summary, diagnosticsJson);

  updateJob(jobId, { status: 'filing' });

  const result = await postToRelay({ title, body: issueBody, type });

  if (!result.ok) {
    updateJob(jobId, { status: 'error', error: result.error.slice(0, ERROR_TRUNCATE_LEN) });
    return;
  }

  updateJob(jobId, {
    status: 'done',
    issueUrl: result.issueUrl,
    issueNumber: result.issueNumber,
  });
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
