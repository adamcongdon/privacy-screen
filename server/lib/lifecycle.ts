/**
 * SRV-07 / #80 — shared graceful shutdown for the app process.
 *
 * server.ts registers the Bun.serve handle + LLM cleanup once at boot.
 * Signal handlers and POST /api/update/apply both call requestShutdown()
 * so exit paths cannot drift.
 */

import { shutdownLlmProcess } from './llm-process';

export type StoppableServer = { stop: (closeActiveConnections?: boolean) => void };

let serverHandle: StoppableServer | null = null;
let shuttingDown = false;

/** Optional test seam: override process.exit / delay */
let _exitFn: (code: number) => void = (code) => {
  process.exit(code);
};
let _delayMs = 0;

/** Register the HTTP server so requestShutdown can stop it. Call once after Bun.serve. */
export function registerServer(server: StoppableServer): void {
  serverHandle = server;
}

/** Test seams */
export function __test_setLifecycleHooks(opts: {
  exitFn?: (code: number) => void;
  delayMs?: number;
  reset?: boolean;
}): void {
  if (opts.reset) {
    serverHandle = null;
    shuttingDown = false;
    _exitFn = (code) => {
      process.exit(code);
    };
    _delayMs = 0;
    return;
  }
  if (opts.exitFn) _exitFn = opts.exitFn;
  if (opts.delayMs !== undefined) _delayMs = opts.delayMs;
}

/**
 * Begin graceful shutdown: LLM subprocess first, then HTTP stop, then exit 0.
 * Idempotent — concurrent callers share a single in-flight shutdown.
 *
 * @param delayMs optional pause before work (apply route uses this so the HTTP
 *   response can flush first). Defaults to 0 for signal handlers.
 */
export async function requestShutdown(delayMs: number = _delayMs): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }

  process.stdout.write('\nshutting down…\n');
  try {
    await shutdownLlmProcess();
  } catch {
    // best effort
  }
  try {
    serverHandle?.stop();
  } catch {
    // best effort
  }
  _exitFn(0);
}

/** Wire SIGINT/SIGTERM once. */
export function installSignalHandlers(): void {
  const onSignal = (): void => {
    void requestShutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
