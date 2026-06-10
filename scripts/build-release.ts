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
 * This script does NOT push anything anywhere. It produces local artifacts;
 * publishing a release is a separate step handled by CI for dev/main.
 */

import { mkdir, readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

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

  process.stdout.write('--- done ---\n');
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

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`build-release failed: ${msg}\n`);
  process.exit(1);
});
