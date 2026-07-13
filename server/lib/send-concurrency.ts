/**
 * SRV-03 / #76: cap concurrent /api/send → claude CLI children.
 * Acceptance: a burst never has more than MAX_SEND_CONCURRENCY live slots.
 */

export const MAX_SEND_CONCURRENCY = 2;

let active = 0;
const waiters: Array<() => void> = [];

/** Test seam */
export function resetSendConcurrency(): void {
  active = 0;
  waiters.length = 0;
}

export function getActiveSendCount(): number {
  return active;
}

/**
 * Acquire a send slot. Resolves with a release() function.
 * If `signal` aborts while waiting (or already aborted), rejects with AbortError
 * without taking a slot.
 */
export function acquireSendSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }

  const tryAcquire = (): (() => void) | null => {
    if (active >= MAX_SEND_CONCURRENCY) return null;
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    };
  };

  const immediate = tryAcquire();
  if (immediate) return Promise.resolve(immediate);

  return new Promise<() => void>((resolve, reject) => {
    const onAbort = () => {
      const idx = waiters.indexOf(wake);
      if (idx >= 0) waiters.splice(idx, 1);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const release = tryAcquire();
      if (release) {
        resolve(release);
      } else {
        // Spurious wake — re-queue
        waiters.push(wake);
      }
    };

    waiters.push(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
