/**
 * Tests for server/routes/files.ts (xlsx dispatch) +
 *           server/routes/files-xlsx.ts (inspect + commit endpoints).
 *
 * Issue #23, Segment 3C2 (server endpoints).
 *
 * Strategy: build the same Hono surface the production server mounts (the
 * /api/files/xlsx sub-route registered BEFORE /api/files, so the matcher
 * resolves the xlsx prefix correctly), then drive it with in-memory
 * Request objects. Workbook fixtures are built per-test via exceljs — no
 * filesystem artefacts.
 *
 * Privacy invariant under test: after a successful commit, the staged buffer
 * is dropped from the in-memory store. The same uploadId returns 404 on a
 * second commit attempt, AND a direct `getUpload` returns null.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { filesRoute } from '../server/routes/files';
import { filesXlsxRoute } from '../server/routes/files-xlsx';
import { _resetForTests as resetUploads, getUpload } from '../server/lib/xlsx-uploads';
import { resetVocab } from '../server/lib/vocab-store';

// ── Isolated config (keep the real vocab.db + user config out) ───────────────

let workDir: string;
let configPath: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-files-xlsx-'));
  dbPath = join(workDir, 'vocab.db');
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  writeFileSync(
    configPath,
    [
      `db_path: ${dbPath}`,
      `mode: observe`,
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
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetUploads();
});

// ── Test app: same mount order as server/server.ts ──────────────────────────

function makeApp(): Hono {
  const app = new Hono();
  // Sub-route MUST come first so /api/files/xlsx/* doesn't fall into the
  // legacy multipart handler at /api/files.
  app.route('/api/files/xlsx', filesXlsxRoute);
  app.route('/api/files', filesRoute);
  return app;
}

// ── Fixture builder ─────────────────────────────────────────────────────────

/**
 * Build a small 2-sheet workbook in memory. Sheet1 mixes auto-detectable
 * columns (Email/Phone) with an unresolved free-text column (Notes). Sheet2
 * has a single contact-info column.
 */
async function buildFixtureXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Sheet1');
  s1.addRow(['Email', 'Phone', 'Notes']);
  s1.addRow(['alfa@invented-domain.test', '(555) 010-4001', 'open ticket']);
  s1.addRow(['bravo@invented-domain.test', '(555) 010-4002', 'in review']);

  const s2 = wb.addWorksheet('Sheet2');
  s2.addRow(['Email']);
  s2.addRow(['charlie@invented-domain.test']);

  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Wrap a Buffer in a Web `File` so FormData accepts it the same way the browser does. */
function bufferToFile(buf: Buffer, name: string, mime = 'application/octet-stream'): File {
  // Use the Web Blob ctor — Bun's File extends Blob and is FormData-compatible.
  return new File([buf as unknown as BlobPart], name, { type: mime });
}

function makeMultipartRequest(url: string, files: File[]): Request {
  const form = new FormData();
  for (const f of files) form.append('file', f);
  return new Request(url, { method: 'POST', body: form });
}

function makeJsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Inspect via /api/files (dispatch path) ──────────────────────────────────

