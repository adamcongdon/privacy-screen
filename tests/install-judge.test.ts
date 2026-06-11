/**
 * Unit tests for the `install-judge` CLI surface.
 *
 * Uses the DI'd `runInstallJudge(args, deps)` directly so we never touch the
 * real network or write to disk. The CLI shim in `cli/PrivacyScreen.ts`
 * delegates to this function — the integration there is a thin pass-through.
 */
import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { join } from 'path';

import {
  MODELS,
  runInstallJudge,
  type InstallJudgeDeps,
} from '../cli/install-judge';

const FAKE_HOME = '/tmp/pai-privacy-fake-home';

interface DepHooks {
  fetchResponse?: (url: string) => Promise<Response>;
  whichResult?: string | null;
  platform?: NodeJS.Platform;
  fsExistsResult?: (path: string) => boolean;
  /** Records writes (path → bytes). */
  writes?: Map<string, Uint8Array>;
  mkdirs?: Set<string>;
}

function deps(hooks: DepHooks = {}): InstallJudgeDeps {
  const writes = hooks.writes ?? new Map<string, Uint8Array>();
  const mkdirs = hooks.mkdirs ?? new Set<string>();
  return {
    fetchImpl: (((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (hooks.fetchResponse) return hooks.fetchResponse(url);
      throw new Error('fetch should not have been called');
    }) as unknown) as typeof fetch,
    homedir: () => FAKE_HOME,
    fsExists: hooks.fsExistsResult ?? (() => false),
    fsMkdir: (p) => {
      mkdirs.add(p);
    },
    fsWrite: (p, data) => {
      writes.set(p, data);
    },
    fsCreateWriteStream: (p) => {
      if (!p.endsWith('.partial')) {
        return {
          write: (d: Uint8Array | Buffer) => { writes.set(p, d instanceof Uint8Array ? d : new Uint8Array(d)); },
          end: (cb?: () => void) => { if (cb) cb(); },
          on: (_e: string, _cb: (e?: Error) => void) => {},
        };
      }
      const partials = (globalThis as any).__fable72_partials || ((globalThis as any).__fable72_partials = new Map<string, Uint8Array>());
      partials.set(p, new Uint8Array(0));
      return {
        write: (d: Uint8Array | Buffer) => {
          const cur = partials.get(p) || new Uint8Array(0);
          const add = d instanceof Uint8Array ? d : new Uint8Array(d);
          const next = new Uint8Array(cur.length + add.length);
          next.set(cur); next.set(add, cur.length);
          partials.set(p, next);
        },
        end: (cb?: () => void) => { if (cb) cb(); },
        on: (_e: string, _cb: (e?: Error) => void) => {},
      };
    },
    fsRename: (oldPath, newPath) => {
      const partials = (globalThis as any).__fable72_partials;
      if (oldPath.endsWith('.partial') && partials && partials.has(oldPath)) {
        writes.set(newPath, partials.get(oldPath)!);
        partials.delete(oldPath);
      } else if (writes.has(oldPath)) {
        writes.set(newPath, writes.get(oldPath)!);
        writes.delete(oldPath);
      }
    },
    fsUnlink: (p) => {
      writes.delete(p);
      const partials = (globalThis as any).__fable72_partials;
      if (partials) partials.delete(p);
    },
    whichLlamaServer: () => hooks.whichResult ?? null,
    platform: () => hooks.platform ?? 'darwin',
  };
}

const MODEL_DIR = join(FAKE_HOME, '.privacy-screen', 'models');
const DEFAULT_MODEL_DEST = join(MODEL_DIR, 'qwen2.5-1.5b.gguf');

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function asResponse(body: Uint8Array, status = 200): Response {
  // Bun's lib.dom typings use `ArrayBufferView<ArrayBuffer>` for BlobPart,
  // which the new `Uint8Array<ArrayBufferLike>` generic doesn't satisfy at
  // the type level even though it's runtime-compatible. Copy through an
  // explicit ArrayBuffer to keep the typechecker happy without `any`.
  const buf = new ArrayBuffer(body.byteLength);
  new Uint8Array(buf).set(body);
  return new Response(buf, { status });
}

