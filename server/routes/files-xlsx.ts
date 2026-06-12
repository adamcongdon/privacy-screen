/**
 * /api/files/xlsx — direct endpoints for the two-step columnar flow (#23 + #35).
 *
 * The path name is historical ("xlsx") but the endpoints now serve both .xlsx
 * *and* .csv uploads. This is the "xlsx or csv scrub path" that delivers the
 * per-column ignore / allow / individual options for CSV parsing.
 *
 * Two endpoints:
 *
 *   POST /inspect — multipart upload. Accepts .xlsx or .csv, parses via
 *     `inspectXlsx` (which now branches on ext for load), stages bytes, returns
 *     inspection + uploadId.
 *
 *   POST /commit  — JSON body `{ uploadId, overrides? }`. ... runs `scrubXlsx`
 *     (which writes back in the original format), returns base64 + scrubbedName
 *     (e.g. records.scrubbed.csv).
 *
 * `POST /api/files` dispatch (see files.ts) funnels csv/xlsx here for staging.
 * Same privacy contract: raw bytes never hit disk; dropped right after commit.
 *
 * #35 persistence: when a commit carries per-column overrides, we persist them
 * as `xlsx.columnRules` header rules in PRIVACY_CONFIG.yaml so the next upload
 * with the same headers auto-resolves without the user re-choosing. The merge
 * is last-write-wins keyed on the lowercased header. Persistence failures never
 * block the scrubbed bytes — the file the user asked for always wins.
 */

import { Hono } from 'hono';
import {
  inspectXlsx,
  scrubXlsx,
  normalizeCustomLabel,
  type CommitOverrides,
} from '../../src/xlsx-scrubber';
import { isPatternName } from '../../src/xlsx-types';
import type { ColumnPatternRule } from '../../src/xlsx-types';
import { loadConfig } from '../../src/config';
import { patchXlsxColumnRules } from '../lib/config-writer';
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
  const isXlsx = /\.xlsx$/i.test(name);
  const isCsv = /\.csv$/i.test(name);
  if (!isXlsx && !isCsv) {
    return c.json(
      { ok: false, error: `expected .xlsx or .csv extension, got '${name}'` },
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

  // #35: load the persisted xlsx config so previously committed column rules
  // auto-resolve on this upload (source='rule'). Without this the inspect step
  // would always fall back to heuristics and the "remembered" policy would be
  // invisible until commit. Defaults to {columnRules:[], autoDetect:true} when
  // the config has no xlsx block.
  const cfg = loadConfig();

  let inspection;
  try {
    inspection = await inspectXlsx(
      buffer,
      cfg.xlsx ?? { columnRules: [], autoDetect: true },
      name,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = isCsv ? 'csv' : 'xlsx';
    return c.json({ ok: false, error: `failed to parse ${label}: ${msg}` }, 400);
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
 * Persist the committed column overrides as `xlsx.columnRules` header rules.
 *
 * Merge policy (last-write-wins, #35 ISC-3): build a map keyed on the
 * lowercased header from this commit's overrides; the final override for a
 * given header within the commit wins. Then start from the existing rule list,
 * drop every header rule whose header collides with a new key (case-insensitive),
 * keep all `headerRegex` rules untouched, and append the new header rules.
 *
 * Persistence failures are swallowed and logged: producing the scrubbed bytes
 * the user asked for must never be blocked by a config-write hiccup.
 */
function persistColumnOverrides(
  overrides: CommitOverrides,
  existingRules: readonly ColumnPatternRule[],
): void {
  try {
    // Build new rules from committed overrides. Key on lowercase header for
    // dedup; last override for a header (across all sheets) wins within this commit.
    const newRulesMap = new Map<string, ColumnPatternRule>();
    for (const [, perSheet] of Object.entries(overrides)) {
      for (const [header, override] of Object.entries(perSheet)) {
        if (!header) continue;
        const key = header.toLowerCase();
        if (isPatternName(override.pattern)) {
          newRulesMap.set(key, { header, pattern: override.pattern });
        } else if (override.pattern === 'skip') {
          newRulesMap.set(key, { header, action: 'skip' });
        } else if (override.pattern === 'regex') {
          newRulesMap.set(key, { header, action: 'regex' });
        } else if (override.pattern === 'custom') {
          const label = normalizeCustomLabel(override.label ?? '');
          if (label) {
            newRulesMap.set(key, { header, action: 'custom', label });
          }
        }
      }
    }

    if (newRulesMap.size === 0) return;

    // Merge: keep headerRegex rules and any header rule that doesn't collide
    // with a new key; then append the new header rules.
    const merged: ColumnPatternRule[] = [
      ...existingRules.filter(
        (r) =>
          r.headerRegex !== undefined ||
          !r.header ||
          !newRulesMap.has(r.header.toLowerCase()),
      ),
      ...Array.from(newRulesMap.values()),
    ];
    patchXlsxColumnRules(merged);
  } catch (err) {
    // Persistence failure must NOT block the scrubbed bytes.
    console.error('[files-xlsx] failed to persist column rules:', err);
  }
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
      staged.fileName,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `failed to scrub: ${msg}` }, 500);
  }

  // SCR-05 (#58): BLOCK-ALWAYS on credentials. If the workbook contained a
  // credential, refuse to return the scrubbed buffer at all — the operator must
  // remove the secret from the source, exactly like the text/tool paths. This
  // returns early, so a credential commit never persists a column policy below.
  if (result.summary.hasCredentials) {
    dropUpload(uploadId);
    return c.json(
      {
        ok: false,
        error: 'credential detected',
        credentialSnippets: result.summary.credentialSnippets,
        message:
          'A credential was detected in the workbook. Remove it from the source file before scrubbing.',
      },
      400,
    );
  }

  // ── ISC-1/2/3: Persist column overrides as header rules ──────────────────
  // Done after a successful scrub so we never persist a policy for a commit
  // that failed to produce bytes. Merge against the freshly-loaded config.
  if (overrides && Object.keys(overrides).length > 0) {
    persistColumnOverrides(overrides, cfg.xlsx?.columnRules ?? []);
  }

  // ── ISC-4: Audit skip passthroughs ───────────────────────────────────────
  // Log a redaction_log entry for every column committed as skip, so the audit
  // trail records that PII was intentionally passed through untouched.
  try {
    if (overrides) {
      for (const [sheetName, perSheet] of Object.entries(overrides)) {
        for (const [header, override] of Object.entries(perSheet)) {
          if (override.pattern === 'skip' && header) {
            vocab.logRedaction(
              null,
              `xlsx:skip-passthrough ${sheetName}::${header}`,
              0,
              0,
              false,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('[files-xlsx] failed to log skip audit:', err);
  }

  // Privacy: drop the staged buffer the instant we've successfully produced a
  // scrubbed copy. The frontend has the bytes; we no longer need the original.
  dropUpload(uploadId);

  const isCsvOut = /\.csv$/i.test(staged.fileName);
  const scrubbedName = staged.fileName.replace(/\.(xlsx|csv)$/i, `.scrubbed.${isCsvOut ? 'csv' : 'xlsx'}`);
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
