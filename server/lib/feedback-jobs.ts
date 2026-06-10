/**
 * In-memory job store for async feedback submission (#22).
 *
 * The feedback POST flow used to spawn `claude -p` synchronously, paying a flat
 * 30-120s for a single line of LLM-driven title rephrasing. We've deleted that
 * dependency: the new POST returns 202 + jobId immediately, and a background
 * worker assembles the issue body deterministically and pipes it to
 * `gh issue create --body-file -`. Clients poll GET /:jobId for status.
 *
 * This module owns the lifecycle of those job records. Pure in-memory by
 * design — there is no persistence layer. If the server restarts, in-flight
 * jobs are lost (acceptable: the user can resubmit). To keep the map from
 * growing without bound, every entry-point (createJob/getJob) prunes records
 * older than `PRUNE_MAX_AGE_MS` (default 10 minutes). We deliberately avoid a
 * setInterval timer because timers leak in test environments and tie the
 * module to the host event loop.
 */

export type JobStatus = 'queued' | 'drafting' | 'filing' | 'done' | 'error';

export interface JobState {
  jobId: string;
  status: JobStatus;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
  /** ms epoch when the job was created. */
  startedAt: number;
  /** ms epoch of the last mutation. */
  updatedAt: number;
}

/** Default prune horizon — jobs older than this are dropped on the next access. */
const PRUNE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Module-scoped map of jobId → state. Single source of truth for the
 * lifetime of the server process.
 */
const jobs = new Map<string, JobState>();

/**
 * Create a fresh job in `queued` state. Generates a random jobId via
 * `crypto.randomUUID()`. Lazily prunes the map before insertion so a
 * long-running process doesn't accumulate stale records.
 */
export function createJob(): JobState {
  pruneOldJobs();
  const now = Date.now();
  const state: JobState = {
    jobId: crypto.randomUUID(),
    status: 'queued',
    startedAt: now,
    updatedAt: now,
  };
  jobs.set(state.jobId, state);
  return state;
}

/**
 * Read-only fetch. Returns `null` for unknown jobIds (so callers can map to
 * 404 without try/catch). Also runs lazy pruning — keeps the map honest even
 * if creates have slowed down.
 */
export function getJob(jobId: string): JobState | null {
  pruneOldJobs();
  return jobs.get(jobId) ?? null;
}

/**
 * Merge a partial patch into an existing job and refresh `updatedAt`.
 * Silently no-ops if the jobId is unknown (the worker should never call this
 * for a pruned id, but we don't want a pruned record to crash the worker).
 */
export function updateJob(jobId: string, patch: Partial<JobState>): void {
  const current = jobs.get(jobId);
  if (!current) return;
  const next: JobState = {
    ...current,
    ...patch,
    // Always preserve identity + creation time; never let a caller overwrite them.
    jobId: current.jobId,
    startedAt: current.startedAt,
    updatedAt: Date.now(),
  };
  jobs.set(jobId, next);
}

/**
 * Drop every job whose `startedAt` is older than `maxAgeMs`. Returns the
 * count removed so callers can log or assert in tests.
 */
export function pruneOldJobs(maxAgeMs: number = PRUNE_MAX_AGE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [id, state] of jobs) {
    if (state.startedAt < cutoff) {
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Test-only escape hatch. Clears the entire map so each test starts with a
 * predictable, empty store. NEVER call from production code.
 */
export function _resetForTests(): void {
  jobs.clear();
}
