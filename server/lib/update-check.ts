/**
 * Opt-in version check against a static release manifest.
 *
 * What this module does:
 *   - Fetches a single JSON manifest over HTTPS (one GET, no retries).
 *   - Validates its shape (typeof checks, sha256 regex).
 *   - Compares the manifest's version to the running version.
 *   - Returns the matching-platform `UpdateInfo` if newer; otherwise null.
 *
 * What this module DOES NOT do:
 *   - Download any binary.
 *   - Write any file.
 *   - Execute any subprocess.
 *   - Send any user information (no body, no custom headers).
 *
 * The default `platform` is derived from Node-compatible
 * `process.platform`/`process.arch` and mapped onto the manifest's keys
 * (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`).
 *
 * Pure functions only — no top-level side effects.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type UpdateChannel = 'stable' | 'beta';

export interface PlatformAsset {
  url: string;
  sha256: string;
  size_bytes: number;
}

export interface ReleaseManifest {
  version: string;
  channel: string;
  released_at: string;
  notes_url?: string;
  minimum_supported_version?: string;
  platforms: Record<string, PlatformAsset>;
}

export interface UpdateInfo {
  version: string;
  channel: string;
  url: string;
  sha256: string;
  releasedAt: string;
  notesUrl?: string;
}

export interface CheckOptions {
  channel: UpdateChannel;
  manifestUrl: string;
  /** Manifest key, e.g. `darwin-arm64`. Defaults to current platform. */
  platform?: string;
  /** Abort the fetch after this many ms. Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Injectable fetch for tests. Defaults to `globalThis.fetch`.
   * Same shape as the standard fetch (URL, init) → Response.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Compare two `major.minor.patch` strings numerically.
 * Returns -1 if a<b, 0 if equal, 1 if a>b. Pre-release tags are not supported.
 * Invalid input compares as equal (the caller's malformed-input fallback).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] as number;
    const bi = pb[i] as number;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

/**
 * Map `process.platform` + `process.arch` to the manifest's platform keys.
 * Returns null for combinations we don't ship.
 */
export function defaultPlatformKey(): string | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  return null;
}

function isPlatformAsset(v: unknown): v is PlatformAsset {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || o.url.length === 0) return false;
  if (typeof o.sha256 !== 'string' || !SHA256_HEX.test(o.sha256)) return false;
  if (typeof o.size_bytes !== 'number' || !Number.isFinite(o.size_bytes) || o.size_bytes < 0) {
    return false;
  }
  return true;
}

function isReleaseManifest(v: unknown): v is ReleaseManifest {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== 'string' || o.version.length === 0) return false;
  if (typeof o.channel !== 'string' || o.channel.length === 0) return false;
  if (typeof o.released_at !== 'string' || o.released_at.length === 0) return false;
  if (o.notes_url !== undefined && typeof o.notes_url !== 'string') return false;
  if (
    o.minimum_supported_version !== undefined &&
    typeof o.minimum_supported_version !== 'string'
  ) {
    return false;
  }
  if (!o.platforms || typeof o.platforms !== 'object') return false;
  // Reject the whole manifest if ANY platform entry is malformed —
  // we'd rather refuse than partially trust.
  for (const [, asset] of Object.entries(o.platforms as Record<string, unknown>)) {
    if (!isPlatformAsset(asset)) return false;
  }
  return true;
}

/**
 * Check the configured manifest URL for a newer release on this platform.
 *
 * Returns:
 *   - `UpdateInfo` if the manifest's version is strictly newer than
 *     `currentVersion` AND the channel matches AND the manifest carries
 *     an entry for our platform.
 *   - `null` for every other outcome: equal versions, older manifest
 *     (no downgrades), wrong channel, missing platform, malformed
 *     manifest, network error, timeout.
 *
 * This function NEVER throws to the caller — failure is `null`. That keeps
 * the route handler simple: an offline user gets "no update", not a 500.
 */
export async function checkForUpdate(
  currentVersion: string,
  opts: CheckOptions,
): Promise<UpdateInfo | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const platformKey = opts.platform ?? defaultPlatformKey();
  if (!platformKey) return null;

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let manifest: ReleaseManifest;
  try {
    const res = await fetchImpl(opts.manifestUrl, {
      method: 'GET',
      signal: controller.signal,
      // Explicitly: no custom headers, no body, no credentials.
      // We send nothing about this machine beyond what an anonymous
      // GET inherently reveals to the host.
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!isReleaseManifest(raw)) return null;
    manifest = raw;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Channel must match. A `beta` channel client should not auto-surface
  // `stable` releases (the user picked beta intentionally).
  if (manifest.channel !== opts.channel) return null;

  // Strictly newer only. Equal or older → null. We never recommend a
  // downgrade.
  const cmp = compareVersions(manifest.version, currentVersion);
  if (cmp !== 1) return null;

  const asset = manifest.platforms[platformKey];
  if (!asset) return null;

  return {
    version: manifest.version,
    channel: manifest.channel,
    url: asset.url,
    sha256: asset.sha256,
    releasedAt: manifest.released_at,
    notesUrl: manifest.notes_url,
  };
}
