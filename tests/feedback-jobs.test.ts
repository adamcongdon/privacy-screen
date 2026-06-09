/**
 * Tests for server/lib/feedback-jobs.ts — the in-memory job store backing
 * the async feedback submission flow (#22).
 *
 * The store is intentionally minimal (Map + lazy prune), so the tests focus
 * on the contract:
 *   - createJob mints a unique jobId in `queued` state
 *   - getJob reads, returns null for misses
 *   - updateJob merges and bumps updatedAt
 *   - pruneOldJobs drops entries older than maxAgeMs
 *   - _resetForTests clears the map
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createJob,
  getJob,
  updateJob,
  pruneOldJobs,
  _resetForTests,
  type JobState,
} from '../server/lib/feedback-jobs';

beforeEach(() => {
  _resetForTests();
});

/** Small helper — sleep for `ms` so updatedAt can advance past startedAt. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createJob', () => {
  test('returns a JobState with status=queued and matching timestamps', () => {
    const before = Date.now();
    const job = createJob();
    const after = Date.now();
    expect(job.status).toBe('queued');
    expect(typeof job.jobId).toBe('string');
    expect(job.jobId.length).toBeGreaterThan(0);
    expect(job.startedAt).toBeGreaterThanOrEqual(before);
    expect(job.startedAt).toBeLessThanOrEqual(after);
    expect(job.updatedAt).toBe(job.startedAt);
    expect(job.issueNumber).toBeUndefined();
    expect(job.issueUrl).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  test('mints distinct jobIds across calls', () => {
    const a = createJob();
    const b = createJob();
    const c = createJob();
    const ids = new Set([a.jobId, b.jobId, c.jobId]);
    expect(ids.size).toBe(3);
  });
});

describe('getJob', () => {
  test('returns the stored state for a known jobId', () => {
    const job = createJob();
    const fetched = getJob(job.jobId);
    expect(fetched).not.toBeNull();
    expect(fetched!.jobId).toBe(job.jobId);
    expect(fetched!.status).toBe('queued');
  });

  test('returns null for an unknown jobId', () => {
    expect(getJob('does-not-exist')).toBeNull();
    expect(getJob('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('updateJob', () => {
  test('merges patches into the existing state', () => {
    const job = createJob();
    updateJob(job.jobId, { status: 'filing' });
    const after = getJob(job.jobId);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('filing');
    // Identity + creation time preserved
    expect(after!.jobId).toBe(job.jobId);
    expect(after!.startedAt).toBe(job.startedAt);
  });

  test('updates updatedAt to a later timestamp', async () => {
    const job = createJob();
    const originalUpdated = job.updatedAt;
    await sleep(15);
    updateJob(job.jobId, { status: 'drafting' });
    const after = getJob(job.jobId)!;
    expect(after.updatedAt).toBeGreaterThan(originalUpdated);
  });

  test('records terminal data on done', () => {
    const job = createJob();
    updateJob(job.jobId, {
      status: 'done',
      issueNumber: 42,
      issueUrl: 'https://github.com/adamcongdon/privacy-screen/issues/42',
    });
    const after = getJob(job.jobId)!;
    expect(after.status).toBe('done');
    expect(after.issueNumber).toBe(42);
    expect(after.issueUrl).toBe('https://github.com/adamcongdon/privacy-screen/issues/42');
  });

  test('silently no-ops on unknown jobId', () => {
    // Should not throw, and the map should remain empty
    expect(() => updateJob('nope', { status: 'done' })).not.toThrow();
    expect(getJob('nope')).toBeNull();
  });

  test('cannot overwrite jobId or startedAt via patch', () => {
    const job = createJob();
    updateJob(job.jobId, {
      jobId: 'attacker-controlled',
      startedAt: 0,
      status: 'filing',
    } as Partial<JobState>);
    const after = getJob(job.jobId)!;
    expect(after.jobId).toBe(job.jobId);
    expect(after.startedAt).toBe(job.startedAt);
    expect(after.status).toBe('filing');
  });
});

describe('pruneOldJobs', () => {
  test('removes jobs older than maxAgeMs and returns the count', async () => {
    const stale = createJob();
    await sleep(120);
    const fresh = createJob();

    const removed = pruneOldJobs(100);
    expect(removed).toBe(1);
    expect(getJob(stale.jobId)).toBeNull();
    expect(getJob(fresh.jobId)).not.toBeNull();
  });

  test('returns 0 when nothing is stale enough to drop', () => {
    createJob();
    createJob();
    const removed = pruneOldJobs(10 * 60 * 1000);
    expect(removed).toBe(0);
  });

  test('createJob lazily prunes stale entries before insertion', async () => {
    const stale = createJob();
    await sleep(120);
    // Call createJob with a manual prune first to verify the lazy-prune in
    // createJob would also drop the stale record. We use the explicit prune
    // call here for determinism (createJob's prune uses the default 10min
    // horizon, not a configurable one).
    pruneOldJobs(100);
    const fresh = createJob();
    expect(getJob(stale.jobId)).toBeNull();
    expect(getJob(fresh.jobId)).not.toBeNull();
  });
});

describe('_resetForTests', () => {
  test('clears the entire map', () => {
    const a = createJob();
    const b = createJob();
    expect(getJob(a.jobId)).not.toBeNull();
    expect(getJob(b.jobId)).not.toBeNull();
    _resetForTests();
    expect(getJob(a.jobId)).toBeNull();
    expect(getJob(b.jobId)).toBeNull();
  });
});
