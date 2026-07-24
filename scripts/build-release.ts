#!/usr/bin/env bun
/**
 * Build single-file binaries + a matching release manifest.
 *
 * Run from project root:
 *   bun scripts/build-release.ts
 *   bun scripts/build-release.ts --channel beta
 *
 * Outputs:
 *   dist/privacy-screen-darwin-arm64
 *   dist/privacy-screen-darwin-x64
 *   dist/privacy-screen-win32-x64.exe
 *   dist/release-manifest.json
 *
 * Use --channel beta to produce a beta-channel manifest (for dev-branch
 * auto-builds). Default is 'stable'.
 *
 * Versioning convention:
 *   - In CI, the canonical next version is computed by
 *     `scripts/compute-version.ts` from existing git tags, and the workflow
 *     stamps that value into package.json *before* invoking this script.
 *   - Locally, this script reads pkg.version verbatim. To preview the
 *     CI-computed version: `bun scripts/compute-version.ts beta|stable`.
 *   - package.json acts as a floor: if its declared base is higher than every
 *     existing tag in the channel, the next release jumps to that base.
 *     Otherwise the workflow auto-increments from the highest existing tag.
 *
 * After build (and on --manifest-only), {@link scanForSecretsInDist} runs a
 * denylist scan over release artifacts so baked home paths / credential
 * forms never ship. CI runner homes are allowlisted; local `/Users/<you>`
 * bakes intentionally fail so release stays CI-only (#104 / REL-04).
 *
 * This script does NOT push anything anywhere. It produces local artifacts;
 * publishing a release is a separate step handled by CI for dev/main.
 */

import { mkdir, readdir, readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, resolve, join } from 'path';

interface PkgJson {
  name: string;
  version: string;
}

interface PlatformAsset {
  url: string;
  sha256: string;
  size_bytes: number;
}

interface ReleaseManifest {
  version: string;
  channel: 'stable' | 'beta';
  released_at: string;
  notes_url?: string;
  /** Bun version that compiled these binaries — build provenance (see issue #110). */
  bun_version?: string;
  platforms: Record<string, PlatformAsset>;
}

interface Target {
  manifestKey: string;
  bunTarget: string;
  outName: string;
}

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const DIST_DIR = join(PROJECT_ROOT, 'dist');

const TARGETS: Target[] = [
  {
    manifestKey: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    outName: 'privacy-screen-darwin-arm64',
  },
  {
    manifestKey: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    outName: 'privacy-screen-darwin-x64',
  },
  {
    manifestKey: 'win32-x64',
    bunTarget: 'bun-windows-x64',
    outName: 'privacy-screen-win32-x64.exe',
  },
];

