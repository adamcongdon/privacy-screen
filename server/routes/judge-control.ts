/**
 * GUI controls for the opt-in LLM secondary validator.
 *
 *   GET  /api/judge-control/status     — full snapshot (config + runtime + install)
 *   POST /api/judge-control/enable     — { enabled: boolean }; writes to YAML
 *   POST /api/judge-control/install    — start downloading the pinned model
 *
 * Install runs in the background. The status endpoint reports progress so
 * the SettingsDrawer can poll while a download is in flight.
 *
 * All routes are gated by the existing Host-allowlist middleware in
 * `server.ts`; no additional auth needed because the server is loopback-only.
 */

import { Hono } from 'hono';
import { existsSync, statSync, createWriteStream, renameSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import { loadConfig } from '../../src/config';
import { patchLlmValidate } from '../lib/config-writer';
import { getLlmProcessState } from '../lib/llm-process';
import { MODELS } from '../../cli/install-judge';
import { getActiveJudgeRequests } from './judge';

export const judgeControlRoute = new Hono();

interface InstallProgress {
  active: boolean;
  modelName: string | null;
  bytesDownloaded: number;
  totalBytes: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  destPath: string | null;
}

let installState: InstallProgress = {
  active: false,
  modelName: null,
  bytesDownloaded: 0,
  totalBytes: 0,
  startedAt: 0,
  finishedAt: null,
  error: null,
  destPath: null,
};

function modelDir(): string {
  return join(homedir(), '.privacy-screen', 'models');
}

function whichLlamaServer(): string | null {
  try {
    const r = execSync('which llama-server', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return r || null;
  } catch {
    return null;
  }
}

function modelStatus(modelPath: string | null): {
  installed: boolean;
  path: string | null;
  bytes: number | null;
} {
  if (!modelPath) return { installed: false, path: null, bytes: null };
  if (!existsSync(modelPath)) return { installed: false, path: modelPath, bytes: null };
  try {
    return { installed: true, path: modelPath, bytes: statSync(modelPath).size };
  } catch {
    return { installed: false, path: modelPath, bytes: null };
  }
}

judgeControlRoute.get('/status', (c) => {
  const cfg = loadConfig().llm_validate;
  const runtimePath = whichLlamaServer();
  const model = modelStatus(cfg.model_path);
  const fsm = getLlmProcessState();

  return c.json({
    config: {
      enabled: cfg.enabled,
      model_path: cfg.model_path,
      endpoint: cfg.endpoint,
      runtime: cfg.runtime,
      max_tokens: cfg.max_tokens,
      timeout_ms: cfg.timeout_ms,
      min_confidence: cfg.min_confidence,
    },
    runtime: {
      installed: runtimePath !== null,
      path: runtimePath,
    },
    model,
    available_models: Object.entries(MODELS).map(([name, entry]) => ({
      name,
      url: entry.url,
      expected_size_bytes: entry.expectedSizeBytes,
      description: entry.description,
    })),
    process: { state: fsm.kind, detail: fsm.kind === 'failed' || fsm.kind === 'disabled' ? fsm.reason : null },
    activeRequests: getActiveJudgeRequests(),
    install: installState,
  });
});

judgeControlRoute.post('/enable', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be boolean' }, 400);
  }
  // Refuse to enable without a model file present. Better UX than silently
  // letting llm-process.ts trip its 'model_file_missing' failure path.
  if (body.enabled) {
    const cfg = loadConfig().llm_validate;
    if (!cfg.model_path || !existsSync(cfg.model_path)) {
      return c.json(
        {
          error:
            'cannot enable: model not installed. POST /api/judge-control/install first.',
        },
        409,
      );
    }
  }
  try {
    const next = patchLlmValidate({ enabled: body.enabled });
    return c.json({ ok: true, config: next.llm_validate });
  } catch (err) {
    return c.json(
      { error: `config write failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});

judgeControlRoute.post('/install', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const modelName = typeof body.model === 'string' ? body.model : 'qwen2.5-1.5b';
  const entry = MODELS[modelName];
  if (!entry) {
    return c.json({ error: `unknown model: ${modelName}` }, 400);
  }
  if (installState.active) {
    return c.json({ error: 'install already in progress' }, 409);
  }

  const dir = modelDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const destPath = join(dir, `${modelName}.gguf`);

  installState = {
    active: true,
    modelName,
    bytesDownloaded: 0,
    totalBytes: entry.expectedSizeBytes,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    destPath,
  };

  // Fire-and-forget. Status endpoint reports progress.
  void runInstall(modelName, entry.url, destPath);

  return c.json({ ok: true, install: installState }, 202);
});

async function runInstall(modelName: string, url: string, destPath: string): Promise<void> {
  const partPath = destPath + '.partial';
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      installState = {
        ...installState,
        active: false,
        finishedAt: Date.now(),
        error: `HTTP ${res.status}`,
      };
      return;
    }
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > 0) {
      installState = { ...installState, totalBytes: contentLength };
    }

    const hasher = new Bun.CryptoHasher('sha256');
    const ws = createWriteStream(partPath);
    const reader = res.body.getReader();
    let received = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        hasher.update(value);
        ws.write(Buffer.from(value));
        received += value.byteLength;
        installState = { ...installState, bytesDownloaded: received };
      }
    }

    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end();
    });

    const sha = hasher.digest('hex').toLowerCase();

    // JDG-04: verify against pinned in MODELS (size band + sha) BEFORE rename/patch.
    // Tampered never lands at final destPath and is never wired to config.
    const entry = MODELS[modelName];
    if (entry) {
      const expectedSize = entry.expectedSizeBytes;
      const sizeTolerance = Math.floor(expectedSize * 0.05);
      if (Math.abs(received - expectedSize) > sizeTolerance) {
        try { unlinkSync(partPath); } catch {}
        installState = {
          ...installState,
          active: false,
          finishedAt: Date.now(),
          bytesDownloaded: received,
          error: `size sanity band violation — refusing to write model file (expected ~${expectedSize} ±5%, got ${received})`,
        };
        return;
      }
      if (sha !== entry.expectedSha256.toLowerCase()) {
        try { unlinkSync(partPath); } catch {}
        installState = {
          ...installState,
          active: false,
          finishedAt: Date.now(),
          bytesDownloaded: received,
          error: `SHA-256 mismatch — refusing to write model file. expected: ${entry.expectedSha256} actual: ${sha}`,
        };
        return;
      }
    }

    if (existsSync(destPath)) {
      try { unlinkSync(destPath); } catch {}
    }
    renameSync(partPath, destPath);

    // Auto-set model_path in the config so the user doesn't have to. We do
    // NOT auto-enable — that's a separate user click in the UI.
    try {
      patchLlmValidate({ model_path: destPath });
    } catch {
      // Non-fatal: file is on disk, user can wire it up manually.
    }

    installState = {
      ...installState,
      active: false,
      finishedAt: Date.now(),
      bytesDownloaded: received,
      error: null,
    };
    process.stderr.write(
      `[privacy-screen] judge model installed: ${destPath} (${received}B, sha256=${sha})\n`,
    );
  } catch (err) {
    try { unlinkSync(partPath); } catch {}
    installState = {
      ...installState,
      active: false,
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
