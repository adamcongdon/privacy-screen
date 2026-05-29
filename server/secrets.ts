/**
 * App settings storage.
 *
 * After the 2026-05-29 pivot, the app uses the `claude` CLI for inference,
 * so there is NO API key here. Settings are limited to model preference and
 * an optional system prompt.
 *
 * Stored at $HOME/.privacy-screen/settings.json with mode 0600. No env-var
 * fallback — there's nothing sensitive to keep out of disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface AppSettings {
  /** Model alias or full id passed to `claude --model`. Default 'sonnet'. */
  model?: string;
  /** Optional system prompt prepended via `claude --append-system-prompt`. */
  system_prompt?: string;
}

const DEFAULT_MODEL = 'sonnet';

function settingsPath(): string {
  return join(homedir(), '.privacy-screen', 'settings.json');
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadSettings(): AppSettings {
  const p = settingsPath();
  if (!existsSync(p)) return { model: DEFAULT_MODEL };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppSettings;
    return {
      model: raw.model ?? DEFAULT_MODEL,
      system_prompt: raw.system_prompt,
    };
  } catch (err) {
    process.stderr.write(`[privacy-screen] settings.json parse error: ${err}\n`);
    return { model: DEFAULT_MODEL };
  }
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const p = settingsPath();
  ensureDir(p);
  const existing = existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf-8')) as AppSettings)
    : {};
  const next: AppSettings = { ...existing, ...partial };
  writeFileSync(p, JSON.stringify(next, null, 2));
  chmodSync(p, 0o600);
  return loadSettings();
}

/**
 * Sanitized view safe to serialize to the renderer.
 */
export function publicSettings(): {
  model: string;
  system_prompt: string;
} {
  const s = loadSettings();
  return {
    model: s.model ?? DEFAULT_MODEL,
    system_prompt: s.system_prompt ?? '',
  };
}
