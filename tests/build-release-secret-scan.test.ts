/**
 * #104 / REL-04 — secret/PII scan gate on built release artifacts.
 *
 * Proves canaries fail (long credential forms, developer home paths) and that
 * CI runner homes + clean dist pass. Uses a synthetic dist/ so we never need
 * a full multi-platform compile in unit tests.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanForSecretsInDist,
  isSecretScanCandidate,
  SECRET_SCAN_RULES,
  DEFAULT_SECRET_SCAN_PATH_ALLOWLIST,
} from '../scripts/build-release';

const TMP_ROOT = join(tmpdir(), `ps-secret-scan-${process.pid}-${Date.now()}`);

async function writeArtifact(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), body, 'utf-8');
}

describe('isSecretScanCandidate', () => {
  test('scans privacy-screen binaries and installers', () => {
    expect(isSecretScanCandidate('privacy-screen-darwin-arm64')).toBe(true);
    expect(isSecretScanCandidate('privacy-screen-win32-x64.exe')).toBe(true);
    expect(isSecretScanCandidate('privacy-screen-setup-win32-x64.exe')).toBe(true);
    expect(isSecretScanCandidate('foo.dmg')).toBe(true);
  });

  test('skips release-manifest.json and other json', () => {
    expect(isSecretScanCandidate('release-manifest.json')).toBe(false);
    expect(isSecretScanCandidate('notes.json')).toBe(false);
  });
});

describe('Release binary secret/PII scan gate (#104 / REL-04)', () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test('scanForSecretsInDist is exported as a function', () => {
    expect(typeof scanForSecretsInDist).toBe('function');
    expect(SECRET_SCAN_RULES.length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_SECRET_SCAN_PATH_ALLOWLIST.some((p) => p.includes('runner'))).toBe(true);
  });

  test('canary: long sk-ant- credential in binary → FAIL', async () => {
    // 20+ body chars after sk-ant- so short detector literals do not trip.
    const canary =
      'padding-sk-ant-api03-THISISACANARYKEYVALUE1234567890ABCDEF-padding';
    await writeArtifact(TMP_ROOT, 'privacy-screen-darwin-arm64', canary);

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).rejects.toThrow(
      /secret\/PII scan gate failed|anthropic-key/,
    );
  });

  test('canary: developer /Users/ home path in binary → FAIL', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-x64',
      'source map residue /Users/adam/code/privacy-screen/server/server.ts end',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).rejects.toThrow(
      /secret\/PII scan gate failed|dev-home-users/,
    );
  });

  test('canary: ghp_ long PAT → FAIL', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-win32-x64.exe',
      'token=ghp_abcdefghijklmnopqrstuvwxyz012345 leak',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).rejects.toThrow(
      /secret\/PII scan gate failed|github-pat/,
    );
  });

  test('allowlist: CI runner home path → PASS', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      'compiled from /home/runner/work/privacy-screen/privacy-screen/server/server.ts',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).resolves.toBeUndefined();
  });

  test('allowlist: macOS GitHub Actions /Users/runner → PASS', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      'path=/Users/runner/work/privacy-screen/privacy-screen/src/patterns.ts',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).resolves.toBeUndefined();
  });

  test('mixed: runner allow + developer home still FAIL', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      '/home/runner/work/ok and also /Users/adam/secret/path',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).rejects.toThrow(
      /secret\/PII scan gate failed/,
    );
  });

  test('clean dist with only non-sensitive bytes → PASS', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      'privacy-screen release binary payload with no home paths or credentials',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).resolves.toBeUndefined();
  });

  test('AWS docs example AKIAIOSFODNN7EXAMPLE is allowlisted → PASS', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      'example key AKIAIOSFODNN7EXAMPLE from AWS docs',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).resolves.toBeUndefined();
  });

  test('real-looking AKIA access key → FAIL', async () => {
    await writeArtifact(
      TMP_ROOT,
      'privacy-screen-darwin-arm64',
      'key=AKIAJOHNNYTABLES1234 leftover',
    );

    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).rejects.toThrow(
      /secret\/PII scan gate failed|aws-access-key/,
    );
  });

  test('empty dist / no candidates → PASS (no throw)', async () => {
    await writeArtifact(TMP_ROOT, 'release-manifest.json', '{"version":"0.0.1"}');
    await expect(scanForSecretsInDist({ distDir: TMP_ROOT })).resolves.toBeUndefined();
  });
});
