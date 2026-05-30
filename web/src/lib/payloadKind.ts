import type { FileChip } from '../store';

export type PayloadKind = 'html-dominant' | 'mixed' | 'text';

const HTML_EXT_RE = /\.(html?|htm)$/i;

function isHtmlFile(f: FileChip): boolean {
  return !f.error && (HTML_EXT_RE.test(f.name) || f.mime.startsWith('text/html'));
}

export function getPayloadKind(args: {
  composerText: string;
  files: FileChip[];
}): PayloadKind {
  const { composerText, files } = args;
  const valid = files.filter((f) => !f.error);
  const htmlFiles = valid.filter(isHtmlFile);
  const composerEmpty = composerText.trim().length === 0;

  if (composerEmpty && valid.length === 1 && htmlFiles.length === 1) return 'html-dominant';
  if (htmlFiles.length > 0) return 'mixed';
  return 'text';
}

export function pickPrimaryHtmlFile(files: FileChip[]): FileChip | null {
  return files.find((f) => !f.error && isHtmlFile(f)) ?? null;
}
