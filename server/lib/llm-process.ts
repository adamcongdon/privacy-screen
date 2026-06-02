/**
 * Managed `llama-server` subprocess for the opt-in LLM secondary validator.
 *
 * One singleton process per Hono process. Module-level FSM. Lazy-start on the
 * first `getLlmClient()` call; SIGTERM after 10 min of idleness; permanent
 * disable on missing model file or repeated startup failure (no retry storms).
 *
 * Test seam: `configureLlmProcess({ spawn, fetchImpl, now, schedule, pickPort })`
 * injects fakes so the FSM is exercisable without spawning a real binary.
 * Production callers leave deps undefined and get Bun.spawn / global fetch /
 * Date.now / setTimeout.
 */

import { existsSync } from 'fs';
import type { LlmValidateConfig } from '../../src/config';
import { LlamaServerClient, type LlmClient } from '../../src/judge/llm-client';

/** Minimal subprocess handle. Mirrors the slice of `Bun.spawn` we use. */
export interface SpawnHandle {
  pid: number;
  kill(): void;
  exited: Promise<unknown>;
}

/** Cancellable scheduled callback (idle timer). */
export interface ScheduleHandle {
  cancel(): void;
}

/** Injectable dependencies. All are optional — production uses the defaults. */
export interface LlmProcessDeps {
  /** Inject a fake spawn for tests. Defaults to a Bun.spawn-backed real one. */
  spawn?: (
    cmd: string[],
    opts: { stdout: 'pipe' | 'ignore'; stderr: 'pipe' | 'ignore' },
  ) => SpawnHandle;
  /** Inject a fake fetch for health-check. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Inject a clock for idle-timer tests. Returns ms. Defaults to Date.now. */
  now?: () => number;
  /** Inject a setTimeout for idle-timer tests. Defaults to global setTimeout. */
  schedule?: (fn: () => void, ms: number) => ScheduleHandle;
  /** Pick an ephemeral high port. Defaults to a randomized 49152-65535 picker. */
  pickPort?: () => number;
}

/** Snapshot of the FSM. Exposed for tests and observability. */
export type LlmProcessState =
  | { kind: 'idle' }
  | { kind: 'starting'; promise: Promise<LlmClient | null> }
  | { kind: 'ready'; client: LlmClient; port: number; lastUsedAt: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'disabled'; reason: string };

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_TIMEOUT_MS = 30_000;
const HEALTH_FETCH_TIMEOUT_MS = 2_000;
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const SPAWN_RETRY_LIMIT = 10;

// Module-level FSM. Reset on every `configureLlmProcess` call so tests get a
// clean slate without restarting the process.
let state: LlmProcessState = { kind: 'idle' };
let proc: SpawnHandle | null = null;
let idleTimer: ScheduleHandle | null = null;
let deps: Required<LlmProcessDeps> = defaultDeps();
let stderrLoggedOnce = new Set<string>();

function defaultDeps(): Required<LlmProcessDeps> {
  return {
    spawn: (cmd, opts) => {
      // Bun.spawn shape matches SpawnHandle (pid, kill, exited).
      const p = Bun.spawn(cmd, opts);
      return {
        pid: p.pid,
        kill: () => p.kill(),
        exited: p.exited,
      };
    },
    fetchImpl: fetch,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(id) };
    },
    pickPort: () => 49152 + Math.floor(Math.random() * (65535 - 49152 + 1)),
  };
}

/** Reset the module with optional dependency injection. Tests call this. */
export function configureLlmProcess(overrides?: LlmProcessDeps): void {
  // Cancel any pending idle timer from a prior configuration.
  if (idleTimer) {
    idleTimer.cancel();
    idleTimer = null;
  }
  proc = null;
  state = { kind: 'idle' };
  stderrLoggedOnce = new Set<string>();
  const base = defaultDeps();
  deps = {
    spawn: overrides?.spawn ?? base.spawn,
    fetchImpl: overrides?.fetchImpl ?? base.fetchImpl,
    now: overrides?.now ?? base.now,
    schedule: overrides?.schedule ?? base.schedule,
    pickPort: overrides?.pickPort ?? base.pickPort,
  };
}

/** Snapshot of the FSM for tests / observability. */
export function getLlmProcessState(): LlmProcessState {
  return state;
}

/**
 * Get a usable `LlmClient` or null. Lazy-starts the subprocess on first call.
 * Returns null when:
 *   - `cfg.enabled` is false (state: disabled)
 *   - `cfg.model_path` is null (state: disabled, reason: 'model_path_missing')
 *   - model file does not exist (state: failed, reason: 'model_file_missing')
 *   - subprocess failed to come up within 30 s (state: failed)
 * Subsequent calls in 'failed' or 'disabled' states return null without retrying.
 */
