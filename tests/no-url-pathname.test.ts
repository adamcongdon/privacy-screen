// Regression guard (ISA ISC-1): `new URL(..., import.meta.url).pathname` keeps
// percent-encoding, so a checkout path with a space ("My Drive") becomes
// "My%20Drive" and every spawned hook/CLI fails with ENOENT. Use fileURLToPath.
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['tests', 'server', 'src', 'hooks', 'cli', 'scripts'];
const BAD = /import\.meta\.url\)?\)\.pathname/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist') return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('file paths from import.meta.url', () => {
  test('never read via URL.pathname (breaks on paths with spaces)', () => {
    const self = fileURLToPath(import.meta.url);
    const offenders = DIRS.flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => f !== self && BAD.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
