/**
 * Update control surface (download + apply).
 *
 *   GET  /api/update/status   — current version, last known updateInfo, download progress, readyToApply, etc.
 *   POST /api/update/download — explicit opt-in to fetch the binary for the selected channel.
 *   POST /api/update/apply    — explicit one-click to swap in a verified staged binary and relaunch.
 *
 * All heavy work (fetch, hash, fs ops, spawn) happens server-side. The web UI only drives it.
 * Nothing happens unless the user clicks the buttons (and has update_channel != off).
 */

import { Hono } from 'hono';

import {
  getUpdateStatus,
  startUpdateDownload,
  applyStagedUpdate,
  type UpdateStatus,
  type ApplyStagedUpdateResult,
} from '../lib/update-install';
import { requestShutdown } from '../lib/lifecycle';

export const updateRoute = new Hono();

updateRoute.get('/status', (c) => {
  const status: UpdateStatus = getUpdateStatus();
  return c.json(status);
});

updateRoute.post('/download', async (c) => {
  const result = await startUpdateDownload();
  if ('error' in result) {
    return c.json({ error: result.error }, 409);
  }
  return c.json({ ok: true, status: result.status }, 202);
});

updateRoute.post('/apply', async (c) => {
  const result: ApplyStagedUpdateResult = await applyStagedUpdate();

  if (!result.applied) {
    // Surface the reason clearly; client decides how to message.
    // stagedPath is optional on the failure union — no any-cast needed.
    return c.json(
      {
        ok: false,
        reason: result.reason,
        message: result.message,
        stagedPath: result.stagedPath,
      },
      409,
    );
  }

  // Success: replacement spawned. Respond first, then shared graceful shutdown
  // so LLM + HTTP drain (SRV-07 / #80 — no process.exit in this route).
  const body = {
    ok: true,
    restarting: true,
    message: 'Update applied. The application will now restart.',
    oldPath: result.oldPath,
    newPath: result.newPath,
  };

  const res = c.json(body, 202);
  void requestShutdown(80);
  return res;
});
