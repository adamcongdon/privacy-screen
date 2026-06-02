#!/usr/bin/env bun
/**
 * Build single-file binaries + a matching release manifest.
 *
 * Run from project root:
 *   bun scripts/build-release.ts
 *
 * Outputs:
 *   dist/privacy-screen-darwin-arm64
 *   dist/privacy-screen-darwin-x64
 *   dist/privacy-screen-win32-x64.exe
 *   dist/release-manifest.json
 *
 * This script does NOT push anything anywhere. It produces local artifacts;
 * publishing a release is a separate, deliberate human step. See
 * Plans/INSTALLER.md.
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

  const pkg = await readPkg();
  process.stdout.write(`version: ${pkg.version}\n`);

  await ensureDir(DIST_DIR);

  // 1. Build the web bundle first. The server serves web/dist at runtime;
  //    a release with no UI is useless.
  await runStep('web build', ['bun', 'run', 'web:build']);

  // 2. Compile each platform target.
  const platforms: Record<string, PlatformAsset> = {};
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
    channel: 'stable',
    released_at: new Date().toISOString(),
    notes_url: `https://github.com/adamcongdon/privacy-screen/releases/tag/v${pkg.version}`,
    platforms,
  };
  const manifestPath = join(DIST_DIR, 'release-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`wrote ${manifestPath}\n`);
  process.stdout.write('--- done ---\n');
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
