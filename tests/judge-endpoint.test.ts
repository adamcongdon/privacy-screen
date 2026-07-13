/**
 * Unit tests for hooks/lib/judge-endpoint.ts (HOOK-07 / #99).
 *
 * Pins the shared loopback-only resolver used by both fire-and-forget
 * dispatch and the sync auto-approve precheck.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { resolveJudgeEndpoint } from '../hooks/lib/judge-endpoint';

const ENV_KEYS = ['PRIVACY_SCREEN_JUDGE_ENDPOINT', 'PRIVACY_SCREEN_PORT'] as const;

const saved: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

snapshotEnv();

afterEach(() => {
  restoreEnv();
});

describe('resolveJudgeEndpoint', () => {
  test('default async path on 127.0.0.1:31338', () => {
    clearEnv();
    expect(resolveJudgeEndpoint('async')).toBe('http://127.0.0.1:31338/api/judge');
  });

  test('default sync path on 127.0.0.1:31338', () => {
    clearEnv();
    expect(resolveJudgeEndpoint('sync')).toBe('http://127.0.0.1:31338/api/judge/sync');
  });

  test('PRIVACY_SCREEN_PORT honored for both kinds', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_PORT = '41234';
    expect(resolveJudgeEndpoint('async')).toBe('http://127.0.0.1:41234/api/judge');
    expect(resolveJudgeEndpoint('sync')).toBe('http://127.0.0.1:41234/api/judge/sync');
  });

  test('override preserved (full path, not rewritten by kind)', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'http://127.0.0.1:9999/custom/path';
    expect(resolveJudgeEndpoint('async')).toBe('http://127.0.0.1:9999/custom/path');
    expect(resolveJudgeEndpoint('sync')).toBe('http://127.0.0.1:9999/custom/path');
  });

  test('localhost override accepted', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'http://localhost:31338/api/judge';
    expect(resolveJudgeEndpoint('async')).toBe('http://localhost:31338/api/judge');
  });

  test('IPv6 loopback ::1 accepted', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'http://[::1]:31338/api/judge';
    expect(resolveJudgeEndpoint('async')).toBe('http://[::1]:31338/api/judge');
  });

  test('non-loopback rejected (TEST-NET-1)', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'http://192.0.2.1:31338/api/judge';
    expect(resolveJudgeEndpoint('async')).toBeNull();
    expect(resolveJudgeEndpoint('sync')).toBeNull();
  });

  test('https rejected', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'https://127.0.0.1:31338/api/judge';
    expect(resolveJudgeEndpoint('async')).toBeNull();
  });

  test('malformed URL rejected', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'not a url';
    expect(resolveJudgeEndpoint('async')).toBeNull();
    expect(resolveJudgeEndpoint('sync')).toBeNull();
  });

  test('ftp / other schemes rejected', () => {
    clearEnv();
    process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT = 'ftp://127.0.0.1/api/judge';
    expect(resolveJudgeEndpoint('async')).toBeNull();
  });
});
