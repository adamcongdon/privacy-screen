/**
 * PDF text extraction for the file-upload scrub pipeline (#185).
 *
 * Wraps unpdf (a serverless pdf.js build — fully local, no workers, no
 * network) so callers never touch pdf.js directly. Extraction happens
 * entirely in memory; the bytes are never written to disk.
 *
 * Scanned/image-only PDFs have no text layer and yield an empty string —
 * callers must treat that as "nothing to scrub" and surface an error
 * rather than returning an empty success.
 */

import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfTextResult {
  /** Full extracted text, pages merged in document order. */
  text: string;
  /** Page count of the source document. */
  pages: number;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}
