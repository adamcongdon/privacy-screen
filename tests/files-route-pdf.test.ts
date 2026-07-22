/**
 * Tests for the PDF dispatch in server/routes/files.ts (#185).
 *
 * Strategy mirrors files-route-xlsx.test.ts: mount the production filesRoute
 * on an in-memory Hono app and drive it with Request objects. PDF fixtures
 * are built per-test via pdf-lib — no filesystem artefacts, nothing hits
 * disk (matching the route's in-memory privacy contract).
 *
 * Privacy invariant under test: PII drawn into a PDF's text layer never
 * survives into `scrubbed` output.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { filesRoute } from '../server/routes/files';
import { resetVocab } from '../server/lib/vocab-store';

// ── Isolated config (keep the real vocab.db + user config out) ───────────────

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-files-pdf-'));
  const configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  writeFileSync(
    configPath,
    [
      `db_path: ${join(workDir, 'vocab.db')}`,
      `mode: observe`,
      `llm_validate:`,
      `  enabled: false`,
      ``,
    ].join('\n'),
  );
  process.env.PRIVACY_SCREEN_CONFIG = configPath;
  resetVocab();
});

afterAll(() => {
  resetVocab();
  delete process.env.PRIVACY_SCREEN_CONFIG;
  rmSync(workDir, { recursive: true, force: true });
});

// ── Test app ─────────────────────────────────────────────────────────────────

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/files', filesRoute);
  return app;
}

// ── Fixture builders ─────────────────────────────────────────────────────────

/** Build a one-page PDF whose text layer contains the given lines. */
async function buildPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => {
    page.drawText(line, { x: 50, y: 720 - i * 20, size: 12, font });
  });
  return doc.save();
}

/** Build a one-page PDF with no text layer (image-only stand-in). */
async function buildTextlessPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

function uploadRequest(name: string, bytes: Uint8Array | Buffer, type: string): Request {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], name, { type }));
  return new Request('http://localhost/api/files', { method: 'POST', body: form });
}

// ── Tests ────────────────────────────────────────────────────────────────────

const EMAIL = 'jane.smith@acme-corp.com';

type FileRow = {
  name: string;
  error?: string;
  original?: string;
  scrubbed?: string;
  pages?: number;
  tokens?: Array<{ realValue: string; token: string }>;
};

async function postOne(req: Request): Promise<FileRow> {
  const res = await makeApp().request(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: FileRow[] };
  expect(body.files).toHaveLength(1);
  return body.files[0]!;
}

describe('POST /api/files — pdf dispatch (#185)', () => {
  test('scrubs PII out of a PDF text layer', async () => {
    const bytes = await buildPdf([
      `Contact ${EMAIL} for the migration.`,
      'Second page-line without PII.',
    ]);
    const row = await postOne(uploadRequest('handoff.pdf', bytes, 'application/pdf'));

    expect(row.error).toBeUndefined();
    expect(row.pages).toBe(1);
    expect(row.original).toContain(EMAIL);
    expect(row.scrubbed).toBeDefined();
    expect(row.scrubbed!).not.toContain(EMAIL);
    const minted = (row.tokens ?? []).map((t) => t.realValue);
    expect(minted).toContain(EMAIL);
  });

  test('dispatches on extension alone (browser drops often send empty mime)', async () => {
    const bytes = await buildPdf([`Reach ${EMAIL} anytime.`]);
    const row = await postOne(uploadRequest('Report.PDF', bytes, ''));
    expect(row.error).toBeUndefined();
    expect(row.scrubbed).toBeDefined();
    expect(row.scrubbed!).not.toContain(EMAIL);
  });

  test('textless (scanned/image-only) PDF returns an explicit error, not empty success', async () => {
    const bytes = await buildTextlessPdf();
    const row = await postOne(uploadRequest('scan.pdf', bytes, 'application/pdf'));
    expect(row.error).toMatch(/no extractable text/);
    expect(row.scrubbed).toBeUndefined();
  });

  test('garbage bytes named .pdf return a parse error, route never 500s', async () => {
    const junk = Buffer.from('this is definitely not a pdf');
    const row = await postOne(uploadRequest('broken.pdf', junk, 'application/pdf'));
    expect(row.error).toMatch(/failed to parse pdf/);
  });

  test('.docx still gets the deferred-binary error', async () => {
    const junk = Buffer.from('PK\x03\x04 pretend docx');
    const row = await postOne(
      uploadRequest(
        'notes.docx',
        junk,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    );
    expect(row.error).toMatch(/\.docx not yet supported/);
  });
});
