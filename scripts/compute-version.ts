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
 *   stable channel:
 *     - Find the highest existing v* tag with no -beta suffix.
 *     - If none: emit v{pkg.version-base}.
 *     - If pkg.version-base > highest: emit v{pkg.version-base}.
 *     - Otherwise: emit v{major}.{minor}.{patch+1}.
 *
 * Final sanity check: the computed version must be strictly greater (by
 * semver) than every existing tag in the channel. If not, exit non-zero.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Channel = 'beta' | 'stable';
type Semver = { major: number; minor: number; patch: number; beta: number | null };

const channel = process.argv[2] as Channel | undefined;
if (channel !== 'beta' && channel !== 'stable') {
  process.stderr.write('Usage: compute-version.ts <beta|stable>\n');
  process.exit(2);
}

function parse(s: string): Semver | null {
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    beta: m[4] !== undefined ? Number(m[4]) : null,
  };
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.beta === null && b.beta === null) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta - b.beta;
}

function fmt(v: Semver): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.beta !== null ? `${core}-beta.${v.beta}` : core;
}

function base(v: Semver): Semver {
  return { major: v.major, minor: v.minor, patch: v.patch, beta: null };
}

try {
  execSync('git fetch --tags --quiet', { stdio: 'pipe' });
} catch {
  // Best-effort: when offline or no remote, fall back to local tags.
}

const tagsRaw = execSync("git tag -l 'v*'", { encoding: 'utf8' });
const allParsed = tagsRaw
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .map(parse)
  .filter((v): v is Semver => v !== null);

const channelTags = allParsed.filter((v) =>
  channel === 'beta' ? v.beta !== null : v.beta === null,
);
channelTags.sort(cmp);
const highest = channelTags.length > 0 ? channelTags[channelTags.length - 1] : null;

const pkgRaw = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(pkgRaw) as { version: string };
const declared = parse(pkg.version);
if (!declared) {
  process.stderr.write(`Invalid package.json version: ${pkg.version}\n`);
  process.exit(3);
}
const declaredBase = base(declared);

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
  const auto: Semver | null = highest ? { ...highest, patch: highest.patch + 1 } : null;
  const floor: Semver = declaredBase;
  if (!auto) next = floor;
  else if (cmp(floor, auto) > 0) next = floor;
  else next = auto;
}

for (const t of channelTags) {
  if (cmp(next, t) <= 0) {
    process.stderr.write(
      `Computed next v${fmt(next)} is not strictly greater than existing v${fmt(t)}\n`,
    );
    process.exit(4);
  }
}

process.stdout.write(`v${fmt(next)}\n`);
