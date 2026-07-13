/**
 * SRV-07 / #80 — shared requestShutdown lifecycle.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  registerServer,
  requestShutdown,
  __test_setLifecycleHooks,
} from '../server/lib/lifecycle';

describe('lifecycle requestShutdown (SRV-07 / #80)', () => {
  beforeEach(() => {
    __test_setLifecycleHooks({ reset: true });
  });

  test('stops registered server and exits once', async () => {
    let stops = 0;
    const exits: number[] = [];
    registerServer({
      stop: () => {
        stops += 1;
      },
    });
    __test_setLifecycleHooks({
      exitFn: (code) => {
        exits.push(code);
      },
    });

    await requestShutdown(0);
    await requestShutdown(0); // idempotent

    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('honors delay before stop (apply-route flush window)', async () => {
    const t0 = Date.now();
    __test_setLifecycleHooks({
      exitFn: () => {},
    });
    registerServer({ stop: () => {} });
    await requestShutdown(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  test('update route source uses requestShutdown, not process.exit', async () => {
    const src = await Bun.file(new URL('../server/routes/update.ts', import.meta.url)).text();
    expect(src).toContain('requestShutdown');
    expect(src).not.toMatch(/process\.exit\s*\(/);
    expect(src).not.toMatch(/(result as any)/);
  });
});
