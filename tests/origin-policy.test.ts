/**
 * Origin-policy unit tests (SRV-01 #74, SRV-08 #81).
 */
import { describe, test, expect } from 'bun:test';
import {
  isAllowedOrigin,
  MUTATING_METHODS,
  DEV_ORIGIN_ALLOWLIST,
} from '../server/lib/origin-policy';

const PORT = 31338;

describe('isAllowedOrigin — same origin', () => {
  test('loopback same-origin is always allowed (dev or release)', () => {
    for (const isDevWeb of [true, false]) {
      expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, { port: PORT, isDevWeb })).toBe(true);
      expect(isAllowedOrigin(`http://localhost:${PORT}`, { port: PORT, isDevWeb })).toBe(true);
    }
  });
});

describe('isAllowedOrigin — Vite dev origins gated by mode (SRV-08 #81)', () => {
  test('5173/5174 allowed in dev web mode', () => {
    for (const origin of DEV_ORIGIN_ALLOWLIST) {
      expect(isAllowedOrigin(origin, { port: PORT, isDevWeb: true })).toBe(true);
    }
  });

  test('5173/5174 REJECTED in release (non-dev) mode', () => {
    for (const origin of DEV_ORIGIN_ALLOWLIST) {
      expect(isAllowedOrigin(origin, { port: PORT, isDevWeb: false })).toBe(false);
    }
  });
});

describe('isAllowedOrigin — foreign origins always rejected', () => {
  test('evil origin is never allowed', () => {
    for (const isDevWeb of [true, false]) {
      expect(isAllowedOrigin('http://evil.example.com', { port: PORT, isDevWeb })).toBe(false);
      expect(isAllowedOrigin('https://attacker.test', { port: PORT, isDevWeb })).toBe(false);
    }
  });
});

describe('MUTATING_METHODS (SRV-01 #74)', () => {
  test('covers all state-mutating verbs, not GET/HEAD', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(MUTATING_METHODS.has(m)).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(MUTATING_METHODS.has(m)).toBe(false);
  });
});