async function main(): Promise<void> {
  process.stdout.write('--- build-release ---\n');

  const channel = parseChannel();
  process.stdout.write(`channel: ${channel}\n`);

  const manifestOnly = parseManifestOnly();
  if (manifestOnly) {
    process.stdout.write('manifest-only: will (re)generate manifest from existing dist/ binaries (no web build, no compile)\n');
  }

  const pkg = await readPkg();
  process.stdout.write(`version: ${pkg.version}\n`);

  await ensureDir(DIST_DIR);

  if (!manifestOnly) {
    // 1. Build the web bundle first. The server serves web/dist at runtime;
    //    a release with no UI is useless.
    await runStep('web build', ['bun', 'run', 'web:build']);

    // 1b. Generate the embed manifest so the compiled binaries bake web/dist
    //     into themselves. Without this a downloaded standalone binary has no
    //     UI on disk and shows "web bundle is not built".
    await runStep('embed web', ['bun', 'scripts/generate-web-embed.ts']);

    // 2. Compile each platform target.
    for (const t of TARGETS) {
      const outfile = join(DIST_DIR, t.outName);
      if (existsSync(outfile)) {
        // Remove stale binary so size + hash don't get confused by reuse.
        await Bun.write(outfile, ''); // truncate (Bun has no rm helper here)
      }
      await runStep(
        `compile ${t.manifestKey}`,
        [
          'bun',
          'build',
          '--compile',
          `--target=${t.bunTarget}`,
          'server/server.ts',
          '--outfile',
          outfile,
        ],
      );
    }
    // 2b. Reset the embed manifest to its committed (empty) form so the working
    //     tree stays clean after a build. The compile above already captured the
    //     populated version; the source no longer needs it.
    await runStep('reset embed manifest', ['bun', 'scripts/generate-web-embed.ts', '--empty']);
  } else {
    process.stdout.write('manifest-only: skipping web build and platform compiles\n');
  }

  // 3. Hash (and for non-manifest-only, already compiled) each platform target.
  const platforms: Record<string, PlatformAsset> = {};
  for (const t of TARGETS) {
    const outfile = join(DIST_DIR, t.outName);
    const { sha256, size } = await hashFile(outfile);
    platforms[t.manifestKey] = {
      url: releaseUrl(pkg.version, t.outName),
      sha256,
      size_bytes: size,
    };
    process.stdout.write(`  ${t.manifestKey}: ${sha256} (${size} bytes)\n`);
  }

  // 3. Write manifest.
  const manifest: ReleaseManifest = {
    version: pkg.version,
    channel,
    released_at: new Date().toISOString(),
    notes_url: `https://github.com/adamcongdon/privacy-screen/releases/tag/v${pkg.version}`,
    bun_version: Bun.version,
    platforms,
  };
  const manifestPath = join(DIST_DIR, 'release-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`wrote ${manifestPath}\n`);

  // 4. Desktop installers (best-effort, platform-gated). These are first-install
  //    artifacts and intentionally NOT part of the update manifest above — the
  //    in-app updater swaps the raw binary, it doesn't re-run an installer.
  if (!manifestOnly) {
    await maybeBuildWindowsInstaller(pkg.version);
  }

  // 5. Secret/PII scan gate on shippable artifacts (#104 / REL-04).
  //    Runs on full builds and --manifest-only (post-sign path in release.yml)
  //    so signed binaries are checked before `gh release upload`.
  await scanForSecretsInDist({ distDir: DIST_DIR });

  process.stdout.write('--- done ---\n');
}

/** One denylist hit found inside a release artifact. */
export interface SecretScanHit {
  file: string;
  rule: string;
  /** Truncated match for the error message (never log full secrets in CI noise). */
  snippet: string;
}

export interface SecretScanOptions {
  /** Directory to scan (default: project `dist/`). */
  distDir?: string;
  /**
   * Absolute path prefixes that are safe when baked into binaries
   * (CI runner homes). Defaults cover GitHub Actions linux/mac runners.
   */
  pathAllowlist?: string[];
  /**
   * Full-match value allowlist (exact credential-shaped strings known to be
   * non-secrets — e.g. public AWS docs examples, or documented test ASIA*).
   */
  valueAllowlist?: string[];
  /**
   * Optional allowlist file (one entry per line; `#` comments). Lines that
   * look like paths (start with `/` or a drive letter) extend pathAllowlist;
   * other lines extend valueAllowlist.
   */
  allowlistFile?: string;
}

/** Default CI runner homes — release binaries may embed these source paths. */
export const DEFAULT_SECRET_SCAN_PATH_ALLOWLIST: readonly string[] = [
  '/home/runner/',
  '/Users/runner/',
  '/home/runner',
  '/Users/runner',
];

/**
 * Known non-secret value matches (docs examples / documented test fixtures).
 * Keep this tight — every entry is a deliberate ship exception.
 */
export const DEFAULT_SECRET_SCAN_VALUE_ALLOWLIST: readonly string[] = [
  // AWS docs canonical example access key id.
  'AKIAIOSFODNN7EXAMPLE',
];

/**
 * Denylist rules applied to binary/text contents of shippable dist artifacts.
 * Credential rules require long bodies so detector *literals* in
 * `src/patterns.ts` (e.g. `sk-ant-[A-Za-z0-9\\-_]{20,}`) do not false-positive.
 */
export const SECRET_SCAN_RULES: readonly { name: string; re: RegExp; kind: 'path' | 'cred' }[] = [
  // Fresh RegExp instances are built per scan so /g lastIndex state stays clean.
  { name: 'dev-home-users', re: /\/Users\/[A-Za-z0-9._-]+/g, kind: 'path' },
  { name: 'dev-home-unix', re: /\/home\/[A-Za-z0-9._-]+/g, kind: 'path' },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9\-_]{20,}/g, kind: 'cred' },
  { name: 'github-pat', re: /ghp_[A-Za-z0-9]{20,}/g, kind: 'cred' },
  { name: 'aws-access-key', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, kind: 'cred' },
];

