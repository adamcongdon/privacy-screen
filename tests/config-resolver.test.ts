/**
 * Regression tests for config path resolution — the root cause of
 * "settings save failed: internal server error" in the installed app.
 *
 * The bundled binary runs with cwd=`/` and an `import.meta.dir` that points at a
 * read-only virtual filesystem. The old resolver fell back to
 * `import.meta.dir/../../PRIVACY_CONFIG.yaml`, so every settings/judge/update
 * write threw and 500'd. The reader, meanwhile, found no file and silently
 * returned defaults — which is why GET worked but nothing persisted.
 *
 * The fix points both reader (src/config.ts findConfigPath) and writer
 * (server/lib/config-resolver.ts resolveConfigPath) at the writable user-data
 * location `$HOME/.privacy-screen/PRIVACY_CONFIG.yaml`, and makes the writer
 * create the parent dir if missing.
 *
 * Note: Bun's `os.homedir()` ignores an overridden `process.env.HOME`, so these
 * tests do NOT fake HOME (that would write to the real user config). They pin
 * the resolver invariants without writing to the home location, and exercise the
 * mkdir-on-write regression through an explicit env-override temp path whose
 * parent directory does not yet exist.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, isAbsolute } from 'path';

import { resolveConfigPath } from '../server/lib/config-resolver';
import {
  patchUpdateConfig,
  patchScreeningMode,
  patchLlmValidate,
} from '../server/lib/config-writer';
import { userConfigPath, loadConfig } from '../src/config';

describe('resolveConfigPath — installed-app fallback (no env, non-repo cwd)', () => {
  let scratch: string;
  let realCwd: string;
  let prevEnvConfig: string | undefined;

  beforeEach(() => {
    prevEnvConfig = process.env.PRIVACY_SCREEN_CONFIG;
    delete process.env.PRIVACY_SCREEN_CONFIG; // simulate installed app — no override
    scratch = mkdtempSync(join(tmpdir(), 'ps-cwd-')); // a cwd with NO PRIVACY_CONFIG.yaml
    realCwd = process.cwd();
    process.chdir(scratch);
  });

  afterEach(() => {
    process.chdir(realCwd);
    if (prevEnvConfig === undefined) delete process.env.PRIVACY_SCREEN_CONFIG;
    else process.env.PRIVACY_SCREEN_CONFIG = prevEnvConfig;
    rmSync(scratch, { recursive: true, force: true });
  });

  test('targets the writable user-data dir, never a read-only bundled path', () => {
    const p = resolveConfigPath();
    // Reader and writer must agree on the exact same file.
    expect(p).toBe(userConfigPath());
    expect(p).toBe(join(require('os').homedir(), '.privacy-screen', 'PRIVACY_CONFIG.yaml'));
    expect(isAbsolute(p)).toBe(true);
    // The old bug: falling back to the bundled virtual filesystem / repo path.
    expect(p).not.toContain('$bunfs');
    expect(p).not.toContain(scratch);
    expect(p.endsWith(join('.privacy-screen', 'PRIVACY_CONFIG.yaml'))).toBe(true);
  });
});

describe('config-writer creates a missing parent dir (mkdir-on-write regression)', () => {
  let nestedDir: string;
  let cfgPath: string;
  let prevEnvConfig: string | undefined;

  beforeEach(() => {
    prevEnvConfig = process.env.PRIVACY_SCREEN_CONFIG;
    // A path whose parent directory does NOT exist yet — mirrors a fresh install
    // where $HOME/.privacy-screen/ has not been created. The old code called
    // writeFileSync directly and would throw ENOENT here.
    const base = mkdtempSync(join(tmpdir(), 'ps-fresh-'));
    nestedDir = join(base, 'does', 'not', 'exist');
    cfgPath = join(nestedDir, 'PRIVACY_CONFIG.yaml');
    process.env.PRIVACY_SCREEN_CONFIG = cfgPath;
  });

  afterEach(() => {
    if (prevEnvConfig === undefined) delete process.env.PRIVACY_SCREEN_CONFIG;
    else process.env.PRIVACY_SCREEN_CONFIG = prevEnvConfig;
    rmSync(join(nestedDir, '..', '..', '..'), { recursive: true, force: true });
  });

  test('patchUpdateConfig(beta) creates the dir + file instead of 500ing', () => {
    expect(existsSync(nestedDir)).toBe(false);
    const next = patchUpdateConfig({ update_channel: 'beta' });
    expect(next.update_channel).toBe('beta');
    expect(next.update_manifest_url).toContain('beta');
    expect(existsSync(cfgPath)).toBe(true);
    expect(readFileSync(cfgPath, 'utf-8')).toContain('update_channel: beta');
  });

  test('judge model_path persists across a reload (install-reset regression)', () => {
    const fakeModel = join(nestedDir, 'models', 'q.gguf');
    const next = patchLlmValidate({ model_path: fakeModel });
    expect(next.llm_validate.model_path).toBe(fakeModel);
    // The status endpoint reads this back via loadConfig; it must survive.
    expect(loadConfig(cfgPath).llm_validate.model_path).toBe(fakeModel);
  });

  test('mode persists across a reload', () => {
    patchScreeningMode('observe');
    expect(loadConfig(cfgPath).mode).toBe('observe');
  });
});
