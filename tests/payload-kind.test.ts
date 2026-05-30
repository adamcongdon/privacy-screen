import { describe, expect, test } from 'bun:test';
import { getPayloadKind, pickPrimaryHtmlFile } from '../web/src/lib/payloadKind';
import type { FileChip } from '../web/src/store';

function chip(name: string, mime: string, opts: Partial<FileChip> = {}): FileChip {
  return {
    id: `f-${name}`,
    name,
    size: 100,
    mime,
    scrubbed: '<p>hi</p>',
    ...opts,
  };
}

describe('getPayloadKind', () => {
  test('empty composer + single .html file → html-dominant', () => {
    expect(
      getPayloadKind({
        composerText: '',
        files: [chip('email.html', 'text/html')],
      }),
    ).toBe('html-dominant');
  });

  test('empty composer + single .htm file (no mime) → html-dominant', () => {
    expect(
      getPayloadKind({
        composerText: '',
        files: [chip('legacy.htm', 'application/octet-stream')],
      }),
    ).toBe('html-dominant');
  });

  test('empty composer + single .txt file → text', () => {
    expect(
      getPayloadKind({
        composerText: '',
        files: [chip('notes.txt', 'text/plain')],
      }),
    ).toBe('text');
  });

  test('composer text + .html file → mixed', () => {
    expect(
      getPayloadKind({
        composerText: 'context for the doc',
        files: [chip('email.html', 'text/html')],
      }),
    ).toBe('mixed');
  });

  test('two .html files (no composer) → mixed', () => {
    expect(
      getPayloadKind({
        composerText: '',
        files: [
          chip('a.html', 'text/html'),
          chip('b.html', 'text/html'),
        ],
      }),
    ).toBe('mixed');
  });

  test('errored html file is ignored — empty composer + only-errored-html → text', () => {
    expect(
      getPayloadKind({
        composerText: '',
        files: [chip('broken.html', 'text/html', { error: 'too big' })],
      }),
    ).toBe('text');
  });

  test('composer text only (no files) → text', () => {
    expect(
      getPayloadKind({
        composerText: 'plain prose',
        files: [],
      }),
    ).toBe('text');
  });

  test('whitespace-only composer + single html → html-dominant', () => {
    expect(
      getPayloadKind({
        composerText: '   \n  ',
        files: [chip('a.html', 'text/html')],
      }),
    ).toBe('html-dominant');
  });
});

describe('pickPrimaryHtmlFile', () => {
  test('returns first non-errored html-ish file', () => {
    const a = chip('a.txt', 'text/plain');
    const b = chip('broken.html', 'text/html', { error: 'too big' });
    const c = chip('good.html', 'text/html');
    const d = chip('also.htm', 'application/octet-stream');
    expect(pickPrimaryHtmlFile([a, b, c, d])?.name).toBe('good.html');
  });

  test('returns null when no html files present', () => {
    expect(
      pickPrimaryHtmlFile([chip('a.txt', 'text/plain'), chip('b.json', 'application/json')]),
    ).toBeNull();
  });
});
