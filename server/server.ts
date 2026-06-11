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
 *   GET  /api/update/status
 *   POST /api/update/download — explicit download of a newer binary for the selected channel
 *   POST /api/update/apply    — verified self-replace + detached relaunch (user-initiated)
 *   POST /api/judge        — opt-in LLM secondary validator (out-of-band)
 *   GET  /api/judge-control/status
 *   POST /api/judge-control/enable, /install — GUI controls for the judge
 */

import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import pkg from '../package.json' with { type: 'json' };

import { scrubRoute } from './routes/scrub';
import { sendRoute } from './routes/send';
import { vocabRoute } from './routes/vocab';
import { reviewRoute } from './routes/review';
import { patternsRoute } from './routes/patterns';
import { settingsRoute } from './routes/settings';
import { filesRoute } from './routes/files';
import { filesXlsxRoute } from './routes/files-xlsx';
import { versionRoute } from './routes/version';
import { judgeRoute } from './routes/judge';
import { judgeControlRoute } from './routes/judge-control';
import { updateRoute } from './routes/update';
import { feedbackRoute } from './routes/feedback';
import { reportClaudeCodeStatus } from './lib/claude-code-check';
import { shutdownLlmProcess, getLlmClient } from './lib/llm-process';
import { loadConfig } from '../src/config';
import { embeddedAssets } from './web-assets.generated';
import { openBrowser } from './lib/open-browser';
import { isAllowedOrigin, MUTATING_METHODS } from './lib/origin-policy';

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

// Global error handler: never echo request bodies or internals to clients.
app.onError((err, c) => {
  process.stderr.write('[privacy-screen] onError: ' + ((err as Error)?.message ?? String(err)) + '\n');
  return c.json({ error: 'internal server error' }, 500);
});

const HOST_ALLOWLIST = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1`,
  `localhost`,
]);

// SRV-08 (#81): the Vite dev-server origins (5173/5174) must NOT be admitted
// in a packaged release — otherwise any local process serving on 5173 could
// read API responses (including the full vocab dump of real values)
// cross-origin. Release binaries embed the web bundle (embeddedAssets
// non-empty); a source/dev checkout does not, and PRIVACY_SCREEN_DEV=1 forces
// dev mode. The policy itself lives in ./lib/origin-policy (pure + tested).
const IS_DEV_WEB =
  process.env.PRIVACY_SCREEN_DEV === '1' || embeddedAssets.length === 0;
const originPolicy = { port: PORT, isDevWeb: IS_DEV_WEB };
const allowOrigin = (origin: string): boolean => isAllowedOrigin(origin, originPolicy);

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

// SRV-01 (#74): CSRF / cross-origin write guard. Hono's cors() only withholds
// response headers — it never *rejects* a request, and a text/plain "simple"
// POST sends no preflight, so a drive-by page could POST to 127.0.0.1:31338
// (loopback Host passes the check above) and mutate settings/vocab, trigger
// /api/send, or file feedback. This guard runs BEFORE the route handlers and
// rejects any state-mutating request (POST/PUT/PATCH/DELETE) that carries an
// Origin we don't trust. Same-origin requests and tooling that sends no Origin
// (curl, process-internal app.fetch) are unaffected.
app.use('/api/*', async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && !allowOrigin(origin)) {
      return c.json({ error: 'cross-origin request forbidden' }, 403);
    }
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
      return allowOrigin(origin) ? origin : null;
    },
    credentials: false,
  }),
);

app.get('/api/health', (c) => c.json({ ok: true, version: pkg.version }));

app.route('/api/scrub', scrubRoute);
app.route('/api/send', sendRoute);
app.route('/api/vocab', vocabRoute);
app.route('/api/review', reviewRoute);
app.route('/api/patterns', patternsRoute);
app.route('/api/settings', settingsRoute);
// Order matters: register the sub-route BEFORE the parent so Hono's matcher
// resolves /api/files/xlsx/* to filesXlsxRoute, not the catch-all in filesRoute.
app.route('/api/files/xlsx', filesXlsxRoute);
app.route('/api/files', filesRoute);
app.route('/api/version', versionRoute);
app.route('/api/update', updateRoute);
app.route('/api/judge', judgeRoute);
app.route('/api/judge-control', judgeControlRoute);
app.route('/api/feedback', feedbackRoute);

// Static frontend bundle. Three serving modes, in priority order:
//   1. Embedded — the release binary bakes web/dist into itself (see
//      scripts/generate-web-embed.ts). This is what makes a single downloaded
//      exe work with no extra files. embeddedAssets is non-empty only in builds.
//   2. Filesystem — `bun run start` (web:build + server) in a source checkout
//      serves web/dist directly.
//   3. Dev stub — nothing built yet; point the user at the dev workflow.
const webDist = join(import.meta.dir, '..', 'web', 'dist');
const webMode: 'embedded' | 'filesystem' | 'none' =
  embeddedAssets.length > 0
    ? 'embedded'
    : existsSync(webDist) && statSync(webDist).isDirectory()
      ? 'filesystem'
      : 'none';

if (webMode === 'embedded') {
  const byRoute = new Map(embeddedAssets.map((a) => [a.route, a.file]));
  const indexFile = byRoute.get('/index.html');
  app.get('/*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    const file = byRoute.get(pathname === '/' ? '/index.html' : pathname);
    if (file) return new Response(Bun.file(file));
    // SPA fallback: unknown non-API path → index.html for client-side routing.
    if (indexFile) {
      return new Response(Bun.file(indexFile), {
        headers: { 'content-type': 'text/html;charset=utf-8' },
      });
    }
    return c.text('not found', 404);
  });
} else if (webMode === 'filesystem') {
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

const appUrl = `http://${server.hostname}:${server.port}`;
const webUiStatus =
  webMode === 'embedded'
    ? 'served from embedded bundle'
    : webMode === 'filesystem'
      ? 'served from web/dist'
      : 'run `bun run web:dev`';
process.stdout.write(
  `privacy-screen app  →  ${appUrl}\n` +
    `  API health:       ${appUrl}/api/health\n` +
    `  Web UI:           ${webUiStatus}\n`,
);

// Double-click / installer launch path: `--open` (or PRIVACY_SCREEN_OPEN=1)
// opens the default browser at the app URL once the server is listening. The
// installers' shortcuts pass --open so users land on the UI, not a console.
if (process.argv.includes('--open') || process.env.PRIVACY_SCREEN_OPEN === '1') {
  if (webMode === 'none') {
    process.stdout.write('  (not opening browser: web bundle not built)\n');
  } else {
    void openBrowser(appUrl);
  }
}

// Eager-start the LLM subprocess so it's warm before the first request.
{
  const llmCfg = loadConfig().llm_validate;
  if (llmCfg.enabled) {
    void getLlmClient(llmCfg);
  }
}

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
