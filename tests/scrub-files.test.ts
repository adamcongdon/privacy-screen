/**
 * Drag-and-drop file scrubbing — regression coverage.
 *
 * The Flow UX redesign deleted Composer.tsx (which hosted FileDropZone) and the
 * replacement flow/ScrubSend.tsx shipped with NO file handling — so users lost
 * the ability to drop/upload .txt/.csv/.xlsx files. No test asserted the drop
 * zone was mounted, so the feature vanished while the suite stayed green. These
 * tests pin both the store wiring (addFiles → files/buildPayload, xlsx review)
 * and the fact that ScrubSend actually mounts FileDropZone.
 *
 * Store-level tests follow the happy-dom + bun:test + fetch-spy pattern from
 * tests/flow-redesign.test.ts.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { useStore } from '../web/src/store';

let originalFetch: typeof fetch;

function spyFetch(responder: (url: string) => unknown): Array<{ url: string }> {
  const calls: Array<{ url: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url });
    return new Response(JSON.stringify(responder(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const SCRUB_RESPONSE = {
  scrubbed: '',
  tokens: [],
  unsureSpans: [],
  hasCredentials: false,
  credentialSnippets: [],
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Reset the singleton store's file-related surface between tests.
  useStore.setState({
    files: [],
    composerText: '',
    pendingXlsx: null,
    isUploading: false,
    tokenUnion: new Map(),
    toasts: [],
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState({ files: [], composerText: '', pendingXlsx: null, isUploading: false });
});

test('addFiles ingests a text file → chip added and buildPayload includes its scrubbed content', async () => {
  const calls = spyFetch((url) => {
    if (url.includes('/api/files')) {
      return {
        files: [
          {
            name: 'notes.txt',
            size: 3,
            mime: 'text/plain',
            original: 'bob',
            scrubbed: '{PERSON}',
            tokens: [{ token: '{PERSON}', realValue: 'bob', category: 'person' }],
            hasCredentials: false,
            credentialSnippets: [],
          },
        ],
      };
    }
    return SCRUB_RESPONSE; // /api/scrub fired by addFiles (fire-and-forget)
  });

  const file = new File(['bob'], 'notes.txt', { type: 'text/plain' });
  await useStore.getState().addFiles([file]);

  const { files, buildPayload } = useStore.getState();
  expect(files.length).toBe(1);
  expect(files[0]!.name).toBe('notes.txt');
  expect(files[0]!.scrubbed).toBe('{PERSON}');
  // The scrubbed file content must be folded into the send/scrub payload.
  expect(buildPayload()).toContain('{PERSON}');
  expect(buildPayload()).toContain('notes.txt');
  // The upload actually hit the server.
  expect(calls.some((c) => c.url.includes('/api/files'))).toBe(true);
});

test('buildPayload mirrors the Send-enabled predicate (files-only enables; errored-only does not)', () => {
  // A scrubbed file with no composer text ⇒ payload non-empty ⇒ Send enabled.
  useStore.setState({
    composerText: '',
    files: [
      { id: 'a', name: 'a.txt', size: 1, mime: 'text/plain', scrubbed: '{EMAIL}' },
    ],
  });
  expect(useStore.getState().buildPayload().trim().length).toBeGreaterThan(0);
  // The exact predicate ScrubSend uses for `empty`.
  const filesA = useStore.getState().files;
  expect(filesA.every((f) => f.error || !f.scrubbed)).toBe(false); // ⇒ not empty

  // An errored-only attachment with no composer text ⇒ payload empty ⇒ Send disabled.
  useStore.setState({
    composerText: '',
    files: [{ id: 'b', name: 'b.txt', size: 1, mime: 'text/plain', error: 'too big' }],
  });
  expect(useStore.getState().buildPayload().trim().length).toBe(0);
  const filesB = useStore.getState().files;
  expect(filesB.every((f) => f.error || !f.scrubbed)).toBe(true); // ⇒ empty
});

test('addFiles with an xlsx-inspection response opens the column-review (pendingXlsx set)', async () => {
  spyFetch((url) => {
    if (url.includes('/api/files')) {
      return {
        files: [
          {
            kind: 'xlsx-inspection',
            uploadId: 'upl-1',
            name: 'book.xlsx',
            size: 2048,
            sheets: [{ name: 'Sheet1', columns: [] }],
          },
        ],
      };
    }
    return SCRUB_RESPONSE;
  });

  const xlsx = new File(['xlsxbytes'], 'book.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await useStore.getState().addFiles([xlsx]);

  const pending = useStore.getState().pendingXlsx;
  expect(pending).not.toBeNull();
  expect(pending!.fileName).toBe('book.xlsx');
  expect(pending!.uploadId).toBe('upl-1');
});

test('ScrubSend mounts FileDropZone (regression guard for the dropped feature)', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'web', 'src', 'components', 'flow', 'ScrubSend.tsx'),
    'utf-8',
  );
  expect(src).toContain("import { FileDropZone } from '../FileDropZone'");
  expect(src).toContain('<FileDropZone');
});
