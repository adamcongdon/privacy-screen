/**
 * Settings routes — model preference + system prompt only.
 * No API key surface area: inference goes through `claude` CLI (OAuth).
 *
 *   GET  /api/settings  — { model, system_prompt, claude_code: {found, version} }
 *   POST /api/settings  — { model?, system_prompt? }
 */

import { Hono } from 'hono';
import { publicSettings, saveSettings } from '../secrets';
import { checkClaudeCode } from '../lib/claude-code-check';

export const settingsRoute = new Hono();

settingsRoute.get('/', (c) => {
  const s = publicSettings();
  const cc = checkClaudeCode();
  return c.json({
    ...s,
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

  const s = publicSettings();
  const cc = checkClaudeCode();
  return c.json({
    ...s,
    claude_code: {
      found: cc.found,
      version: cc.version,
      error: cc.error,
    },
  });
});
