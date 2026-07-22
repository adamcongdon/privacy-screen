/**
 * Text → PDF rendering for the "download a scrubbed copy" export (#185 follow-up).
 *
 * The scrub pipeline extracts a PDF's text layer, tokenizes it, and hands the
 * SCRUBBED (already-tokenized) text here to regenerate a clean PDF. We rebuild
 * from text rather than editing the original bytes on purpose: a privacy tool
 * must never ship a redaction where the original glyphs survive underneath an
 * overlay and stay extractable. The trade-off is layout — the output is
 * reflowed plain text (Helvetica 11pt), not a pixel copy of the source — but it
 * is guaranteed to contain only the scrubbed text and nothing else.
 *
 * Everything is in memory; no bytes hit disk.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 48;
const FONT_SIZE = 11;
const LINE_HEIGHT = 15;
const CONTENT_W = PAGE_W - MARGIN * 2;

/**
 * Map text to WinAnsi-encodable characters so pdf-lib's StandardFont (Helvetica)
 * never throws on a glyph it can't encode. Common typographic characters are
 * folded to ASCII equivalents; anything else outside Latin-1 becomes '?'.
 */
function sanitizeForWinAnsi(input: string): string {
  const folds: Record<string, string> = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'",
    '“': '"', '”': '"', '„': '"',
    '–': '-', '—': '-', '−': '-',
    '…': '...', '•': '*', ' ': ' ',
    '‐': '-', '‑': '-', '·': '*',
    '\t': '    ',
  };
  let out = '';
  for (const ch of input) {
    if (folds[ch] !== undefined) { out += folds[ch]; continue; }
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n') { out += ch; continue; }
    if (code >= 0x20 && code <= 0xFF) { out += ch; continue; }
    out += '?';
  }
  return out;
}

/**
 * Greedy word-wrap a single logical line to fit CONTENT_W. A word longer than
 * the content width is hard-broken so it can never overflow the page.
 */
function wrapLine(
  line: string,
  font: import('pdf-lib').PDFFont,
  size: number,
): string[] {
  if (line.length === 0) return [''];
  const words = line.split(/(\s+)/); // keep whitespace runs as tokens
  const rows: string[] = [];
  let cur = '';
  const width = (s: string): number => font.widthOfTextAtSize(s, size);

  const pushHardBroken = (word: string): void => {
    let chunk = '';
    for (const ch of word) {
      if (width(chunk + ch) > CONTENT_W && chunk.length > 0) {
        rows.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    cur = chunk;
  };

  for (const w of words) {
    if (width(cur + w) <= CONTENT_W) {
      cur += w;
      continue;
    }
    // Doesn't fit. Flush the current row first.
    if (cur.trim().length > 0) rows.push(cur.replace(/\s+$/, ''));
    cur = '';
    if (width(w) > CONTENT_W) {
      pushHardBroken(w);
    } else {
      cur = w.replace(/^\s+/, '');
    }
  }
  if (cur.length > 0) rows.push(cur.replace(/\s+$/, ''));
  return rows.length > 0 ? rows : [''];
}

/**
 * Render already-scrubbed text into a clean multi-page PDF.
 * Returns the serialized PDF bytes.
 */
export async function renderTextToPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const safe = sanitizeForWinAnsi(text);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const ink = rgb(0.1, 0.1, 0.12);

  const newPage = (): void => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  for (const logical of safe.split('\n')) {
    const rows = wrapLine(logical, font, FONT_SIZE);
    for (const row of rows) {
      if (y < MARGIN) newPage();
      if (row.length > 0) {
        page.drawText(row, { x: MARGIN, y, size: FONT_SIZE, font, color: ink });
      }
      y -= LINE_HEIGHT;
    }
  }

  return doc.save();
}
