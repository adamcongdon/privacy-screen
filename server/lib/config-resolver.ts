/**
 * Resolve the absolute path of PRIVACY_CONFIG.yaml *for writing*.
 *
 * Must agree with `src/config.ts` `findConfigPath` (the reader) so a saved
 * setting is read back from the same file. Returns the path even when the file
 * does not yet exist, so the writer can create it. Order:
 *   1. $PRIVACY_SCREEN_CONFIG (explicit override)
 *   2. ./PRIVACY_CONFIG.yaml (relative to CWD) — dev workflow
 *   3. $HOME/.privacy-screen/PRIVACY_CONFIG.yaml — canonical writable user-data
 *      location for the installed app.
 *
 * The previous final fallback (`import.meta.dir/../../PRIVACY_CONFIG.yaml`) was
 * the root cause of "settings save failed: internal server error": in the
 * bundled binary that path resolves into a read-only virtual filesystem, so
 * every writeFileSync threw and every settings/judge/update write 500'd.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { userConfigPath } from '../../src/config';

export function resolveConfigPath(): string {
  if (process.env.PRIVACY_SCREEN_CONFIG) return process.env.PRIVACY_SCREEN_CONFIG;
  const cwdPath = join(process.cwd(), 'PRIVACY_CONFIG.yaml');
  if (existsSync(cwdPath)) return cwdPath;
  // Writable, persistent user-data location — never a read-only bundled path.
  return userConfigPath();
}
