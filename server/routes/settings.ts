/**
 * Settings routes — model preference + system prompt + opt-in update channel.
 *
 * The update_channel / update_manifest_url live in PRIVACY_CONFIG.yaml (the
 * same file that holds mode, customer names, judge config, etc).
 *
 *   GET  /api/settings  — includes update_channel + update_manifest_url
 *   POST /api/settings  — accepts model, system_prompt, update_channel, update_manifest_url
 */

import { Hono } from 'hono';
import { publicSettings, saveSettings } from '../secrets';
import { checkClaudeCode } from '../lib/claude-code-check';
import { loadConfig } from '../../src/config';
import { patchUpdateConfig, type UpdateConfigPatch } from '../lib/config-writer';

export const settingsRoute = new Hono();

settingsRoute.get('/', (c) => {
  const s = publicSettings();
  const cc = checkClaudeCode();
  const cfg = loadConfig();
  return c.json({
    ...s,
    update_channel: cfg.update_channel,
    update_manifest_url: cfg.update_manifest_url,
    claude_code: {
      found: cc.found,
      version: cc.version,
      error: cc.error,
    },
  });
});

settingsRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const partial: Parameters<typeof saveSettings>[0] = {};

  if (typeof body.model === 'string' && body.model.length > 0) {
    partial.model = body.model;
  }
  if (typeof body.system_prompt === 'string') {
    partial.system_prompt = body.system_prompt;
  }

  saveSettings(partial);

  // Handle update prefs (persisted to PRIVACY_CONFIG.yaml)
  const updatePatch: UpdateConfigPatch = {};
  if (typeof body.update_channel === 'string') {
    const ch = body.update_channel;
    if (ch === 'off' || ch === 'stable' || ch === 'beta') {
      updatePatch.update_channel = ch;
    }
  }
  if (typeof body.update_manifest_url === 'string' && body.update_manifest_url.length > 0) {
    updatePatch.update_manifest_url = body.update_manifest_url;
  }
  if (Object.keys(updatePatch).length > 0) {
    patchUpdateConfig(updatePatch);
  }

  const s = publicSettings();
  const cc = checkClaudeCode();
  const cfg = loadConfig();
  return c.json({
    ...s,
    update_channel: cfg.update_channel,
    update_manifest_url: cfg.update_manifest_url,
    claude_code: {
      found: cc.found,
      version: cc.version,
      error: cc.error,
    },
  });
});
