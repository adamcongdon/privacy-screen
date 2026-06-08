/**
 * Opt-in background download + verified staging + self-apply for app binaries.
 *
 * Mirrors the design and spirit of the judge model installer (server/routes/judge-control.ts)
 * but adds:
 *  - Strict re-validation against the live manifest (via update-check)
 *  - SHA256 verification of the downloaded asset (content-addressed)
 *  - Staging to ~/.privacy-screen/updates/ with sidecar metadata (survives restarts)
 *  - Explicit one-click apply that attempts atomic replace + detached relaunch
 *
 * Security / local-first:
 *  - Never auto-starts a download. Only on explicit POST /api/update/download
 *  - Never auto-applies. Apply is a separate explicit action.
 *  - Always verifies the sha256 from the *manifest* before considering the bytes good.
 *  - No telemetry on the download (plain fetch to the release asset URL).
 *  - HTTPS only (enforced by manifest + fetch).
 *
 * Dev vs release:
 *  - When running under the bun runtime (bun server/server.ts or `bun run start`),
 *    we download+stage but refuse to clobber the bun binary on apply. The staged
 *    file is left for manual testing.
 */

import { existsSync, mkdirSync, renameSync, chmodSync, unlinkSync, createWriteStream, readFileSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { spawn as nodeSpawn } from 'child_process';

import {
  checkForUpdate,
  defaultPlatformKey,
  type UpdateInfo,
} from './update-check';
import { loadConfig } from '../../src/config';

export interface UpdateDownloadState {
  active: boolean;
  version: string | null;
  channel: string | null;
  bytesDownloaded: number;
  totalBytes: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  stagedPath: string | null;
  sha256: string | null; // expected from manifest
}

export interface UpdateStatus {
  currentVersion: string;
  platform: string | null;
  /** From the most recent successful /api/version-style check or download attempt */
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  download: UpdateDownloadState;
  /** If a verified staged binary exists and is newer than current */
  readyToApply: boolean;
  /** Helpful for UX / diagnostics */
  currentExePath: string;
  /** Whether the current runtime looks like a release binary (not the bun dev runtime) */
  canAutoApply: boolean;
}

let downloadState: UpdateDownloadState = resetDownloadState();
let lastSeenUpdateInfo: UpdateInfo | null = null;

function resetDownloadState(): UpdateDownloadState {
  return {
    active: false,
    version: null,
    channel: null,
    bytesDownloaded: 0,
    totalBytes: 0,
    startedAt: 0,
    finishedAt: null,
    error: null,
    stagedPath: null,
    sha256: null,
  };
}

function updatesDir(): string {
  return join(homedir(), '.privacy-screen', 'updates');
}

function pendingBinaryPath(platformKey: string): string {
  return join(updatesDir(), `pending-${platformKey}`);
}

function pendingSidecarPath(platformKey: string): string {
  return join(updatesDir(), `pending-${platformKey}.json`);
}

function getCurrentVersion(): string {
  // Same source of truth the /api/version route uses.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

function getCurrentExePath(): string {
  return process.execPath;
}

function isDevBunRuntime(exePath: string): boolean {
  const p = exePath.toLowerCase();
  return p.endsWith('/bun') || p.endsWith('\\bun') || p.endsWith('bun.exe');
}

function readSidecar(platformKey: string): { version: string; sha256: string; channel?: string } | null {
  const p = pendingSidecarPath(platformKey);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.version === 'string' && typeof data.sha256 === 'string') {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

function writeSidecar(platformKey: string, info: { version: string; sha256: string; channel: string }): void {
  const p = pendingSidecarPath(platformKey);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Use sync write for simplicity (small JSON); called from background path.
  writeFileSync(p, JSON.stringify(info, null, 2) + '\n');
}

export function getUpdateStatus(): UpdateStatus {
  const currentVersion = getCurrentVersion();
  const platform = defaultPlatformKey();
  const exe = getCurrentExePath();
  const canAuto = !isDevBunRuntime(exe);

  // If we have a sidecar on disk, surface a ready update even if this process
  // never did the download (e.g. previous run downloaded, this run is fresh).
  let ready = false;
  let effectiveUpdateInfo = lastSeenUpdateInfo;

  if (platform) {
    const side = readSidecar(platform);
    if (side && side.version) {
      // Treat a present sidecar as "there is a candidate". The apply path will
      // do the final version comparison + hash re-check.
      ready = true;
      if (!effectiveUpdateInfo) {
        effectiveUpdateInfo = {
          version: side.version,
          channel: side.channel ?? 'stable',
          url: '', // not needed for already-staged
          sha256: side.sha256,
          releasedAt: '',
        };
      }
    }
  }

  return {
    currentVersion,
    platform,
    updateAvailable: !!effectiveUpdateInfo,
    updateInfo: effectiveUpdateInfo,
    download: { ...downloadState },
    readyToApply: ready,
    currentExePath: exe,
    canAutoApply: canAuto,
  };
}

/**
 * Start (or no-op if already) a background download of the newest update for the
 * configured channel. Returns immediately (202 semantics); progress is observed
 * via getUpdateStatus().
 */
export async function startUpdateDownload(): Promise<{ ok: true; status: UpdateStatus } | { error: string }> {
  if (downloadState.active) {
    return { error: 'download already in progress' };
  }

  const cfg = loadConfig();
  if (cfg.update_channel === 'off') {
    return { error: 'update_channel is off; enable stable or beta first' };
  }

  const currentVersion = getCurrentVersion();
  const platformKey = defaultPlatformKey();
  if (!platformKey) {
    return { error: 'unsupported platform for auto-update' };
  }

  // Re-check the manifest to get an authoritative target (prevents client lying
  // about a different version/sha and ensures we only ever fetch what the
  // channel manifest advertises).
  let info: UpdateInfo | null;
  try {
    info = await checkForUpdate(currentVersion, {
      channel: cfg.update_channel,
      manifestUrl: cfg.update_manifest_url,
      platform: platformKey,
      timeoutMs: 8000,
    });
  } catch (e) {
    return { error: `manifest check failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!info) {
    return { error: 'no newer release available for this channel and platform' };
  }

  // Prepare staging dir
  const dir = updatesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const destPath = pendingBinaryPath(platformKey);
  const partPath = destPath + '.part';

  // Reset state and kick off the fetch
  downloadState = {
    active: true,
    version: info.version,
    channel: info.channel,
    bytesDownloaded: 0,
    totalBytes: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    stagedPath: destPath,
    sha256: info.sha256,
  };
  lastSeenUpdateInfo = info;

  // Fire and forget the actual transfer + verify
  void runDownload(info, partPath, destPath, platformKey);

  return { ok: true as const, status: getUpdateStatus() };
}

async function runDownload(
  info: UpdateInfo,
  partPath: string,
  finalPath: string,
  platformKey: string,
): Promise<void> {
  const url = info.url;
  const expectedSha = info.sha256.toLowerCase();

  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > 0) {
      downloadState = { ...downloadState, totalBytes: contentLength };
    }

    const hasher = new Bun.CryptoHasher('sha256');
    const ws = createWriteStream(partPath);
    const reader = res.body.getReader();
    let received = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        hasher.update(value);
        ws.write(Buffer.from(value));
        received += value.byteLength;
        downloadState = { ...downloadState, bytesDownloaded: received };
      }
    }

    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end();
    });

    // Verify hash (reliable even if content-length lied)
    const actualSha = hasher.digest('hex').toLowerCase();
    if (actualSha !== expectedSha) {
      try { unlinkSync(partPath); } catch {}
      throw new Error(`sha256 mismatch: got ${actualSha} expected ${expectedSha}`);
    }

    // Atomic move into final pending location
    if (existsSync(finalPath)) {
      try { unlinkSync(finalPath); } catch {}
    }
    renameSync(partPath, finalPath);
    chmodSync(finalPath, 0o755);

    // Write sidecar so a future server process can see the pending update
    writeSidecar(platformKey, {
      version: info.version,
      sha256: expectedSha,
      channel: info.channel,
    });

    downloadState = {
      ...downloadState,
      active: false,
      finishedAt: Date.now(),
      bytesDownloaded: received,
      error: null,
    };

    process.stderr.write(
      `[privacy-screen] update downloaded+verified: v${info.version} (${info.channel}) -> ${finalPath}\n`,
    );
  } catch (err) {
    // Clean partial
    try { unlinkSync(partPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    downloadState = {
      ...downloadState,
      active: false,
      finishedAt: Date.now(),
      error: msg,
    };
    process.stderr.write(`[privacy-screen] update download failed: ${msg}\n`);
  }
}

/**
 * Apply a staged update (if ready).
 * On success for a release binary: renames current -> .old, pending -> current,
 * spawns the new binary detached, then the caller should shut down this process.
 *
 * Returns a result object; the caller decides on process exit timing so the
 * HTTP response can be sent first.
 */
export async function applyStagedUpdate(): Promise<
  | { applied: true; restarted: boolean; oldPath: string; newPath: string }
  | { applied: false; reason: string; message: string; stagedPath?: string }
> {
  const platformKey = defaultPlatformKey();
  if (!platformKey) {
    return { applied: false, reason: 'unsupported-platform', message: 'No platform key' };
  }

  const currentVersion = getCurrentVersion();
  const currentPath = getCurrentExePath();
  const pendingPath = pendingBinaryPath(platformKey);
  const sidecar = readSidecar(platformKey);

  if (!existsSync(pendingPath)) {
    return {
      applied: false,
      reason: 'no-staged-binary',
      message: 'No downloaded update found. Start a download first.',
      stagedPath: pendingPath,
    };
  }

  if (!sidecar) {
    return {
      applied: false,
      reason: 'no-sidecar',
      message: 'Staged binary is missing metadata. Re-download the update.',
    };
  }

  // Re-verify the on-disk sha matches the sidecar expectation (defense in depth)
  try {
    const buf = await readFile(pendingPath);
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(buf);
    const onDisk = hasher.digest('hex').toLowerCase();
    if (onDisk !== sidecar.sha256.toLowerCase()) {
      return {
        applied: false,
        reason: 'staged-sha-mismatch',
        message: 'Staged file failed SHA verification. Delete it and download again.',
        stagedPath: pendingPath,
      };
    }
  } catch (e) {
    return {
      applied: false,
      reason: 'staged-read-failed',
      message: `Could not read staged file: ${e instanceof Error ? e.message : e}`,
    };
  }

  // If the staged version is not actually newer, refuse (shouldn't happen)
  const cmp = (await import('./update-check')).compareVersions(sidecar.version, currentVersion);
  if (cmp !== 1) {
    return {
      applied: false,
      reason: 'not-newer',
      message: `Staged v${sidecar.version} is not newer than running v${currentVersion}.`,
    };
  }

  if (isDevBunRuntime(currentPath)) {
    // Leave the file; tell the caller where it is.
    return {
      applied: false,
      reason: 'dev-runtime',
      message:
        'Running under the Bun dev runtime. The update was staged but we will not replace the bun binary. ' +
        `Launch the new binary directly: ${pendingPath}`,
      stagedPath: pendingPath,
    };
  }

  // --- Perform the self-replace ---
  const oldPath = currentPath + '.old';
  try {
    if (existsSync(oldPath)) unlinkSync(oldPath);
  } catch {
    // best effort
  }

  try {
    renameSync(currentPath, oldPath);
    renameSync(pendingPath, currentPath);
    chmodSync(currentPath, 0o755);

    // Best-effort sidecar cleanup (the old .old binary is left for manual rollback)
    try {
      unlinkSync(pendingSidecarPath(platformKey));
    } catch {}

    // Spawn the replacement (now living at the original launch path) with the
    // same argv tail and environment. Detached so it survives our exit.
    const args = process.argv.slice(1);
    const child = nodeSpawn(currentPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: process.env as NodeJS.ProcessEnv,
    });
    child.unref();

    process.stderr.write(
      `[privacy-screen] update applied: v${sidecar.version} replacing ${currentPath}; spawned pid ${child.pid}\n`,
    );

    // Reset our local state so a future status call in the dying process is sane
    downloadState = resetDownloadState();
    lastSeenUpdateInfo = null;

    return {
      applied: true,
      restarted: true,
      oldPath,
      newPath: currentPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Attempt to restore if we got part-way
    try {
      if (existsSync(oldPath) && !existsSync(currentPath)) {
        renameSync(oldPath, currentPath);
      }
    } catch {}
    return {
      applied: false,
      reason: 'replace-failed',
      message: `Self-replace failed: ${msg}. The new binary is at ${pendingPath}. You can manually replace ${currentPath}.`,
      stagedPath: pendingPath,
    };
  }
}

