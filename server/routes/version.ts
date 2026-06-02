/**
 * GET /api/version — current version + opt-in update check.
 *
 * Behavior:
 *   - Always returns the running version (from package.json).
 *   - If `update_channel === 'off'`: no network activity, returns
 *     `updateAvailable: false`, `updateInfo: null`, `latestKnown: null`.
 *   - Otherwise: performs a single HTTPS GET against `update_manifest_url`
 *     via `checkForUpdate()`. If newer, surfaces the matching platform's
 *     UpdateInfo. Network errors degrade to `error: 'unreachable'` with
 *     `updateAvailable: false` — never a 5xx.
 *
 * The check sends no telemetry. See server/lib/update-check.ts.
 */

import { Hono } from 'hono';
import pkg from '../../package.json' with { type: 'json' };
import { loadConfig } from '../../src/config';
import { checkForUpdate, type UpdateInfo } from '../lib/update-check';

export const versionRoute = new Hono();

interface VersionResponse {
  version: string;
  channel: string;
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  latestKnown: string | null;
  error?: 'unreachable';
}

versionRoute.get('/', async (c) => {
  const version = pkg.version;
  const cfg = loadConfig();

  if (cfg.update_channel === 'off') {
    const body: VersionResponse = {
      version,
      channel: 'off',
      updateAvailable: false,
      updateInfo: null,
      latestKnown: null,
    };
    return c.json(body);
  }

  try {
    const info = await checkForUpdate(version, {
      channel: cfg.update_channel,
      manifestUrl: cfg.update_manifest_url,
    });
    const body: VersionResponse = {
      version,
      channel: cfg.update_channel,
      updateAvailable: info !== null,
      updateInfo: info,
      latestKnown: info?.version ?? null,
    };
    return c.json(body);
  } catch {
    // checkForUpdate is supposed to swallow its own errors, but if it
    // ever escapes one (e.g. a future change), we still degrade
    // gracefully rather than 500ing.
    const body: VersionResponse = {
      version,
      channel: cfg.update_channel,
      updateAvailable: false,
      updateInfo: null,
      latestKnown: null,
      error: 'unreachable',
    };
    return c.json(body);
  }
});