/** Filenames under dist/ that are scanned (binaries + installers). */
export function isSecretScanCandidate(fileName: string): boolean {
  const base = basename(fileName);
  if (base === 'release-manifest.json' || base.endsWith('.json')) return false;
  if (base.startsWith('privacy-screen-')) return true;
  if (base.endsWith('.dmg') || base.endsWith('.exe') || base.endsWith('.pkg')) return true;
  return false;
}

function snippetOf(match: string, max = 48): string {
  if (match.length <= max) return match;
  return `${match.slice(0, max)}…`;
}

function isPathAllowed(match: string, pathAllowlist: string[]): boolean {
  // Rules capture the first path segment only (`/Users/runner`, `/home/runner`).
  // Full baked paths may be longer; allow when the match equals or is a
  // path-prefix of an allowlisted entry (or vice versa for trailing slash).
  for (const raw of pathAllowlist) {
    if (!raw) continue;
    const prefix = raw.replace(/\/$/, '');
    if (match === prefix) return true;
    if (match.startsWith(prefix + '/')) return true;
    if (prefix.startsWith(match + '/')) return true;
  }
  return false;
}

function isValueAllowed(match: string, valueAllowlist: string[]): boolean {
  return valueAllowlist.some((v) => v === match || match.startsWith(v));
}

async function loadAllowlistFile(
  filePath: string | undefined,
): Promise<{ paths: string[]; values: string[] }> {
  const paths: string[] = [];
  const values: string[] = [];
  if (!filePath || !existsSync(filePath)) return { paths, values };
  const raw = await readFile(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) paths.push(t);
    else values.push(t);
  }
  return { paths, values };
}

/**
 * Scan release artifacts under `dist/` for baked developer home paths and
 * long-form credential patterns. Throws on any unallowlisted hit.
 *
 * Designed for TDD: pass a synthetic `distDir` of canary files in tests.
 */
export async function scanForSecretsInDist(opts: SecretScanOptions = {}): Promise<void> {
  const distDir = opts.distDir ?? DIST_DIR;
  process.stdout.write(`[secret-scan] scanning ${distDir}\n`);

  if (!existsSync(distDir)) {
    process.stdout.write('[secret-scan] no dist/ directory — nothing to scan\n');
    return;
  }

  const fromFile = await loadAllowlistFile(
    opts.allowlistFile ?? join(PROJECT_ROOT, '.release-secret-allowlist'),
  );
  const pathAllowlist = [
    ...DEFAULT_SECRET_SCAN_PATH_ALLOWLIST,
    ...(opts.pathAllowlist ?? []),
    ...fromFile.paths,
  ];
  const valueAllowlist = [
    ...DEFAULT_SECRET_SCAN_VALUE_ALLOWLIST,
    ...(opts.valueAllowlist ?? []),
    ...fromFile.values,
  ];

  const names = await readdir(distDir);
  const candidates = names.filter(isSecretScanCandidate);
  if (candidates.length === 0) {
    process.stdout.write('[secret-scan] no candidate artifacts — nothing to scan\n');
    return;
  }

  const hits: SecretScanHit[] = [];

  for (const name of candidates) {
    const filePath = join(distDir, name);
    const st = await stat(filePath);
    if (!st.isFile()) continue;

    // latin1 keeps every byte as a char so binary blobs are searchable as text.
    const content = await readFile(filePath, 'latin1');

    for (const rule of SECRET_SCAN_RULES) {
      // Clone with fresh lastIndex for each file.
      const re = new RegExp(rule.re.source, rule.re.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const match = m[0];
        if (rule.kind === 'path' && isPathAllowed(match, pathAllowlist)) continue;
        if (rule.kind === 'cred' && isValueAllowed(match, valueAllowlist)) continue;
        hits.push({
          file: name,
          rule: rule.name,
          snippet: snippetOf(match),
        });
        // Cap hits per rule/file so one leak doesn't flood the error.
        if (hits.filter((h) => h.file === name && h.rule === rule.name).length >= 5) break;
      }
    }
  }

  if (hits.length === 0) {
    process.stdout.write(
      `[secret-scan] PASS — ${candidates.length} artifact(s), no denylist hits\n`,
    );
    return;
  }

  const detail = hits
    .map((h) => `  - ${h.file}: rule=${h.rule} match=${JSON.stringify(h.snippet)}`)
    .join('\n');
  process.stderr.write(
    `[secret-scan] FAIL — ${hits.length} hit(s) in release artifacts:\n${detail}\n`,
  );
  throw new Error(
    `secret/PII scan gate failed (${hits.length} hit(s)). ` +
      `Remove baked secrets/home paths from the build, or extend ` +
      `.release-secret-allowlist only for known-safe CI paths. ` +
      `First hit: ${hits[0]!.file} / ${hits[0]!.rule}`,
  );
}

