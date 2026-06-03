/**
 * Claude Code presence check.
 *
 * Required dependency — the app uses `claude` CLI for all inference.
 * If `claude` is not on PATH the server refuses to start.
 */

import { spawnSync } from 'child_process';

export function checkClaudeCode(): { found: boolean; version: string | null; error?: string } {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status === 0) {
      return { found: true, version: r.stdout.trim() };
    }
    return { found: false, version: null, error: r.stderr || `exit ${r.status}` };
  } catch (err) {
    return { found: false, version: null, error: (err as Error).message };
  }
}

export function reportClaudeCodeStatus(): void {
  // Test/CI escape hatch — server-smoke spawns the server on environments
  // (e.g. ubuntu-24.04 runners) where the `claude` CLI isn't installed.
  // The flag is opt-in and only exercises the non-inference surface.
  if (process.env.PRIVACY_SCREEN_SKIP_CLAUDE_CHECK === '1') {
    process.stdout.write(`claude code:       ⊘ check skipped (PRIVACY_SCREEN_SKIP_CLAUDE_CHECK)\n`);
    return;
  }
  const r = checkClaudeCode();
  if (r.found) {
    process.stdout.write(`claude code:       ✓ ${r.version}\n`);
    return;
  }
  process.stderr.write(
    `claude code:       ✗ not found on PATH\n` +
      `\nprivacy-screen requires the \`claude\` CLI (Claude Code) for inference.\n` +
      `Install it from https://docs.claude.com/en/docs/claude-code, run \`claude login\`,\n` +
      `and start privacy-screen again.\n\n`,
  );
  if (r.error) process.stderr.write(`  detail: ${r.error}\n`);
  process.exit(1);
}
