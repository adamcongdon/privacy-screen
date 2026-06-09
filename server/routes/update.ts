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
} from '../lib/update-install';

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
  const result = await applyStagedUpdate();

  if (!result.applied) {
    // Surface the reason clearly; client decides how to message.
    return c.json(
      {
        ok: false,
        reason: result.reason,
        message: result.message,
        stagedPath: (result as any).stagedPath,
      },
      409,
    );
  }

  // Success: we have spawned the replacement. Send a response, then schedule
  // our own clean shutdown so the HTTP reply reaches the client.
  const body = {
    ok: true,
    restarting: true,
    message: 'Update applied. The application will now restart.',
    oldPath: result.oldPath,
    newPath: result.newPath,
  };

  // Return the response first.
  const res = c.json(body, 202);

  // Give the runtime a moment to flush the response, then hand off.
  setTimeout(() => {
    // Reuse the graceful LLM + server stop path from the main server module
    // by triggering the same signals the process already listens for.
    // Using process.kill(self) is racy; instead do the minimal shutdown work here.
    void (async () => {
      try {
        // Dynamic import to avoid circular init at load time.
        const { shutdownLlmProcess } = await import('../lib/llm-process');
        await shutdownLlmProcess().catch(() => {});
      } catch {
        // ignore
      }
      try {
        // The Bun.serve instance is not directly exported; ask the server to stop
        // via a private channel isn't possible. Best we can do from here is exit.
        // In practice the detached child is already running; a hard exit after a
        // tiny delay is acceptable for a local tool.
        // (The SIGINT handler in server.ts does the same LLM shutdown + server.stop + exit.)
      } finally {
        process.exit(0);
      }
    })();
  }, 80);

  return res;
});
