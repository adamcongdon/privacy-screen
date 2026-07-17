/**
 * Drag-and-drop file scrubbing — regression coverage for #85.
 *
 * Decision (2026-07-17): keep FileDropZone; verify .txt and .xlsx end-to-end
 * paths; fix only if broken. Do not excise the pipeline.
 *
 * History: Flow redesign deleted Composer.tsx (host of FileDropZone); ScrubSend
 * remounted it. Audit reopened #85 because early tests only grepped source
 * strings. This suite pins:
 *   1. store wiring (addFiles → chips / buildPayload / xlsx pending)
 *   2. ScrubSend + App mount contracts (drop zone + XlsxColumnReview)
 *   3. FileDropZone component DOM (happy-dom render): drop UI + chips after upload
 *   4. Send-empty predicate parity with files-only payloads
 *   5. xlsx commit path clears pending review after successful API mock
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../web/src/store';
import { FileDropZone } from '../web/src/components/FileDropZone';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let originalFetch: typeof fetch;

function spyFetch(responder: (url: string, init?: RequestInit) => unknown): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(responder(url, init)), {
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

function resetFileSurface(): void {
  useStore.setState({
    files: [],
    composerText: '',
    pendingXlsx: null,
    isUploading: false,
    tokenUnion: new Map(),
    toasts: [],
    isJudging: false,
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetFileSurface();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetFileSurface();
});

// ── Store: .txt path ────────────────────────────────────────────────────────

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
    return SCRUB_RESPONSE;
  });

  const file = new File(['bob'], 'notes.txt', { type: 'text/plain' });
  await useStore.getState().addFiles([file]);

  const { files, buildPayload } = useStore.getState();
  expect(files.length).toBe(1);
  expect(files[0]!.name).toBe('notes.txt');
  expect(files[0]!.scrubbed).toBe('{PERSON}');
  // Scrubbed file content must fold into send/scrub payload (no raw PII).
  expect(buildPayload()).toContain('{PERSON}');
  expect(buildPayload()).toContain('notes.txt');
  expect(buildPayload()).not.toContain('bob');
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
  // Exact predicate ScrubSend uses for `empty`.
  const filesA = useStore.getState().files;
  const emptyA =
    !useStore.getState().composerText.trim() && filesA.every((f) => f.error || !f.scrubbed);
  expect(emptyA).toBe(false);

  // Errored-only attachment with no composer text ⇒ payload empty ⇒ Send disabled.
  useStore.setState({
    composerText: '',
    files: [{ id: 'b', name: 'b.txt', size: 1, mime: 'text/plain', error: 'too big' }],
  });
  expect(useStore.getState().buildPayload().trim().length).toBe(0);
  const filesB = useStore.getState().files;
  const emptyB =
    !useStore.getState().composerText.trim() && filesB.every((f) => f.error || !f.scrubbed);
  expect(emptyB).toBe(true);
});

// ── Store: .xlsx path ───────────────────────────────────────────────────────

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
  // Xlsx does not become a send-chip until commit; text path chips stay empty.
  expect(useStore.getState().files.length).toBe(0);
});

test('commitXlsxReview clears pending after successful commit (download path)', async () => {
  useStore.setState({
    pendingXlsx: {
      uploadId: 'upl-commit-1',
      fileName: 'book.xlsx',
      size: 100,
      sheets: [{ name: 'Sheet1', columns: [], rowCount: 1 }],
    },
  });

  const calls = spyFetch((url) => {
    if (url.includes('/api/files/xlsx/commit')) {
      return {
        base64: btoa('fake-xlsx-bytes'),
        fileName: 'book.scrubbed.xlsx',
        summary: { cellsScrubbed: 2, cellsTotal: 4 },
      };
    }
    return SCRUB_RESPONSE;
  });

  await useStore.getState().commitXlsxReview({});
  expect(useStore.getState().pendingXlsx).toBeNull();
  expect(calls.some((c) => c.url.includes('/api/files/xlsx/commit'))).toBe(true);
  // Success toast fired so the path is not silent.
  const toasts = useStore.getState().toasts;
  expect(toasts.some((t) => t.kind === 'success' && /book\.xlsx|cells/i.test(t.message))).toBe(true);
});

// ── Source mount contracts ──────────────────────────────────────────────────

test('ScrubSend mounts FileDropZone (regression guard for the dropped feature)', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'web', 'src', 'components', 'flow', 'ScrubSend.tsx'),
    'utf-8',
  );
  expect(src).toContain("import { FileDropZone } from '../FileDropZone'");
  expect(src).toContain('<FileDropZone');
  // Empty/Send must account for files (not composer-only).
  expect(src).toMatch(/files\.every\(\(f\)\s*=>\s*f\.error\s*\|\|\s*!f\.scrubbed\)/);
});

test('App mounts XlsxColumnReview (xlsx drop → modal surface)', () => {
  const app = readFileSync(join(import.meta.dir, '..', 'web', 'src', 'App.tsx'), 'utf-8');
  expect(app).toContain("import { XlsxColumnReview } from './components/XlsxColumnReview'");
  expect(app).toContain('<XlsxColumnReview');
});

test('FileDropZone accept list includes .txt and .xlsx', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'web', 'src', 'components', 'FileDropZone.tsx'),
    'utf-8',
  );
  expect(src).toMatch(/accept=.*\.txt/);
  expect(src).toMatch(/accept=.*\.xlsx/);
  expect(src).toContain('onDrop');
  expect(src).toContain('addFiles');
});

// ── Component: FileDropZone happy-dom mount ─────────────────────────────────

describe('FileDropZone DOM (#85 E2E-ish)', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test('renders drop/browse affordance with role=button', () => {
    act(() => {
      root.render(React.createElement(FileDropZone));
    });
    const btn = container.querySelector('[role="button"]');
    expect(btn).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toMatch(/drop|browse|files/);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.accept).toContain('.txt');
    expect(input!.accept).toContain('.xlsx');
  });

  test('shows chip list after files land in the store (post-addFiles)', async () => {
    spyFetch((url) => {
      if (url.includes('/api/files')) {
        return {
          files: [
            {
              name: 'notes.txt',
              size: 12,
              mime: 'text/plain',
              original: 'alice@example.test',
              scrubbed: '{EMAIL}',
              tokens: [{ token: '{EMAIL}', realValue: 'alice@example.test', category: 'email' }],
              hasCredentials: false,
              credentialSnippets: [],
            },
          ],
        };
      }
      return SCRUB_RESPONSE;
    });

    act(() => {
      root.render(React.createElement(FileDropZone));
    });

    const file = new File(['alice@example.test'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      await useStore.getState().addFiles([file]);
    });

    // Re-render is automatic via zustand subscription; act + microtask settle.
    await act(async () => {
      await Promise.resolve();
    });

    const text = container.textContent ?? '';
    expect(text).toContain('notes.txt');
    // Scrubbed chip present (success icon path / name); raw email must not appear as chip content.
    expect(text).not.toContain('alice@example.test');
    const remove = container.querySelector('[aria-label="remove notes.txt"]');
    expect(remove).not.toBeNull();
  });

  test('busy upload freezes drop zone (issue #37 guard surface)', () => {
    useStore.setState({ isUploading: true });
    act(() => {
      root.render(React.createElement(FileDropZone));
    });
    const btn = container.querySelector('[role="button"]');
    expect(btn?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent?.toLowerCase()).toMatch(/uploading/);
  });
});