describe('POST /api/files — xlsx dispatch', () => {
  test('returns an xlsx-inspection entry instead of running text scrub', async () => {
    const buf = await buildFixtureXlsx();
    const app = makeApp();
    const file = bufferToFile(
      buf,
      'records.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const res = await app.fetch(makeMultipartRequest('http://127.0.0.1/api/files', [file]));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { files: Array<Record<string, unknown>> };
    expect(j.files).toHaveLength(1);

    const f = j.files[0];
    expect(f.kind).toBe('xlsx-inspection');
    expect(typeof f.uploadId).toBe('string');
    expect((f.uploadId as string).length).toBeGreaterThan(0);
    expect(f.name).toBe('records.xlsx');

    // Sheets shape: array of {name, columns: [...], rowCount}
    const sheets = f.sheets as Array<{
      name: string;
      rowCount: number;
      columns: Array<{ header: string; resolvedPattern: string | null; source: string; sampleValue: string | null }>;
    }>;
    expect(Array.isArray(sheets)).toBe(true);
    expect(sheets.length).toBe(2);
    expect(sheets[0].name).toBe('Sheet1');
    expect(sheets[0].rowCount).toBe(2);
    expect(sheets[0].columns.length).toBe(3);

    const email = sheets[0].columns.find((c) => c.header === 'Email');
    expect(email?.resolvedPattern).toBe('Email');
    expect(email?.source).toBe('heuristic');

    // Text path must still work in the SAME response — confirm we didn't break
    // the legacy contract by adding the dispatcher.
  });

  test('mixed upload: text file + xlsx in one POST returns both shapes', async () => {
    const xlsxBuf = await buildFixtureXlsx();
    const app = makeApp();
    const txt = bufferToFile(Buffer.from('hello world from notes.txt'), 'notes.txt', 'text/plain');
    const xlsx = bufferToFile(xlsxBuf, 'records.xlsx');

    const res = await app.fetch(makeMultipartRequest('http://127.0.0.1/api/files', [txt, xlsx]));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { files: Array<Record<string, unknown>> };
    expect(j.files).toHaveLength(2);

    const textEntry = j.files.find((f) => f.name === 'notes.txt');
    const xlsxEntry = j.files.find((f) => f.name === 'records.xlsx');
    expect(textEntry).toBeDefined();
    expect(xlsxEntry).toBeDefined();

    // Text entry preserves the legacy contract.
    expect(typeof textEntry!.scrubbed).toBe('string');
    expect(textEntry!.kind).toBeUndefined();

    // Xlsx entry uses the discriminator.
    expect(xlsxEntry!.kind).toBe('xlsx-inspection');
    expect(typeof xlsxEntry!.uploadId).toBe('string');
  });
});

// ── Direct /api/files/xlsx/inspect ──────────────────────────────────────────

describe('POST /api/files/xlsx/inspect', () => {
  test('returns top-level kind/uploadId/sheets for a valid xlsx', async () => {
    const buf = await buildFixtureXlsx();
    const app = makeApp();
    const file = bufferToFile(buf, 'records.xlsx');

    const res = await app.fetch(
      makeMultipartRequest('http://127.0.0.1/api/files/xlsx/inspect', [file]),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      kind: string;
      uploadId: string;
      fileName: string;
      size: number;
      sheets: Array<{ name: string }>;
    };
    expect(j.kind).toBe('xlsx-inspection');
    expect(typeof j.uploadId).toBe('string');
    expect(j.fileName).toBe('records.xlsx');
    expect(j.size).toBeGreaterThan(0);
    expect(j.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2']);
  });

  test('returns 400 when the file is not actually an xlsx', async () => {
    const app = makeApp();
    const bogus = bufferToFile(Buffer.from('not an xlsx'), 'corrupt.xlsx');
    const res = await app.fetch(
      makeMultipartRequest('http://127.0.0.1/api/files/xlsx/inspect', [bogus]),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('failed to parse xlsx');
  });

  test('returns 400 when the extension is wrong', async () => {
    const buf = await buildFixtureXlsx();
    const app = makeApp();
    const file = bufferToFile(buf, 'records.csv'); // wrong extension
    const res = await app.fetch(
      makeMultipartRequest('http://127.0.0.1/api/files/xlsx/inspect', [file]),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.error).toContain('.xlsx');
  });

  test("returns 400 when the 'file' field is missing", async () => {
    const app = makeApp();
    const form = new FormData();
    // No `file` field appended.
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/files/xlsx/inspect', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(400);
  });
});

// ── /api/files/xlsx/commit ──────────────────────────────────────────────────

/**
 * Helper — POST to inspect via the multipart dispatcher and return the uploadId.
 * Mirrors how the frontend will drive the flow.
 */
async function uploadAndGetUploadId(app: Hono, name = 'records.xlsx'): Promise<string> {
  const buf = await buildFixtureXlsx();
  const file = bufferToFile(buf, name);
  const res = await app.fetch(
    makeMultipartRequest('http://127.0.0.1/api/files/xlsx/inspect', [file]),
  );
  expect(res.status).toBe(200);
  const j = (await res.json()) as { uploadId: string };
  return j.uploadId;
}

describe('POST /api/files/xlsx/commit — happy path', () => {
  test('scrubs the staged buffer and returns base64 + summary', async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', { uploadId }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      fileName: string;
      summary: {
        sheets: number;
        rows: number;
        cellsScrubbed: number;
        columnsResolved: Record<string, string>;
      };
      base64: string;
    };
    expect(j.ok).toBe(true);
    expect(j.fileName).toBe('records.scrubbed.xlsx');
    expect(j.summary.sheets).toBe(2);
    // Sheet1 has 2 data rows, Sheet2 has 1 data row → 3 total.
    expect(j.summary.rows).toBe(3);
    // Email + Phone columns force-mint; Notes falls back to regex (no PII text → no scrub).
    // We assert the columnsResolved map captures the right labels per column.
    expect(j.summary.columnsResolved['Sheet1::Email']).toBe('Email');
    expect(j.summary.columnsResolved['Sheet1::Phone']).toBe('Phone');
    expect(j.summary.columnsResolved['Sheet1::Notes']).toBe('regex');
    expect(j.summary.columnsResolved['Sheet2::Email']).toBe('Email');

    // base64 decodes to a parseable xlsx
    const out = Buffer.from(j.base64, 'base64');
    expect(out.length).toBeGreaterThan(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out as unknown as ArrayBuffer);
    expect(wb.worksheets.length).toBe(2);
    // Email column cells should now be tokens, not raw addresses
    const s1 = wb.getWorksheet('Sheet1')!;
    const emailB2 = s1.getRow(2).getCell(1).text;
    expect(emailB2.includes('@')).toBe(false);
    expect(emailB2.startsWith('{EMAIL')).toBe(true);
  });
});

describe('POST /api/files/xlsx/commit — with overrides', () => {
  test("user override 'skip' on Sheet1::Notes is honored in summary", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          Sheet1: { Notes: { pattern: 'skip' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      summary: { columnsResolved: Record<string, string> };
    };
    expect(j.ok).toBe(true);
    expect(j.summary.columnsResolved['Sheet1::Notes']).toBe('skip');
  });

  // Issue #39 — custom-label override accepted end-to-end.
  test("custom override on Sheet1::Notes is normalized and applied", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          Sheet1: { Notes: { pattern: 'custom', label: 'ServerName' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      summary: { columnsResolved: Record<string, string> };
    };
    expect(j.ok).toBe(true);
    expect(j.summary.columnsResolved['Sheet1::Notes']).toBe('custom:SERVERNAME');
  });

  test("custom override rejects missing label with 400", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          Sheet1: { Notes: { pattern: 'custom' } },
        },
      }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error.toLowerCase()).toContain('label');
  });

  test("custom override rejects malformed label with 400", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          // label can't start with a digit; normalize would produce '1NAME'
          // which fails the must-start-with-letter rule.
          Sheet1: { Notes: { pattern: 'custom', label: '1' } },
        },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Error / validation paths ────────────────────────────────────────────────

