/**
 * /api/files/xlsx — direct endpoints for the two-step xlsx flow (#23, Segment 3C2).
 *
 * Two endpoints:
 *
 *   POST /inspect — multipart upload. Validates extension + size, parses the
 *     workbook via `inspectXlsx`, stages the raw bytes in
 *     `server/lib/xlsx-uploads.ts`, and returns sheet/header inventory + an
 *     `uploadId` the frontend will pass back to /commit.
 *
 *   POST /commit  — JSON body `{ uploadId, overrides? }`. Resolves the staged
 *     buffer, validates the overrides shape (PatternName | 'skip' | 'regex'
 *     per column), runs `scrubXlsx` with the merged config, drops the staged
 *     buffer, and returns the scrubbed bytes as base64 + a summary.
 *
 * The dispatch from `POST /api/files` (multipart, legacy text-only entry
 * point) also stages xlsx uploads here — see `server/routes/files.ts`. Both
 * paths converge on the same `stageUpload` / `getUpload` store, so a
 * front-end can use either entry point to start the flow.
 *
 * Privacy contract: the staged buffer never touches disk. On a successful
 * commit, `dropUpload(uploadId)` is called immediately after the scrub so
 * the raw bytes don't linger in memory beyond the explicit consent step.
 */

import { Hono } from 'hono';
import {
  inspectXlsx,
  scrubXlsx,
  normalizeCustomLabel,
  type CommitOverrides,
} from '../../src/xlsx-scrubber';
import { isPatternName } from '../../src/xlsx-types';
import { loadConfig } from '../../src/config';
import { getMap, getVocab } from '../lib/vocab-store';
import { stageUpload, getUpload, dropUpload } from '../lib/xlsx-uploads';

/**
 * 5 MiB cap on uploaded xlsx bytes. Mirrors `MAX_FILE_BYTES` in
 * `server/routes/files.ts` — kept in lockstep on purpose so a user who hits
 * the limit at one entry point doesn't get a different answer at the other.
 * Re-declared here (rather than re-exported) to keep the dispatch direction
 * one-way: files.ts dispatches into this router, never the reverse.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Set of allowed override `pattern` literals beyond PatternName. */
const NON_PATTERN_OVERRIDES = new Set(['skip', 'regex', 'custom']);

export const filesXlsxRoute = new Hono();

/**
 * POST /api/files/xlsx/inspect — multipart upload. Returns the inspection
 * payload + uploadId. NO scrubbing. NO disk writes.
 */
filesXlsxRoute.post('/inspect', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: 'expected multipart/form-data' }, 400);
  }

  const entry = form.get('file');
  if (!(entry instanceof File)) {
    return c.json({ ok: false, error: "missing 'file' field" }, 400);
  }

  const name = entry.name || 'unnamed.xlsx';
  if (!/\.xlsx$/i.test(name)) {
    return c.json(
      { ok: false, error: `expected .xlsx extension, got '${name}'` },
      400,
    );
  }
  if (entry.size > MAX_FILE_BYTES) {
    return c.json(
      { ok: false, error: `file exceeds ${MAX_FILE_BYTES} bytes` },
      400,
    );
  }

  const ab = await entry.arrayBuffer();
  const buffer = Buffer.from(ab);

  let inspection;
  try {
    inspection = await inspectXlsx(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `failed to parse xlsx: ${msg}` }, 400);
  }

  const staged = stageUpload(buffer, name);
  return c.json(
    {
      kind: 'xlsx-inspection' as const,
      uploadId: staged.uploadId,
      fileName: staged.fileName,
      size: staged.size,
      sheets: inspection.sheets,
    },
    200,
  );
});

/**
 * Validate the shape of a CommitOverrides payload. Returns null when valid,
 * or an error string explaining the precise mismatch. We accept missing /
 * empty overrides as "no per-column choices" — the auto-resolution path then
 * drives column actions exactly as the inspect step previewed.
 */
function validateOverridesShape(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'overrides: must be an object keyed by sheet name';
  }
  for (const [sheetName, perSheet] of Object.entries(raw as Record<string, unknown>)) {
    if (perSheet === null || typeof perSheet !== 'object' || Array.isArray(perSheet)) {
      return `overrides[${JSON.stringify(sheetName)}]: must be an object keyed by header`;
    }
    for (const [header, override] of Object.entries(perSheet as Record<string, unknown>)) {
      if (override === null || typeof override !== 'object' || Array.isArray(override)) {
        return `overrides[${JSON.stringify(sheetName)}][${JSON.stringify(header)}]: must be an object with a 'pattern' field`;
      }
      const pat = (override as Record<string, unknown>).pattern;
      if (typeof pat !== 'string') {
        return `overrides[${JSON.stringify(sheetName)}][${JSON.stringify(header)}].pattern: must be a string`;
      }
      if (!NON_PATTERN_OVERRIDES.has(pat) && !isPatternName(pat)) {
        return `overrides[${JSON.stringify(sheetName)}][${JSON.stringify(header)}].pattern: invalid value '${pat}' (expected PatternName | 'skip' | 'regex' | 'custom')`;
      }
      // Custom-label overrides (#39) must carry a valid label that normalizes
      // into a legal token-type identifier. Reject malformed labels at the
      // boundary so the scrubber never sees an unsafe token type.
      if (pat === 'custom') {
        const rawLabel = (override as Record<string, unknown>).label;
        if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
          return `overrides[${JSON.stringify(sheetName)}][${JSON.stringify(header)}].label: required when pattern is 'custom'`;
        }
        const norm = normalizeCustomLabel(rawLabel);
        if (!norm) {
          return `overrides[${JSON.stringify(sheetName)}][${JSON.stringify(header)}].label: must normalize to 2-24 chars, start with a letter, [A-Z0-9_] only`;
        }
      }
    }
  }
  return null;
}

/**
 * POST /api/files/xlsx/commit — finalize a staged upload.
 *
 * Body: { uploadId: string, overrides?: CommitOverrides }
 * Returns: { ok, fileName, summary, base64 } on success.
 */
filesXlsxRoute.post('/commit', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json({ ok: false, error: 'invalid json body' }, 400);
  }
  const body = raw as Record<string, unknown>;

  const uploadId = body.uploadId;
  if (typeof uploadId !== 'string' || uploadId.length === 0) {
    return c.json({ ok: false, error: "missing 'uploadId'" }, 400);
  }

  const overrideErr = validateOverridesShape(body.overrides);
  if (overrideErr) {
    return c.json({ ok: false, error: overrideErr }, 400);
  }
  const overrides = body.overrides as CommitOverrides | undefined;

  const staged = getUpload(uploadId);
  if (!staged) {
    return c.json({ ok: false, error: 'upload not found or expired' }, 404);
  }

  const cfg = loadConfig();
  const map = getMap();
  const vocab = getVocab();

  let result;
  try {
    result = await scrubXlsx(
      staged.buffer,
      map,
      vocab,
      {
        xlsx: cfg.xlsx ?? { columnRules: [], autoDetect: true },
        baseConfig: cfg,
      },
      overrides,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `failed to scrub xlsx: ${msg}` }, 500);
  }

  // Privacy: drop the staged buffer the instant we've successfully produced a
  // scrubbed copy. The frontend has the bytes; we no longer need the original.
  dropUpload(uploadId);

  const scrubbedName = staged.fileName.replace(/\.xlsx$/i, '.scrubbed.xlsx');
  return c.json(
    {
      ok: true,
      fileName: scrubbedName,
      summary: result.summary,
      base64: result.scrubbedBuffer.toString('base64'),
    },
    200,
  );
});
