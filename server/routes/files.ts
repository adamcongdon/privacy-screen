/**
 * POST /api/files — multipart file upload + scrub.
 *
 * M1: supports text-like files (.txt .md .log .json .csv .yaml .yml .conf .env-like).
 * M2 (#23): supports .xlsx via the two-step inspect→commit flow. A multipart
 * POST containing a mix of text and .xlsx files returns a heterogeneous
 * `files` array — text entries carry the legacy `{name, size, mime, original,
 * scrubbed, tokens, ...}` shape; xlsx entries carry
 * `{name, size, mime, kind: 'xlsx-inspection', uploadId, sheets}`. The
 * frontend discriminates on `kind`. After inspection, the client follows up
 * with POST /api/files/xlsx/commit (see `server/routes/files-xlsx.ts`).
 *
 * Body: multipart/form-data with one or more `file` fields.
 *
 * The raw upload is never persisted — text extraction + scrubbing happen in
 * memory, and xlsx bytes are staged in `server/lib/xlsx-uploads.ts` (also
 * in-memory, lazy-pruned at 10 minutes). Other binary formats (.pdf .docx,
 * etc.) still return the deferred-to-M2 error.
 */

import { Hono } from 'hono';
import { scrubText } from '../../src/scrubber';
import { getMap, getVocab } from '../lib/vocab-store';
import { loadConfig } from '../../src/config';
import { inspectXlsx } from '../../src/xlsx-scrubber';
import { stageUpload } from '../lib/xlsx-uploads';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.log', '.json', '.csv', '.yaml', '.yml',
  '.conf', '.config', '.env', '.ini', '.toml', '.xml', '.html', '.htm',
  '.tsv', '.sql', '.sh', '.bash', '.zsh',
]);

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isTextLike(name: string, mime: string): boolean {
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  return TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json';
}

/**
 * True iff the upload looks like an .xlsx by extension OR OOXML mime type.
 * Extension check is case-insensitive — Mac uploads often arrive as `.XLSX`.
 */
function isXlsxLike(name: string, mime: string): boolean {
  return /\.xlsx$/i.test(name) || mime === XLSX_MIME;
}

export const filesRoute = new Hono();

filesRoute.post('/', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  const cfg = loadConfig();
  const map = getMap();
  const vocab = getVocab();
  const results: unknown[] = [];

  for (const entry of form.getAll('file')) {
    if (!(entry instanceof File)) continue;
    const name = entry.name || 'unnamed';
    const mime = entry.type || 'application/octet-stream';
    const size = entry.size;

    if (size > MAX_FILE_BYTES) {
      results.push({ name, size, mime, error: `exceeds ${MAX_FILE_BYTES}B` });
      continue;
    }

    // .xlsx dispatch — Segment 3C2 (#23). Stage the bytes + return the
    // inspection payload so the frontend can show the column-override UI.
    // No scrubbing happens here; the client follows up with POST
    // /api/files/xlsx/commit using the returned uploadId.
    if (isXlsxLike(name, mime)) {
      const ab = await entry.arrayBuffer();
      const buffer = Buffer.from(ab);
      try {
        const inspection = await inspectXlsx(buffer);
        const staged = stageUpload(buffer, name);
        results.push({
          name,
          size,
          mime,
          kind: 'xlsx-inspection' as const,
          uploadId: staged.uploadId,
          sheets: inspection.sheets,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ name, size, mime, error: `failed to parse xlsx: ${msg}` });
      }
      continue;
    }

    if (!isTextLike(name, mime)) {
      results.push({
        name,
        size,
        mime,
        error: 'binary file types deferred to M2-app (.pdf .docx not yet supported)',
      });
      continue;
    }

    const text = await entry.text();
    const r = scrubText(text, map, vocab, {
      sourceEvent: `app:file:${name}`,
      config: cfg,
    });
    results.push({
      name,
      size,
      mime,
      original: text,
      scrubbed: r.scrubbed,
      tokens: r.mintedTokens.map((t) => ({
        realValue: t.realValue,
        token: t.token,
        isNew: t.isNew,
        category: t.category,
      })),
      hasCredentials: r.hasCredentials,
      credentialSnippets: r.credentialSnippets,
      unsureSpans: r.unsureSpans,
    });
  }

  return c.json({ files: results });
});
