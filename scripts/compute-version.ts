#!/usr/bin/env bun
/**
 * Compute the next release version for the given channel based on existing
 * git tags. Source of truth = git tags; package.json is treated as a floor
 * only (used when it declares a base higher than every existing tag).
 *
 * Usage:
 *   bun scripts/compute-version.ts beta
 *   bun scripts/compute-version.ts stable
 *
 * Output: the next tag string (with leading "v") to stdout. Nothing else.
 * On error: non-zero exit code + message to stderr.
 *
 * Rules:
 *   beta channel:
 *     - Find the highest existing v*-beta.* tag (semver-sorted).
 *     - If none: emit v{pkg.version-base}-beta.1.
 *     - If pkg.version-base > highest.base: emit v{pkg.version-base}-beta.1
 *       (deliberate base bump via package.json).
 *     - Otherwise: emit v{highest.base}-beta.{highest.n+1}.
 *   stable channel (the next stable is the greatest of these floors):
 *     - stable auto-increment: highest v* non-beta tag with patch+1 (or none).
 *     - beta-line base: the base of the highest v*-beta.* tag. This is what
 *       makes "promote a tested beta" cut the RIGHT stable — promoting
 *       v1.0.0-beta.53 must yield v1.0.0 even though the newest stable tag is
 *       still v0.0.4 (betas ran ahead of stable during pre-1.0 development).
 *       (#142-era release-workflow work: beta is the dev line, main is prod.)
 *     - package.json base: the declared floor.
 *     Take the greatest of the three by semver.
 *
 * Final sanity check: the computed version must be strictly greater (by
 * semver) than every existing tag in the channel. If not, throw / exit non-zero.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Channel = 'beta' | 'stable';
export type Semver = {
  major: number;
  minor: number;
  patch: number;
  beta: number | null;
};

export function parse(s: string): Semver | null {
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    beta: m[4] !== undefined ? Number(m[4]) : null,
  };
}

export function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.beta === null && b.beta === null) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta - b.beta;
}

export function fmt(v: Semver): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.beta !== null ? `${core}-beta.${v.beta}` : core;
}

export function base(v: Semver): Semver {
  return { major: v.major, minor: v.minor, patch: v.patch, beta: null };
}

/**
 * Pure version computation — no IO. `allTags` is every `v*` tag (any channel);
 * `pkgVersion` is package.json's `version`. Returns the next tag string (with a
 * leading "v"). Throws on an invalid pkg version or if the result would not be
 * strictly greater than every existing same-channel tag.
 */
export function computeNextVersion(
  channel: Channel,
  allTags: string[],
  pkgVersion: string,
): string {
  const allParsed = allTags
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parse)
    .filter((v): v is Semver => v !== null);

  const declared = parse(pkgVersion);
  if (!declared) {
    throw new Error(`Invalid package.json version: ${pkgVersion}`);
  }
  const declaredBase = base(declared);

  const channelTags = allParsed.filter((v) =>
    channel === 'beta' ? v.beta !== null : v.beta === null,
  );
  channelTags.sort(cmp);
  const highest =
    channelTags.length > 0 ? channelTags[channelTags.length - 1]! : null;

  let next: Semver;

  if (channel === 'beta') {
    const auto: Semver | null = highest
      ? { ...highest, beta: (highest.beta as number) + 1 }
      : null;
    const floor: Semver = { ...declaredBase, beta: 1 };
    if (!auto) next = floor;
    else if (cmp(base(floor), base(auto)) > 0) next = floor;
    else next = auto;
  } else {
    // Stable = the greatest of three floors (see doc comment): the stable
    // auto-increment, the highest beta-line base, and the package.json base.
    const stableAuto: Semver | null = highest
      ? { ...highest, patch: highest.patch + 1 }
      : null;

    const betaBases = allParsed
      .filter((v) => v.beta !== null)
      .map(base)
      .sort(cmp);
    const highestBetaBase =
      betaBases.length > 0 ? betaBases[betaBases.length - 1]! : null;

    const candidates: Semver[] = [stableAuto, highestBetaBase, declaredBase].filter(
      (v): v is Semver => v !== null,
    );
    next = candidates.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
  }

  for (const t of channelTags) {
    if (cmp(next, t) <= 0) {
      throw new Error(
        `Computed next v${fmt(next)} is not strictly greater than existing v${fmt(t)}`,
      );
    }
  }

  return `v${fmt(next)}`;
}

// ── CLI wrapper (only runs when invoked directly, not when imported by tests) ──
if (import.meta.main) {
  const channel = process.argv[2] as Channel | undefined;
  if (channel !== 'beta' && channel !== 'stable') {
    process.stderr.write('Usage: compute-version.ts <beta|stable>\n');
    process.exit(2);
  }

  try {
    execSync('git fetch --tags --quiet', { stdio: 'pipe' });
  } catch {
    // Best-effort: when offline or no remote, fall back to local tags.
  }

  const tagsRaw = execSync("git tag -l 'v*'", { encoding: 'utf8' });
  const allTags = tagsRaw.split('\n');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  try {
    process.stdout.write(`${computeNextVersion(channel, allTags, pkg.version)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    // Preserve the historical exit codes so CI signalling is unchanged.
    if (msg.startsWith('Invalid package.json version')) process.exit(3);
    if (msg.includes('not strictly greater')) process.exit(4);
    process.exit(1);
  }
}
