/**
 * In-memory staging for the xlsx inspect→commit flow (#23, Segment 3C2).
 *
 * The xlsx upload UX is a two-step ceremony:
 *
 *   1. Inspect — user uploads the workbook → server returns sheet/header
 *      inventory + auto-resolved patterns + sample values. NO scrubbing.
 *      Server holds the raw buffer keyed by an `uploadId`.
 *   2. Commit — frontend POSTs `uploadId` + per-column `CommitOverrides` →
 *      server runs `scrubXlsx` against the staged buffer → returns the
 *      scrubbed bytes. Server drops the buffer afterwards.
 *
 * This module owns the lifecycle of those staged buffers. Pure in-memory by
 * design — there is no persistence layer. If the server restarts, staged
 * uploads are lost (acceptable: the user can re-upload). To keep the map from
 * growing without bound, every entry-point (`stageUpload` / `getUpload`)
 * prunes records older than `PRUNE_MAX_AGE_MS` (default 10 minutes). We
 * deliberately avoid a setInterval timer — timers leak in test environments
 * and tie the module to the host event loop. Same pattern as
 * `server/lib/feedback-jobs.ts`, Segment 2A.
 *
 * Privacy invariant: the staged buffer must NEVER touch disk. The buffer
 * sits in `Map` memory only, and `dropUpload` is called immediately after a
 * successful commit. Even if the process crashes between inspect and commit,
 * nothing has been persisted.
 */

/** A workbook waiting on its commit step. */
export interface StagedUpload {
  /** Random UUID used by the commit endpoint to look this entry back up. */
  uploadId: string;
  /** Raw xlsx bytes — the buffer is what `scrubXlsx` re-parses at commit. */
  buffer: Buffer;
  /** Original upload filename (used to derive `<name>.scrubbed.xlsx` at commit). */
  fileName: string;
  /** Byte length of `buffer` — handy for diagnostics + UI display. */
  size: number;
  /** ms epoch when the entry was staged. Drives lazy pruning. */
  createdAt: number;
}

/** Default prune horizon — entries older than this are dropped on next access. */
const PRUNE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Module-scoped map of uploadId → staged buffer. Single source of truth for
 * the lifetime of the server process.
 */
const uploads = new Map<string, StagedUpload>();

/**
 * Stage a buffer for later commit. Lazily prunes the map before insertion so
 * a long-running process doesn't accumulate stale records. Returns the full
 * staged entry so the caller can echo back `uploadId` / `size` to the
 * frontend without a follow-up read.
 */
export function stageUpload(buffer: Buffer, fileName: string): StagedUpload {
  pruneOldUploads();
  const entry: StagedUpload = {
    uploadId: crypto.randomUUID(),
    buffer,
    fileName,
    size: buffer.length,
    createdAt: Date.now(),
  };
  uploads.set(entry.uploadId, entry);
  return entry;
}

/**
 * Read-only fetch. Returns `null` for unknown OR pruned uploadIds so callers
 * can map cleanly to 404 without try/catch. Also runs lazy pruning so a
 * never-committed entry doesn't survive past its horizon just because nobody
 * has staged anything new.
 */
export function getUpload(uploadId: string): StagedUpload | null {
  pruneOldUploads();
  return uploads.get(uploadId) ?? null;
}

/**
 * Drop a single entry by uploadId. Idempotent — safe to call on an unknown
 * id (e.g. after a prune already removed it). The commit endpoint calls this
 * immediately after a successful scrub so the raw buffer doesn't linger in
 * memory longer than the user's explicit consent.
 */
export function dropUpload(uploadId: string): void {
  uploads.delete(uploadId);
}

/**
 * Drop every entry whose `createdAt` is older than `maxAgeMs`. Returns the
 * count removed so callers can log or assert in tests.
 */
export function pruneOldUploads(maxAgeMs: number = PRUNE_MAX_AGE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [id, entry] of uploads) {
    if (entry.createdAt < cutoff) {
      uploads.delete(id);
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
  uploads.clear();
}
