/**
 * Update apply UI — regression coverage.
 *
 * The Flow redesign's UpdatesCard rendered only a "Download" button and never
 * surfaced what happens after: the staged-and-verified "ready to install" state.
 * Symptom: the binary downloads (traffic + bytes), the backend reports
 * `readyToApply: true`, but the UX never offers Install & restart.
 *
 * These pin the store contract (applyUpdate → POST /api/update/apply;
 * refreshUpdateStatus → store.updateStatus) plus a static guard that SettingsPage
 * actually renders the download-progress / ready-to-install / apply affordances.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { useStore } from '../web/src/store';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  useStore.setState({ updateStatus: null, toasts: [] });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState({ updateStatus: null });
});

test('refreshUpdateStatus stores readyToApply from /api/update/status', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toContain('/api/update/status');
    return new Response(
      JSON.stringify({
        currentVersion: '0.0.1',
        platform: 'darwin-arm64',
        updateAvailable: true,
        updateInfo: null,
        download: {
          active: false,
          version: '1.0.0-beta.13',
          channel: 'beta',
          bytesDownloaded: 100,
          totalBytes: 100,
          startedAt: 1,
          finishedAt: 2,
          error: null,
          stagedPath: '/Users/x/.privacy-screen/updates/pending-darwin-arm64',
          sha256: 'abc',
        },
        readyToApply: true,
        currentExePath: '/Applications/privacy-screen.app/Contents/MacOS/privacy-screen-bin',
        canAutoApply: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  await useStore.getState().refreshUpdateStatus();
  const st = useStore.getState().updateStatus;
  expect(st?.readyToApply).toBe(true);
  expect(st?.canAutoApply).toBe(true);
  expect(st?.download.active).toBe(false);
});

test('applyUpdate POSTs /api/update/apply', async () => {
  let hit = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    hit = (typeof input === 'string' ? input : input.toString()) + ' ' + (init?.method ?? 'GET');
    return new Response(JSON.stringify({ ok: true, restarting: true, message: 'Restarting…' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await useStore.getState().applyUpdate();
  expect(hit).toContain('/api/update/apply');
  expect(hit).toContain('POST');
});

test('UpdatesCard renders the download→ready→apply affordances (mount guard)', () => {
  const src = readFileSync(
    join(import.meta.dir, '..', 'web', 'src', 'components', 'flow', 'SettingsPage.tsx'),
    'utf-8',
  );
  // Reads the live status + apply action (was missing entirely after the redesign).
  expect(src).toContain('updateStatus');
  expect(src).toContain('applyUpdate');
  expect(src).toContain('readyToApply');
  // Renders the three states.
  expect(src).toContain('Install &amp; restart');
  expect(src).toMatch(/Downloading/);
});
