/**
 * Tests for POST /api/files/pdf/render — the "download a scrubbed copy" export
 * for PDFs (#185 follow-up).
 *
 * The endpoint rebuilds a clean PDF from already-scrubbed text. Two invariants
 * under test:
 *   1. Defense in depth — even if a caller sends RAW PII, the server re-scrubs
 *      before rendering, so the emitted PDF never carries real values.
 *   2. BLOCK-ALWAYS on credentials — a secret in the text refuses the render
 *      outright (400), matching the xlsx commit policy.
 *
 * Everything is in memory; nothing hits disk (matching the route contract).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { filesRoute } from '../server/routes/files';
import { resetVocab } from '../server/lib/vocab-store';
import { extractPdfText } from '../src/pdf-text';

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-pdf-render-'));
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

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api/files', filesRoute);
  return app;
}

function renderRequest(body: unknown): Request {
  return new Request('http://localhost/api/files/pdf/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type RenderOk = { ok: true; fileName: string; base64: string };

describe('POST /api/files/pdf/render (#185 export)', () => {
  test('renders a valid, scrubbed PDF and names it *.scrubbed.pdf', async () => {
    const res = await makeApp().request(
      renderRequest({
        text: 'Report body with a token {EMAIL_1} and plain prose.',
        fileName: 'handoff.pdf',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RenderOk;
    expect(body.ok).toBe(true);
    expect(body.fileName).toBe('handoff.scrubbed.pdf');

    const bytes = new Uint8Array(Buffer.from(body.base64, 'base64'));
    // Valid PDF signature.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const { text } = await extractPdfText(bytes);
    expect(text).toContain('{EMAIL_1}');
  });

  test('defensively re-scrubs raw PII before rendering (no leak in output)', async () => {
    const EMAIL = 'jane.smith@acme-corp.com';
    const res = await makeApp().request(
      renderRequest({ text: `Contact ${EMAIL} for the migration.`, fileName: 'x.pdf' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RenderOk;

    const bytes = new Uint8Array(Buffer.from(body.base64, 'base64'));
    const { text } = await extractPdfText(bytes);
    expect(text).not.toContain(EMAIL);
    expect(/\{[A-Z]/.test(text)).toBe(true); // at least one token present
  });

  test('BLOCK-ALWAYS: refuses to render when a credential is present', async () => {
    const res = await makeApp().request(
      renderRequest({
        text: 'key: sk-ant-api03-THISISACANARYKEYVALUE1234567890ABCDEF-padding',
        fileName: 'secret.pdf',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('credential');
  });

  test('rejects an empty/missing text body', async () => {
    const res = await makeApp().request(renderRequest({ fileName: 'x.pdf' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});