describe('POST /api/files/xlsx/commit — error paths', () => {
  test('returns 404 for an unknown uploadId', async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId: crypto.randomUUID(),
      }),
    );
    expect(res.status).toBe(404);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('not found');
  });

  test('returns 400 when overrides contain a bogus pattern name', async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          Sheet1: { Email: { pattern: 'NotAPattern' } },
        },
      }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error.toLowerCase()).toContain('notapattern');
  });

  test("returns 400 when overrides isn't an object", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);
    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: ['not', 'an', 'object'],
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when override.pattern isn't a string", async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);
    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: { Sheet1: { Email: { pattern: 42 } } },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('returns 400 on missing uploadId', async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {}),
    );
    expect(res.status).toBe(400);
  });

  test('returns 400 on non-object body', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/files/xlsx/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Privacy: staged buffer is dropped after commit ──────────────────────────

describe('staged-buffer lifecycle', () => {
  test('after inspect the buffer is staged; after commit it is gone', async () => {
    const app = makeApp();
    const uploadId = await uploadAndGetUploadId(app);

    // Pre-commit: present
    const before = getUpload(uploadId);
    expect(before).not.toBeNull();
    expect(before!.fileName).toBe('records.xlsx');

    const commitRes = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', { uploadId }),
    );
    expect(commitRes.status).toBe(200);

    // Post-commit: gone
    expect(getUpload(uploadId)).toBeNull();

    // A second commit attempt is a 404 — proves dropUpload happened, not just
    // a soft-tombstone.
    const second = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', { uploadId }),
    );
    expect(second.status).toBe(404);
  });
});