describe('install-judge — runtime mode', () => {
  test('reports llama-server path when found', async () => {
    const r = await runInstallJudge(
      ['--runtime'],
      deps({ whichResult: '/opt/homebrew/bin/llama-server' }),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('/opt/homebrew/bin/llama-server');
  });

  test('prints macOS install hint when missing', async () => {
    const r = await runInstallJudge(
      ['--runtime'],
      deps({ whichResult: null, platform: 'darwin' }),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('brew install llama.cpp');
  });

  test('prints linux install hint when missing', async () => {
    const r = await runInstallJudge(
      ['--runtime'],
      deps({ whichResult: null, platform: 'linux' }),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('pacman -S llama.cpp');
  });

  test('prints windows install hint when missing', async () => {
    const r = await runInstallJudge(
      ['--runtime'],
      deps({ whichResult: null, platform: 'win32' }),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('winget');
  });
});

describe('install-judge — model mode argument checks', () => {
  test('no mode → prints known models', async () => {
    const r = await runInstallJudge([], deps());
    expect(r.ok).toBe(false);
    for (const name of Object.keys(MODELS)) {
      expect(r.stderrMessage).toContain(name);
    }
  });

  test('unknown model → rejected', async () => {
    const r = await runInstallJudge(
      ['--model', 'gpt-7'],
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('unknown model');
  });

  test('refuses without --allow-network', async () => {
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b'],
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('--allow-network');
  });

  test('--dry-run with valid model prints plan and skips network', async () => {
    const writes = new Map<string, Uint8Array>();
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--dry-run'],
      deps({ writes }),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Dry run');
    expect(r.message).toContain(DEFAULT_MODEL_DEST);
    expect(writes.size).toBe(0);
  });

  test('--dry-run includes "requires --allow-network" when not granted', async () => {
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--dry-run'],
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('requires --allow-network');
  });

  test('--dest outside safe directory → rejected (path traversal)', async () => {
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network', '--dest', '/etc/passwd'],
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('path traversal');
  });

  test('--dest with traversal segments → rejected', async () => {
    const r = await runInstallJudge(
      [
        '--model',
        'qwen2.5-1.5b',
        '--allow-network',
        '--dest',
        join(MODEL_DIR, '..', '..', 'etc', 'passwd'),
      ],
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('path traversal');
  });
});

describe('install-judge — model download', () => {
  test('happy path writes file and prints success', async () => {
    const fakeBody = new TextEncoder().encode('fake-gguf-bytes');
    const writes = new Map<string, Uint8Array>();
    const mkdirs = new Set<string>();

    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network', '--expected-sha256', sha256(fakeBody)],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        writes,
        mkdirs,
      }),
    );

    expect(r.ok).toBe(true);
    expect(r.message).toContain('Model installed');
    expect(writes.get(DEFAULT_MODEL_DEST)).toEqual(fakeBody);
    expect(mkdirs.has(MODEL_DIR)).toBe(true);
    expect(r.message).toContain(sha256(fakeBody));
  });

  test('SHA mismatch → aborts and refuses to write', async () => {
    const fakeBody = new TextEncoder().encode('fake-gguf-bytes');
    const writes = new Map<string, Uint8Array>();

    const r = await runInstallJudge(
      [
        '--model',
        'qwen2.5-1.5b',
        '--allow-network',
        '--expected-sha256',
        'deadbeef'.repeat(8),
      ],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        writes,
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('SHA-256 mismatch');
    expect(writes.size).toBe(0);
  });

  test('SHA match → writes file', async () => {
    const fakeBody = new TextEncoder().encode('fake-gguf-bytes-2');
    const writes = new Map<string, Uint8Array>();

    const r = await runInstallJudge(
      [
        '--model',
        'qwen2.5-1.5b',
        '--allow-network',
        '--expected-sha256',
        sha256(fakeBody),
      ],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        writes,
      }),
    );

    expect(r.ok).toBe(true);
    expect(writes.get(DEFAULT_MODEL_DEST)).toEqual(fakeBody);
  });

  test('HTTP non-2xx → fails with status in message', async () => {
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network'],
      deps({
        fetchResponse: async () => asResponse(new Uint8Array(0), 404),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('HTTP 404');
  });

  test('fetch throws → fails gracefully', async () => {
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network'],
      deps({
        fetchResponse: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.stderrMessage).toContain('download failed');
    expect(r.stderrMessage).toContain('boom');
  });

  test('skips mkdir when dir already exists', async () => {
    const fakeBody = new TextEncoder().encode('fake');
    const mkdirs = new Set<string>();
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network', '--expected-sha256', sha256(fakeBody)],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        fsExistsResult: (p) => p === MODEL_DIR,
        mkdirs,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mkdirs.size).toBe(0);
  });

  test('success message tells user what YAML to add', async () => {
    const fakeBody = new TextEncoder().encode('fake');
    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network', '--expected-sha256', sha256(fakeBody)],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('llm_validate:');
    expect(r.message).toContain('enabled: true');
    expect(r.message).toContain(`model_path: ${DEFAULT_MODEL_DEST}`);
  });

  // #72 (JDG-08) streaming TDD tests (inside describe so collected). Written in RED phase.
  // TDD for ONLY #68 (pre any edit to cli/install-judge.ts): size out-of-band and default (no flag) tamper both refuse write.
  test('size out-of-band (far from expectedSizeBytes) refuses to write (default path, no flag)', async () => {
    const fakeBody = new TextEncoder().encode('tiny-tampered-payload');
    const writes = new Map<string, Uint8Array>();

    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network'],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        writes,
      }),
    );

    expect(r.ok).toBe(false);
    expect((r.stderrMessage || '').toLowerCase()).toMatch(/size|sanity|band|out.of.band/);
    expect(writes.size).toBe(0);
  });

  test('byte-flipped/tampered payload (default verify, no --expected-sha256 flag) refuses to write, no model_path wired (for CLI: success only prints snippet)', async () => {
    const fakeBody = new TextEncoder().encode('tampered-bytes-that-will-never-match-the-pinned-sha');
    const writes = new Map<string, Uint8Array>();

    const r = await runInstallJudge(
      ['--model', 'qwen2.5-1.5b', '--allow-network'],
      deps({
        fetchResponse: async () => asResponse(fakeBody, 200),
        writes,
      }),
    );

    expect(r.ok).toBe(false);
    const msg = (r.stderrMessage || '').toLowerCase();
    expect(msg).toMatch(/sha-256 mismatch|size sanity band/);
    expect(writes.size).toBe(0);
  });
});
