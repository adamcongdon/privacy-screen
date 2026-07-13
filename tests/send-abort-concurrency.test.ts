/**
 * SRV-03 / #76 — abort + concurrency for /api/send.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  acquireSendSlot,
  getActiveSendCount,
  resetSendConcurrency,
  MAX_SEND_CONCURRENCY,
} from '../server/lib/send-concurrency';

describe('send concurrency (SRV-03 / #76)', () => {
  beforeEach(() => {
    resetSendConcurrency();
  });

  test('MAX_SEND_CONCURRENCY is 2', () => {
    expect(MAX_SEND_CONCURRENCY).toBe(2);
  });

  test('two acquires succeed immediately; third waits until a release', async () => {
    const r1 = await acquireSendSlot();
    const r2 = await acquireSendSlot();
    expect(getActiveSendCount()).toBe(2);

    let thirdResolved = false;
    const third = acquireSendSlot().then((release) => {
      thirdResolved = true;
      return release;
    });

    // Give microtasks a turn — third must still be waiting
    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(getActiveSendCount()).toBe(2);

    r1(); // free a slot
    const r3 = await third;
    expect(thirdResolved).toBe(true);
    expect(getActiveSendCount()).toBe(2);

    r2();
    r3();
    expect(getActiveSendCount()).toBe(0);
  });

  test('abort while waiting rejects without taking a slot', async () => {
    const r1 = await acquireSendSlot();
    const r2 = await acquireSendSlot();
    const ac = new AbortController();

    const pending = acquireSendSlot(ac.signal);
    await Promise.resolve();
    ac.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getActiveSendCount()).toBe(2);

    r1();
    r2();
    expect(getActiveSendCount()).toBe(0);
  });

  test('already-aborted signal rejects immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquireSendSlot(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getActiveSendCount()).toBe(0);
  });
});

describe('streamChat abortSignal wiring (source contract)', () => {
  test('send route source passes abortSignal into streamChat options', async () => {
    const src = await Bun.file(new URL('../server/routes/send.ts', import.meta.url)).text();
    expect(src).toContain('abortSignal');
    expect(src).toContain('c.req.raw.signal');
    expect(src).toContain('acquireSendSlot');
    expect(src).toContain('rateLimited');
  });

  test('claude-code kills child on abort (including already-aborted)', async () => {
    const src = await Bun.file(new URL('../server/providers/claude-code.ts', import.meta.url)).text();
    expect(src).toContain('opts.abortSignal.aborted');
    expect(src).toContain("child.kill('SIGTERM')");
  });
});