/**
 * Build the Windows double-click installer with Inno Setup when its compiler
 * (ISCC.exe) is available. On non-Windows hosts (e.g. the Linux release runner)
 * or when Inno Setup isn't installed, this logs and skips — CI builds the
 * Windows installer in a dedicated windows-latest job instead.
 */
async function maybeBuildWindowsInstaller(version: string): Promise<void> {
  if (process.platform !== 'win32') {
    process.stdout.write('[win-installer] skipped (not a Windows host)\n');
    return;
  }
  const iscc = findIscc();
  if (!iscc) {
    process.stdout.write('[win-installer] skipped (ISCC.exe not found; install Inno Setup 6)\n');
    return;
  }
  const iss = join(PROJECT_ROOT, 'installers', 'windows', 'privacy-screen.iss');
  await runStep('win installer', [iscc, `/DMyAppVersion=${version}`, iss]);
  process.stdout.write(
    `[win-installer] wrote ${join(DIST_DIR, 'privacy-screen-setup-win32-x64.exe')}\n`,
  );
}

/** Locate ISCC.exe in the usual Inno Setup 6 install locations or on PATH. */
function findIscc(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function parseChannel(): 'stable' | 'beta' {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--channel' || a === '-c') {
      const val = args[i + 1];
      if (val === 'beta' || val === 'stable') return val;
      throw new Error(`--channel must be 'stable' or 'beta', got '${val}'`);
    }
    if (a.startsWith('--channel=')) {
      const val = a.slice('--channel='.length);
      if (val === 'beta' || val === 'stable') return val;
      throw new Error(`--channel must be 'stable' or 'beta', got '${val}'`);
    }
  }
  return 'stable';
}

function parseManifestOnly(): boolean {
  const args = process.argv.slice(2);
  return args.includes('--manifest-only') || args.includes('--manifest-only=true');
}

async function readPkg(): Promise<PkgJson> {
  const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).version !== 'string'
  ) {
    throw new Error('package.json missing version field');
  }
  return parsed as PkgJson;
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function runStep(label: string, argv: string[]): Promise<void> {
  process.stdout.write(`[${label}] $ ${argv.join(' ')}\n`);
  const proc = Bun.spawn(argv, {
    cwd: PROJECT_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`[${label}] exited with code ${code}`);
  }
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const buf = await readFile(path);
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(buf);
  const sha256 = hasher.digest('hex');
  const st = await stat(path);
  return { sha256, size: st.size };
}

function releaseUrl(version: string, outName: string): string {
  return `https://github.com/adamcongdon/privacy-screen/releases/download/v${version}/${outName}`;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`build-release failed: ${msg}\n`);
    process.exit(1);
  });
}
