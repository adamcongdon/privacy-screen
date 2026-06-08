/**
 * Tests for server/lib/llm-process.ts — the managed llama-server subprocess.
 *
 * The FSM is module-level state, so every test must reset it via
 * `configureLlmProcess(deps)` (with DI fakes) before exercising behavior, and
 * call `shutdownLlmProcess()` in afterEach to make sure no idle timers leak
 * into the next test.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureLlmProcess,
  getLlmClient,
  getLlmProcessState,
  shutdownLlmProcess,
  type SpawnHandle,
  type ScheduleHandle,
} from '../server/lib/llm-process';
import type { LlmValidateConfig } from '../src/config';

afterEach(async () => {
  await shutdownLlmProcess();
});

/** Build a complete LlmValidateConfig with overrides. */
function cfg(overrides: Partial<LlmValidateConfig>): LlmValidateConfig {
  return {
    enabled: true,
    model_path: null,
    runtime: 'llama-server',
    endpoint: null,
    max_tokens: 256,
    timeout_ms: 2500,
    min_confidence: 0.6,
    ...overrides,
  };
}

/** Fake spawn that records calls and returns a controllable handle. */
function makeFakeSpawn() {
  const calls: Array<{ cmd: string[]; pid: number }> = [];
  const handles: Array<{ killed: boolean; exitedResolve: () => void }> = [];
  let nextPid = 1000;
  const spawn = (cmd: string[]): SpawnHandle => {
    const pid = nextPid++;
    calls.push({ cmd, pid });
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const slot = { killed: false, exitedResolve: resolveExited };
    handles.push(slot);
    return {
      pid,
      kill: () => {
        slot.killed = true;
        slot.exitedResolve();
      },
      exited,
    };
  };
  return { spawn, calls, handles };
}

/**
 * Fake schedule that uses real setTimeout but exposes a count. We don't
 * actually fast-forward time — tests that need long timeouts mock fetchImpl
 * to reject immediately, then drive their own cadence.
 */
function realSchedule(fn: () => void, ms: number): ScheduleHandle {
  const id = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(id) };
}

describe('llm-process FSM', () => {
  test('disabled when enabled=false', async () => {
    configureLlmProcess({ spawn: makeFakeSpawn().spawn });
    const c = await getLlmClient(cfg({ enabled: false, model_path: '/x' }));
    expect(c).toBeNull();
    expect(getLlmProcessState().kind).toBe('disabled');
  });

  test('disabled when model_path is null', async () => {
    configureLlmProcess({ spawn: makeFakeSpawn().spawn });
    const c = await getLlmClient(cfg({ enabled: true, model_path: null }));
    expect(c).toBeNull();
    const s = getLlmProcessState();
    expect(s.kind).toBe('disabled');
    if (s.kind === 'disabled') {
      expect(s.reason).toBe('model_path_missing');
    }
  });

  test('failed when model file does not exist', async () => {
    configureLlmProcess({ spawn: makeFakeSpawn().spawn });
    const c = await getLlmClient(
      cfg({ enabled: true, model_path: '/nonexistent-model.gguf' }),
    );
    expect(c).toBeNull();
    const s = getLlmProcessState();
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') {
      expect(s.reason).toBe('model_file_missing');
    }
  });

  test('endpoint override skips spawn', async () => {
    const { spawn, calls } = makeFakeSpawn();
    configureLlmProcess({ spawn });
    const c = await getLlmClient(
      cfg({
        enabled: true,
        model_path: '/tmp/whatever',
        endpoint: 'http://127.0.0.1:9999',
      }),
    );
    expect(c).not.toBeNull();
    expect(calls.length).toBe(0); // no spawn
    const s = getLlmProcessState();
    expect(s.kind).toBe('ready');
    if (s.kind === 'ready') {
      expect(s.port).toBe(9999);
    }
  });

  test('lazy spawn happy path with health-check success', async () => {
    // Use the running test file itself as a "model" so existsSync passes.
    const modelPath = new URL(import.meta.url).pathname;
    const { spawn, calls } = makeFakeSpawn();
    const fetchImpl = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof fetch;

    configureLlmProcess({
      spawn,
      fetchImpl,
      schedule: realSchedule,
      pickPort: () => 55555,
    });

    const c = await getLlmClient(cfg({ enabled: true, model_path: modelPath }));
    expect(c).not.toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0].cmd[0]).toBe('llama-server');
    expect(calls[0].cmd).toContain('--port');
    expect(calls[0].cmd).toContain('55555');
    expect(calls[0].cmd).toContain('--host');
    expect(calls[0].cmd).toContain('127.0.0.1');

    const s = getLlmProcessState();
    expect(s.kind).toBe('ready');
    if (s.kind === 'ready') {
      expect(s.port).toBe(55555);
    }
  });

  test('health-poll timeout marks state failed and kills subprocess', async () => {
    const modelPath = new URL(import.meta.url).pathname;
    const { spawn, handles } = makeFakeSpawn();
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    // Virtual clock: advance by HEALTH_POLL_INTERVAL_MS per tick.
    let virtualNow = 0;
    const now = (): number => virtualNow;
    const schedule = (fn: () => void, ms: number): ScheduleHandle => {
      virtualNow += ms;
      // Run the callback on next microtask so the loop progresses.
      queueMicrotask(fn);
      return { cancel: () => { /* noop */ } };
    };

    configureLlmProcess({ spawn, fetchImpl, now, schedule, pickPort: () => 55556 });

    const c = await getLlmClient(cfg({ enabled: true, model_path: modelPath }));
    expect(c).toBeNull();
    const s = getLlmProcessState();
    expect(s.kind).toBe('failed');
    expect(handles[0]?.killed).toBe(true);
  });

  test('no retry after failed state', async () => {
    const modelPath = new URL(import.meta.url).pathname;
    const { spawn, calls } = makeFakeSpawn();
    const fetchImpl = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    let virtualNow = 0;
    const now = (): number => virtualNow;
    const schedule = (fn: () => void, ms: number): ScheduleHandle => {
      virtualNow += ms;
      queueMicrotask(fn);
      return { cancel: () => { /* noop */ } };
    };
    configureLlmProcess({ spawn, fetchImpl, now, schedule, pickPort: () => 55557 });

    const first = await getLlmClient(cfg({ enabled: true, model_path: modelPath }));
    expect(first).toBeNull();
    const spawnCallsAfterFirst = calls.length;

    const second = await getLlmClient(cfg({ enabled: true, model_path: modelPath }));
    expect(second).toBeNull();
    expect(calls.length).toBe(spawnCallsAfterFirst); // no extra spawn
  });

  test('shutdown is idempotent', async () => {
    const { spawn, handles } = makeFakeSpawn();
    const fetchImpl = (async () =>
      new Response('ok', { status: 200 })) as unknown as typeof fetch;
    configureLlmProcess({
      spawn,
      fetchImpl,
      schedule: realSchedule,
      pickPort: () => 55558,
    });

    // shutdown from idle — no-op, no throws
    await shutdownLlmProcess();
    expect(getLlmProcessState().kind).toBe('idle');

    // bring up to ready, then shutdown once
    const modelPath = new URL(import.meta.url).pathname;
    const c = await getLlmClient(cfg({ enabled: true, model_path: modelPath }));
    expect(c).not.toBeNull();
    await shutdownLlmProcess();
    expect(handles[0]?.killed).toBe(true);

    // shutdown again — still idempotent, no throw
    await shutdownLlmProcess();
    expect(getLlmProcessState().kind).toBe('idle');
  });
});