// ── CSV column policy support via the xlsx scrub path (#35) ─────────────────
// TDD: this test is added FIRST to demonstrate the desired behavior (CSV
// uploads should get the per-column ignore/individual UI + scrub options
// instead of being treated as opaque text). It will FAIL (red) until the
// dispatch in files.ts + csv load/write support in xlsx-scrubber.ts +
// relaxed ext handling in files-xlsx.ts are implemented.

async function buildFixtureCsv(): Promise<Buffer> {
  const csv =
    'Email,Phone,Notes\n' +
    'alpha@invented-domain.test,(555) 010-4001,open ticket\n' +
    'bravo@invented-domain.test,(555) 010-4002,in review\n';
  return Buffer.from(csv, 'utf8');
}

describe('CSV column-aware parsing (#35) — TDD red phase', () => {
  test('csv upload via /api/files returns xlsx-inspection (column UI) not text scrub', async () => {
    const buf = await buildFixtureCsv();
    const app = makeApp();
    const file = bufferToFile(buf, 'records.csv', 'text/csv');

    const res = await app.fetch(makeMultipartRequest('http://127.0.0.1/api/files', [file]));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { files: Array<Record<string, unknown>> };
    expect(j.files).toHaveLength(1);

    const f = j.files[0];
    // DESIRED: now gets the column review path so user can ignore/allow whole columns
    expect(f.kind).toBe('xlsx-inspection');
    expect(f.name).toBe('records.csv');
    expect(typeof f.uploadId).toBe('string');

    const sheets = f.sheets as Array<{ name: string; columns: Array<{ header: string }> }>;
    expect(sheets.length).toBe(1);
    expect(sheets[0].columns.map((c) => c.header)).toEqual(['Email', 'Phone', 'Notes']);
  });

  test('csv commit with skip override on Email column leaves raw PII (ignore entire column)', async () => {
    const buf = await buildFixtureCsv();
    const app = makeApp();
    const file = bufferToFile(buf, 'records.csv', 'text/csv');
    const inspectRes = await app.fetch(
      makeMultipartRequest('http://127.0.0.1/api/files', [file]),
    );
    const { uploadId } = (await inspectRes.json()) as { uploadId: string };

    const commitRes = await app.fetch(
      makeJsonRequest('http://127.0.0.1/api/files/xlsx/commit', {
        uploadId,
        overrides: {
          Sheet1: { Email: { pattern: 'skip' } },
        },
      }),
    );
    expect(commitRes.status).toBe(200);
    const j = (await commitRes.json()) as { ok: boolean; fileName: string; base64: string };
    expect(j.ok).toBe(true);
    expect(j.fileName).toBe('records.scrubbed.csv');

    const outCsv = Buffer.from(j.base64, 'base64').toString('utf8');
    // Because we skipped the column, raw email addresses must still be present
    expect(outCsv).toContain('alpha@invented-domain.test');
    expect(outCsv).toContain('bravo@invented-domain.test');
    // Other columns still scrubbed
    expect(outCsv).not.toContain('(555) 010-4001');
  });
});
