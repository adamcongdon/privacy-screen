/**
 * Resolve the absolute path of PRIVACY_CONFIG.yaml.
 *
 * Mirrors the resolution order in `src/config.ts` `findConfigPath` but
 * returns the path even when the file does not yet exist, so the writer
 * can create it. Order:
 *   1. $PRIVACY_SCREEN_CONFIG (explicit override)
 *   2. ./PRIVACY_CONFIG.yaml (relative to CWD)
 *   3. <project_root>/PRIVACY_CONFIG.yaml (relative to src/config.ts)
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';

export function resolveConfigPath(): string {
  if (process.env.PRIVACY_SCREEN_CONFIG) return process.env.PRIVACY_SCREEN_CONFIG;
  const cwdPath = join(process.cwd(), 'PRIVACY_CONFIG.yaml');
  if (existsSync(cwdPath)) return cwdPath;
  // Project root — two levels up from this file (server/lib → repo root)
  return resolve(import.meta.dir, '..', '..', 'PRIVACY_CONFIG.yaml');
}
