/**
 * POST /api/files — multipart file upload + scrub.
 *
 * M1: supports text-like files (.txt .md .log .json .csv .yaml .yml .conf .env-like).
 * M2 (#23): supports .xlsx via the two-step inspect→commit flow.
 * #35: .csv (and .xlsx) now use the column-aware scrub path so operators get
 * the option to ignore an entire column or parse column items individually
 * (instead of per-item review). Both return the same `kind: 'xlsx-inspection'`
 * shape (the UI and commit endpoint are reused; the "xlsx" label is historical).
 * A multipart POST containing a mix returns heterogeneous `files` array.
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

function isCsvLike(name: string, mime: string): boolean {
  return /\.csv$/i.test(name) || mime === 'text/csv';
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

    // Columnar dispatch (#23 + #35): .xlsx and .csv now share the column-aware
    // inspect + commit flow. This gives CSV the "ignore entire column" /
    // "parse column items individually" options (via skip vs regex in the
    // per-column dropdown) instead of opaque whole-file scrubText().
    // We reuse the exact same inspection shape + /api/files/xlsx/commit so the
    // existing XlsxColumnReview UI lights up for CSV uploads with zero web changes.
    const isColumnar = isXlsxLike(name, mime) || isCsvLike(name, mime);
    if (isColumnar) {
      const ab = await entry.arrayBuffer();
      const buffer = Buffer.from(ab);
      try {
        // #35: pass the persisted xlsx config so previously committed column
        // rules auto-resolve here (source='rule') and the "remembered" badge
        // shows on this upload. POST /api/files is the path the web UI actually
        // uses for uploads, so without this the remembered policy would be
        // invisible on re-upload even though the rule is persisted.
        // loadConfig() always populates cfg.xlsx from DEFAULTS, and inspectXlsx
        // defaults a missing config to { columnRules: [], autoDetect: true }.
        const inspection = await inspectXlsx(buffer, cfg.xlsx, name);
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
        const label = isCsvLike(name, mime) ? 'csv' : 'xlsx';
        results.push({ name, size, mime, error: `failed to parse ${label}: ${msg}` });
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