export async function getLlmClient(
  cfg: LlmValidateConfig,
): Promise<LlmClient | null> {
  if (!cfg.enabled) {
    state = { kind: 'disabled', reason: 'enabled_false' };
    return null;
  }
  if (cfg.model_path === null) {
    state = { kind: 'disabled', reason: 'model_path_missing' };
    return null;
  }

  // External-endpoint mode: skip spawn entirely. LlamaServerClient enforces
  // loopback-only internally.
  if (cfg.endpoint !== null) {
    if (state.kind !== 'ready') {
      const client = new LlamaServerClient({ endpoint: cfg.endpoint });
      state = {
        kind: 'ready',
        client,
        port: parsePortOrDefault(cfg.endpoint),
        lastUsedAt: deps.now(),
      };
      armIdleTimer();
    } else {
      bumpIdle();
    }
    return state.client;
  }

  // Short-circuit terminal states. No retries.
  if (state.kind === 'failed' || state.kind === 'disabled') {
    return null;
  }

  if (state.kind === 'ready') {
    bumpIdle();
    return state.client;
  }

  if (state.kind === 'starting') {
    return state.promise;
  }

  // state.kind === 'idle' — verify model file exists, then spawn.
  if (!existsSync(cfg.model_path)) {
    state = { kind: 'failed', reason: 'model_file_missing' };
    logOnce(
      `model_file_missing:${cfg.model_path}`,
      `[privacy-screen] LLM model file missing: ${cfg.model_path}\n`,
    );
    return null;
  }

  const startup = startSubprocess(cfg.model_path);
  state = { kind: 'starting', promise: startup };
  return startup;
}

/**
 * Send SIGTERM to the subprocess and reset the FSM to 'idle'. Idempotent; safe
 * to call when state is anything (including 'idle' / 'failed' / 'disabled').
 */
export async function shutdownLlmProcess(): Promise<void> {
  if (idleTimer) {
    idleTimer.cancel();
    idleTimer = null;
  }
  const handle = proc;
  proc = null;
  state = { kind: 'idle' };
  if (handle) {
    try {
      handle.kill();
    } catch {
      // already gone
    }
    try {
      await handle.exited;
    } catch {
      // ignore
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// internals
// ────────────────────────────────────────────────────────────────────────────

/** Spawn llama-server and poll /health until ready or 30s timeout. */
async function startSubprocess(modelPath: string): Promise<LlmClient | null> {
  let lastError: string = 'unknown';
  for (let attempt = 0; attempt < SPAWN_RETRY_LIMIT; attempt++) {
    const port = deps.pickPort();
    let handle: SpawnHandle;
    try {
      handle = deps.spawn(
        [
          'llama-server',
          '--model',
          modelPath,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--n-gpu-layers',
          '0',
          '--ctx-size',
          '4096',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
    } catch (err) {
      lastError = `spawn_failed: ${errMessage(err)}`;
      continue;
    }

    proc = handle;

    const healthy = await pollHealth(port);
    if (healthy) {
      const endpoint = `http://127.0.0.1:${port}`;
      const client = new LlamaServerClient({
        endpoint,
        fetchImpl: deps.fetchImpl,
      });
      state = { kind: 'ready', client, port, lastUsedAt: deps.now() };
      armIdleTimer();
      return client;
    }

    // Health poll timed out — kill the subprocess and either retry or fail.
    lastError = 'health_timeout';
    try {
      handle.kill();
    } catch {
      // ignore
    }
    try {
      await handle.exited;
    } catch {
      // ignore
    }
    proc = null;
    // Only retry if the spawn itself failed; a true health timeout means the
    // model came up but never responded — retrying won't help. Break to fail.
    break;
  }

  state = { kind: 'failed', reason: lastError };
  logOnce(
    `startup_failed:${lastError}`,
    `[privacy-screen] LLM subprocess failed to start: ${lastError}\n`,
  );
  return null;
}

/** Poll `GET /health` every 500ms up to 30s. Any 2xx counts as ready. */
async function pollHealth(port: number): Promise<boolean> {
  const start = deps.now();
  while (deps.now() - start < HEALTH_POLL_TIMEOUT_MS) {
    try {
      const res = await deps.fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    deps.schedule(resolve, ms);
  });
}

/** Re-arm the idle timer from the current `lastUsedAt`. */
function armIdleTimer(): void {
  if (idleTimer) idleTimer.cancel();
  idleTimer = deps.schedule(() => {
    void onIdleTick();
  }, IDLE_SHUTDOWN_MS);
}

/** Idle-timer callback. Shuts down the subprocess if it's still ready+idle. */
async function onIdleTick(): Promise<void> {
  if (state.kind !== 'ready') return;
  const sinceUse = deps.now() - state.lastUsedAt;
  if (sinceUse >= IDLE_SHUTDOWN_MS) {
    await shutdownLlmProcess();
    return;
  }
  // False alarm — re-arm for the remaining window.
  armIdleTimer();
}

/** Update lastUsedAt and re-arm the idle timer. Called per hot-path request. */
function bumpIdle(): void {
  if (state.kind !== 'ready') return;
  state = { ...state, lastUsedAt: deps.now() };
  armIdleTimer();
}

/** Extract port number from an endpoint URL, defaulting to 0 on parse failure. */
function parsePortOrDefault(endpoint: string): number {
  try {
    const u = new URL(endpoint);
    const p = parseInt(u.port, 10);
    return Number.isFinite(p) ? p : 0;
  } catch {
    return 0;
  }
}

/** Best-effort message extraction from `unknown` thrown values. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Write to stderr at most once per dedupe key, for the lifetime of this FSM. */
function logOnce(key: string, msg: string): void {
  if (stderrLoggedOnce.has(key)) return;
  stderrLoggedOnce.add(key);
  process.stderr.write(msg);
}
