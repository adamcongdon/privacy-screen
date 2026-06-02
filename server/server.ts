/**
 * PrivacyScreen App — local-first server.
 *
 * Listens on 127.0.0.1:31338 only. Hard-coded loopback bind; refuses to start
 * if PRIVACY_SCREEN_BIND_ANY=1 is not explicitly set (and even then warns).
 *
 * Routes:
 *   GET  /                 — serves built web/dist (or a stub during dev)
 *   POST /api/scrub        — preview scrub
 *   POST /api/send         — scrub + relay to Anthropic, SSE response
 *   GET  /api/vocab        — list vocab
 *   POST /api/vocab        — add customer name
 *   DELETE /api/vocab/:v   — forget
 *   POST /api/vocab/allowlist
 *   GET  /api/review       — pending review queue
 *   POST /api/review/:id   — confirm/allowlist/ignore
 *   GET  /api/settings     — public settings view
 *   POST /api/settings     — write settings
 *   POST /api/files        — upload + scrub
 *   GET  /api/health       — { ok: true }
 *   GET  /api/version      — current version + opt-in update check
 *   POST /api/judge        — opt-in LLM secondary validator (out-of-band)
 */

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

import { scrubRoute } from './routes/scrub';
import { sendRoute } from './routes/send';
import { vocabRoute } from './routes/vocab';
import { reviewRoute } from './routes/review';
import { patternsRoute } from './routes/patterns';
import { settingsRoute } from './routes/settings';
import { filesRoute } from './routes/files';
import { versionRoute } from './routes/version';
import { judgeRoute } from './routes/judge';
import { reportClaudeCodeStatus } from './lib/claude-code-check';
import { shutdownLlmProcess } from './lib/llm-process';

const PORT = Number(process.env.PRIVACY_SCREEN_PORT ?? 31338);
const HOST = process.env.PRIVACY_SCREEN_BIND_ANY === '1' ? '0.0.0.0' : '127.0.0.1';

if (HOST !== '127.0.0.1') {
  process.stderr.write(
    `[privacy-screen] ⚠️  Binding to ${HOST}. This exposes the app to the network. ` +
      `Vocab is reachable from any machine on this network. ` +
      `Unset PRIVACY_SCREEN_BIND_ANY=1 unless you know what you're doing.\n`,
  );
}

// Hard gate: claude CLI is required. Refuse to start without it.
reportClaudeCodeStatus();

const app = new Hono();

const HOST_ALLOWLIST = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1`,
  `localhost`,
]);

// Defense in depth: reject requests whose Host header isn't loopback.
// Defeats DNS rebinding against 127.0.0.1:31338 — even if a malicious page
// resolves a name to our loopback IP, the Host header it sends is the
// attacker's domain, not ours. Process-internal calls (Bun.serve→app.fetch
// in tests) carry no Host header; those pass through.
app.use('/api/*', async (c, next) => {
  const host = c.req.header('host');
  if (host && !HOST_ALLOWLIST.has(host)) {
    return c.json({ error: 'forbidden host' }, 403);
  }
  return next();
});

// CORS only allow same-origin in production; the local Vite dev server
// proxies through, so it always presents as the same origin.
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      if (origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`) {
        return origin;
      }
      // Allow the Vite dev server on common ports (5173, 5174)
      if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
        return origin;
      }
      return null;
    },
    credentials: false,
  }),
);

app.get('/api/health', (c) => c.json({ ok: true, version: '1.0.0-app-m1' }));

app.route('/api/scrub', scrubRoute);
app.route('/api/send', sendRoute);
app.route('/api/vocab', vocabRoute);
app.route('/api/review', reviewRoute);
app.route('/api/patterns', patternsRoute);
app.route('/api/settings', settingsRoute);
app.route('/api/files', filesRoute);
app.route('/api/version', versionRoute);
app.route('/api/judge', judgeRoute);

// Static frontend bundle (built via `bun run web:build`).
const webDist = join(import.meta.dir, '..', 'web', 'dist');
if (existsSync(webDist) && statSync(webDist).isDirectory()) {
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('*', serveStatic({ path: './web/dist/index.html' }));
} else {
  app.get('/', (c) =>
    c.text(
      'privacy-screen server is running on the API but the web bundle is not built.\n' +
        'Run `bun run web:build` first, OR run `bun run web:dev` for hot reload.\n' +
        `API: http://${HOST}:${PORT}/api/health\n`,
    ),
  );
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: app.fetch,
});

process.stdout.write(
  `privacy-screen app  →  http://${server.hostname}:${server.port}\n` +
    `  API health:       http://${server.hostname}:${server.port}/api/health\n` +
    `  Web UI:           ${existsSync(webDist) ? 'served from web/dist' : 'run `bun run web:dev`'}\n`,
);

// Graceful shutdown — drain the LLM subprocess (if any) before stopping the HTTP
// server so a SIGINT/SIGTERM doesn't orphan llama-server. Cleanup still ends in
// process.exit(0) so init systems see the expected exit code.
const cleanup = async (): Promise<void> => {
  process.stdout.write('\nshutting down…\n');
  try {
    await shutdownLlmProcess();
  } catch {
    // best effort — never block shutdown on a misbehaving subprocess
  }
  server.stop();
  process.exit(0);
};
process.on('SIGINT', () => { void cleanup(); });
process.on('SIGTERM', () => { void cleanup(); });
