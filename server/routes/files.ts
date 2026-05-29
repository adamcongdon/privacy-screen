/**
 * POST /api/files — multipart file upload + scrub.
 *
 * M1: supports text-like files (.txt .md .log .json .csv .yaml .yml .conf .env-like).
 * Body: multipart/form-data with one or more `file` fields.
 * Returns: array of { name, size, mime, scrubbed, tokens, hasCredentials }
 *
 * The raw upload is never persisted — extraction and scrubbing happen in memory.
 * Larger binary formats (.pdf .docx .xlsx) deferred to M2-app.
 */

import { Hono } from 'hono';
import { scrubText } from '../../src/scrubber';
import { getMap, getVocab } from '../lib/vocab-store';
import { loadConfig } from '../../src/config';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.log', '.json', '.csv', '.yaml', '.yml',
  '.conf', '.config', '.env', '.ini', '.toml', '.xml', '.html', '.htm',
  '.tsv', '.sql', '.sh', '.bash', '.zsh',
]);

function isTextLike(name: string, mime: string): boolean {
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  return TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json';
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
    if (!isTextLike(name, mime)) {
      results.push({
        name,
        size,
        mime,
        error: 'binary file types deferred to M2-app (.pdf .docx .xlsx not yet supported)',
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
