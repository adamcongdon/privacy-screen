/**
 * HTML rendered-preview toggle — regression coverage.
 *
 * The Flow UX redesign left `HtmlRenderedView.tsx` complete but imported
 * NOWHERE: the new flow/ScrubSend.tsx rendered only the tokenized source
 * preview, so the source/rendered toggle and the rendered HTML iframe became
 * unreachable while the store still carried `previewMode` + the auto-default
 * wiring in App.tsx. No test asserted the toggle was mounted, so the feature
 * vanished while the suite stayed green. These tests pin both the store wiring
 * (setPreviewMode override + autoSetPreviewMode payload-kind default) and the
 * fact that ScrubSend actually mounts the toggle + HtmlRenderedView.
 *
 * Store-level tests follow the happy-dom + bun:test pattern from
 * tests/flow-redesign.test.ts and tests/scrub-files.test.ts.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { useStore } from '../web/src/store';
import { getPayloadKind } from '../web/src/lib/payloadKind';
import type { FileChip } from '../web/src/store';

beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
  } catch {
    /* ignore */
  }
  // Reset the singleton store's preview-mode surface between tests.
  useStore.setState({
    previewMode: 'source',
    previewModeUserOverrode: false,
    composerText: '',
    files: [],
  });
});

afterEach(() => {
  useStore.setState({
    previewMode: 'source',
    previewModeUserOverrode: false,
    composerText: '',
    files: [],
  });
});

// ── store: setPreviewMode toggles previewMode (and records the user override) ──
test('setPreviewMode flips store.previewMode and marks it user-overridden', () => {
  expect(useStore.getState().previewMode).toBe('source');
  expect(useStore.getState().previewModeUserOverrode).toBe(false);

  useStore.getState().setPreviewMode('rendered');
  expect(useStore.getState().previewMode).toBe('rendered');
  expect(useStore.getState().previewModeUserOverrode).toBe(true);

  useStore.getState().setPreviewMode('source');
  expect(useStore.getState().previewMode).toBe('source');
  expect(useStore.getState().previewModeUserOverrode).toBe(true);
});

// ── store: autoSetPreviewMode honors the payload kind (App.tsx default path) ───
test('autoSetPreviewMode picks rendered for an html-dominant payload', () => {
  const files: FileChip[] = [
    { id: 'h', name: 'page.html', size: 10, mime: 'text/html', scrubbed: '<p>{EMAIL}</p>' },
  ];
  const kind = getPayloadKind({ composerText: '', files });
  expect(kind).toBe('html-dominant');

  // Mirror App.tsx: auto-default rendered iff html-dominant, else source.
  useStore.getState().autoSetPreviewMode(kind === 'html-dominant' ? 'rendered' : 'source');
  expect(useStore.getState().previewMode).toBe('rendered');
});

test('autoSetPreviewMode picks source for a text payload', () => {
  const kind = getPayloadKind({ composerText: 'just some text', files: [] });
  expect(kind).toBe('text');

  useStore.getState().autoSetPreviewMode(kind === 'html-dominant' ? 'rendered' : 'source');
  expect(useStore.getState().previewMode).toBe('source');
});

test('autoSetPreviewMode does NOT override an explicit user pick', () => {
  // User explicitly chose source…
  useStore.getState().setPreviewMode('source');
  expect(useStore.getState().previewModeUserOverrode).toBe(true);

  // …an html-dominant payload arriving must NOT yank it back to rendered.
  useStore.getState().autoSetPreviewMode('rendered');
  expect(useStore.getState().previewMode).toBe('source');
});

// ── static mount-guard: the toggle + rendered view can't silently vanish again ─
test('ScrubSend mounts HtmlRenderedView + a previewMode toggle (regression guard)', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'web', 'src', 'components', 'flow', 'ScrubSend.tsx'),
    'utf-8',
  );
  // Imports + renders the rendered-HTML view.
  expect(src).toContain("import { HtmlRenderedView } from '../HtmlRenderedView'");
  expect(src).toContain('<HtmlRenderedView');
  // Wires the source/rendered toggle to the store.
  expect(src).toContain('previewMode');
  expect(src).toContain('setPreviewMode');
  // Carries both toggle options.
  expect(src).toContain("'rendered'");
  expect(src).toContain("'source'");
});
