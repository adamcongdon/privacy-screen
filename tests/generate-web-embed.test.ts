/**
 * REL-03 / #103: generate-web-embed must not ship sourcemaps, dotfiles, or
 * non-allowlisted extensions into the release binary embed list.
 */
import { test, expect, describe } from 'bun:test';
import { join } from 'path';
import {
  shouldEmbedAsset,
  hasSourcemapFiles,
  EMBED_ALLOWED_EXTENSIONS,
} from '../scripts/generate-web-embed';
import { readFileSync } from 'fs';

const DIST = '/virtual/web/dist';

describe('shouldEmbedAsset (REL-03 / #103)', () => {
  test('allows html/js/css/svg/png/ico/woff2/json/webmanifest', () => {
    for (const ext of ['.html', '.js', '.css', '.svg', '.png', '.ico', '.woff2', '.json', '.webmanifest']) {
      expect(shouldEmbedAsset(join(DIST, `assets/x${ext}`), DIST)).toBe(true);
    }
  });

  test('rejects .map sourcemaps', () => {
    expect(shouldEmbedAsset(join(DIST, 'assets/index-abc.js.map'), DIST)).toBe(false);
    expect(shouldEmbedAsset(join(DIST, 'assets/index.css.map'), DIST)).toBe(false);
  });

  test('rejects dotfiles and hidden path segments', () => {
    expect(shouldEmbedAsset(join(DIST, '.DS_Store'), DIST)).toBe(false);
    expect(shouldEmbedAsset(join(DIST, 'assets/.hidden.js'), DIST)).toBe(false);
    expect(shouldEmbedAsset(join(DIST, '.well-known/x.json'), DIST)).toBe(false);
  });

  test('rejects disallowed extensions (e.g. .ts, .map, .md)', () => {
    expect(shouldEmbedAsset(join(DIST, 'assets/foo.ts'), DIST)).toBe(false);
    expect(shouldEmbedAsset(join(DIST, 'README.md'), DIST)).toBe(false);
  });

  test('allowlist set is non-empty and includes js/html', () => {
    expect(EMBED_ALLOWED_EXTENSIONS.has('.js')).toBe(true);
    expect(EMBED_ALLOWED_EXTENSIONS.has('.html')).toBe(true);
    expect(EMBED_ALLOWED_EXTENSIONS.has('.map')).toBe(false);
  });
});

describe('hasSourcemapFiles', () => {
  test('detects .map paths', () => {
    expect(hasSourcemapFiles([join(DIST, 'a.js'), join(DIST, 'a.js.map')])).toBe(true);
    expect(hasSourcemapFiles([join(DIST, 'a.js'), join(DIST, 'a.css')])).toBe(false);
  });
});

describe('Vite production sourcemap off (assert config)', () => {
  test('web/vite.config.ts sets build.sourcemap to false', () => {
    const src = readFileSync(join(import.meta.dir, '../web/vite.config.ts'), 'utf8');
    expect(src).toMatch(/sourcemap\s*:\s*false/);
  });
});
