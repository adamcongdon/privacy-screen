/**
 * End-to-end hook contract tests.
 *
 * Spawns the actual hook binary (bun hooks/PrivacyScreen.hook.ts) as a child
 * process, pipes synthetic Claude Code event payloads into stdin, and
 * verifies the stdout/stderr/exit-code response against the Claude Code
 * hook contract (https://code.claude.com/docs/en/hooks.md).
 *
 * Each test gets its own temp DB + temp config so they're isolated.
 * The hook auto-creates the parent directory of db_path on first use.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = new URL('../hooks/PrivacyScreen.hook.ts', import.meta.url).pathname;

interface HookOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
}

let workDir: string;
let configPath: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-hook-'));
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  dbPath = join(workDir, 'vocab.db');
  writeFile('enforce');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeFile(mode: 'enforce' | 'observe' | 'disabled', extras = ''): void {
  writeFileSync(
    configPath,
    `mode: ${mode}\ndb_path: ${dbPath}\ncustomer_names:\n  - "Acme Corp"\n${extras}`,
  );
}

async function runHook(payload: object): Promise<HookOutput> {
  const proc = Bun.spawn(['bun', HOOK_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PRIVACY_SCREEN_CONFIG: configPath },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let parsed: unknown = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout.trim()); } catch { /* leave null */ }
  }
  return { exitCode, stdout, stderr, parsed };
}

/** Like runHook but pipes a raw string to stdin (for invalid-JSON / oversized cases). */
async function runHookRaw(rawStdin: string): Promise<HookOutput> {
  const proc = Bun.spawn(['bun', HOOK_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PRIVACY_SCREEN_CONFIG: configPath },
  });
  proc.stdin.write(rawStdin);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  let parsed: unknown = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout.trim()); } catch { /* leave null */ }
  }
  return { exitCode, stdout, stderr, parsed };
}

// ── UserPromptSubmit ──────────────────────────────────────────────────────────

describe('hook contract — UserPromptSubmit', () => {
  test('clean prompt produces no output (allow)', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'What is the weather today?',
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  test('IP in prompt → block with scrubbed suggestion', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Server 10.99.88.77 is down',
    });
    expect(out.exitCode).toBe(0);
    expect(out.parsed).toMatchObject({ decision: 'block' });
    const reason = (out.parsed as { reason: string }).reason;
    expect(reason).toContain('{IP}');
    // ISC-18: hook BLOCK includes the canonical findings-preview phrase
    expect(reason).toContain('Double check it for sensitive data, personal data, PII');
    // ISC-19: findings enumerated as category×count
    expect(reason).toMatch(/IP\s*×\s*1/);
  });

  test('customer name from config → block', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Acme Corp is having issues',
    });
    expect(out.parsed).toMatchObject({ decision: 'block' });
    const reason = (out.parsed as { reason: string }).reason;
    expect(reason).toContain('{CUSTOMER}');
    // ISC-18 + ISC-19
    expect(reason).toContain('Double check it for sensitive data, personal data, PII');
    expect(reason).toMatch(/CUSTOMER\s*×\s*1/);
  });

  test('credential in prompt → block with credential warning', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa_z to call',
    });
    expect(out.parsed).toMatchObject({ decision: 'block' });
    expect((out.parsed as { reason: string }).reason).toContain('CREDENTIAL');
  });

  test('short prompt (under 4 chars) is ignored', async () => {
    writeFile('enforce');
    const out = await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    expect(out.stdout.trim()).toBe('');
  });
});

// ── PreToolUse ────────────────────────────────────────────────────────────────

describe('hook contract — PreToolUse', () => {
  test('Bash with IP → updatedInput with token', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ping 10.55.44.33' },
    });
    expect(out.exitCode).toBe(0);
    expect(out.parsed).toMatchObject({
      hookSpecificOutput: { updatedInput: { command: expect.stringContaining('{IP') } },
    });
    expect(JSON.stringify(out.parsed)).not.toContain('10.55.44.33');
  });

  // HOOK-05 (#97): the mutation envelope must carry the full documented schema
  // fields (hookEventName + permissionDecision), not just updatedInput, so a
  // schema-validating CC version applies the scrubbed input instead of
  // silently running the original (invisible fail-open on contract drift).
  test('PreToolUse mutation envelope carries full documented schema', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ping 10.55.44.33' },
    });
    expect(out.parsed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: expect.stringContaining('{IP') },
      },
    });
  });

  test('Bash with credential → exit 2 (block)', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "X: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12" url' },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('CREDENTIAL');
  });

  test('Edit old_string with PII is PRESERVED (not scrubbed)', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/path/to/log.txt',
        old_string: 'connection from 10.22.33.44 failed',
        new_string: 'connection from 10.22.33.44 succeeded',
      },
    });
    // file_path has no PII; old_string/new_string preserved by skip_scrub_fields
    // If no field changes, hook emits no output.
    expect(out.stdout.trim()).toBe('');
  });

  test('Edit with credential in old_string → still blocks', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/tmp/.env',
        old_string: 'API_KEY=AKIAIOSFODNN7EXAMPLE',
        new_string: 'API_KEY=NEW_KEY',
      },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('CREDENTIAL');
  });

  test('clean Bash command → no output', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
    });
    expect(out.stdout.trim()).toBe('');
  });

  test('Grep pattern is preserved (skip_scrub_fields)', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: '10.0.0.1', path: '/var/log' },
    });
    expect(out.stdout.trim()).toBe('');
  });
});

// ── PostToolUse ───────────────────────────────────────────────────────────────

describe('hook contract — PostToolUse', () => {
  test('credential in output → exit 2', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_result: 'GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12',
    });
    expect(out.exitCode).toBe(2);
  });

  test('PII in output → stderr warning, no stdout block', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_result: 'server is at 10.66.77.88 with admin@customer.local',
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(out.stderr).toContain('PII');
  });

  test('clean output → silent', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_result: 'No findings.',
    });
    expect(out.stdout.trim()).toBe('');
    expect(out.stderr.trim()).toBe('');
  });
});

// ── Modes ─────────────────────────────────────────────────────────────────────

describe('hook contract — modes', () => {
  test('observe mode logs but does NOT block prompt', async () => {
    writeFile('observe');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Server 10.1.2.3 has Acme Corp data',
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(out.stderr).toContain('observe');
  });

  test('observe mode does NOT mutate PreToolUse input', async () => {
    writeFile('observe');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ping 10.1.2.3' },
    });
    expect(out.stdout.trim()).toBe('');
    expect(out.stderr).toContain('observe');
  });

  test('observe mode does NOT exit 2 on credential — only logs', async () => {
    writeFile('observe');
    const out = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'curl -H "X: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12" url' },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('observe');
  });

  test('disabled mode is a no-op', async () => {
    writeFile('disabled');
    const out = await runHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Server 10.99.88.77 is down',
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(out.stderr.trim()).toBe('');
  });

  test('PRIVACY_SCREEN_MODE env overrides config', async () => {
    writeFile('enforce');
    const proc = Bun.spawn(['bun', HOOK_PATH], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PRIVACY_SCREEN_CONFIG: configPath, PRIVACY_SCREEN_MODE: 'disabled' },
    });
    proc.stdin.write(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Server 10.1.2.3 down' }),
    );
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toBe('');
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('hook contract — error handling', () => {
  test('empty stdin → no output, exit 0', async () => {
    writeFile('enforce');
    const proc = Bun.spawn(['bun', HOOK_PATH], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PRIVACY_SCREEN_CONFIG: configPath },
    });
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  // HOOK-03 (#95): non-empty unparseable stdin must FAIL CLOSED in enforce
  // mode (exit 2), and pass through (exit 0) in observe — never silently
  // proceed unscreened in enforce.
  test('invalid JSON stdin → exit 2 in enforce mode (fail closed)', async () => {
    writeFile('enforce');
    const out = await runHookRaw('not json at all');
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Unparseable');
  });

  test('invalid JSON stdin → exit 0 in observe mode (pass through)', async () => {
    writeFile('observe');
    const out = await runHookRaw('not json at all');
    expect(out.exitCode).toBe(0);
  });

  // HOOK-01 (#93): oversized input must FAIL CLOSED in enforce (exit 2) and
  // pass through in observe — not unconditionally bypass scrubbing.
  test('input over 1MB → exit 2 in enforce mode (fail closed)', async () => {
    writeFile('enforce');
    const huge = 'x'.repeat(1_100_000);
    const out = await runHookRaw(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: huge }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('exceeds');
  });

  test('oversized input with a credential is flagged in enforce mode', async () => {
    writeFile('enforce');
    const huge =
      'GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12 ' + 'x'.repeat(1_100_000);
    const out = await runHookRaw(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: huge }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Credential');
  });

  test('input over 1MB → exit 0 in observe mode (pass through)', async () => {
    writeFile('observe');
    const huge = 'x'.repeat(1_100_000);
    const out = await runHookRaw(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: huge }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('exceeds');
  });
});

// ── PostToolUse object-valued tool_response (HOOK-02 #94) ──────────────────────

describe('hook contract — PostToolUse object tool_response', () => {
  test('object tool_response with credential → exit 2', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: {
        stdout: 'export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12',
        exitCode: 0,
      },
    });
    expect(out.exitCode).toBe(2);
  });

  test('object tool_response with IP → stderr PII warning, no throw', async () => {
    writeFile('enforce');
    const out = await runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: 'server is at 10.66.77.88', exitCode: 0 },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('PII');
  });
});

// ── CLI scrub pipe (issue #100 / HOOK-08) ─────────────────────────────────────

/**
 * CLI pipe test for scrub command (TDD for HOOK-08).
 * Self-contained: fresh $HOME temp per call (using imported mkdtempSync etc)
 * so defaultDbPath resolves isolated inside child. No dep on hook workDir.
 * Spawns exactly `bun cli/PrivacyScreen.ts scrub`, pipes raw text, asserts
 * tokenized (not silent empty from the readFileSync bug).
 */
const CLI_PATH = new URL('../cli/PrivacyScreen.ts', import.meta.url).pathname;

async function runCliScrub(inputText: string): Promise<{exitCode: number; stdout: string; stderr: string}> {
  const home = mkdtempSync(join(tmpdir(), 'ps-cli-100-'));
  try {
    const proc = Bun.spawn(['bun', CLI_PATH, 'scrub'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home },
    });
    proc.stdin.write(inputText);
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('cli scrub pipe', () => {
  test('piped PII produces tokenized output (not silent empty result)', async () => {
    const out = await runCliScrub('Contact alice@example.com at 10.0.0.1');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('── Scrubbed output ──────────────────────────────');
    const scrubbedBody = out.stdout.split('── Token map')[0] ?? out.stdout;
    expect(scrubbedBody).not.toContain('alice@example.com');
    expect(scrubbedBody).not.toContain('10.0.0.1');
    expect(scrubbedBody).toMatch(/\{EMAIL\}/);
    expect(scrubbedBody).toMatch(/\{IP\}/);
    expect(out.stdout).toContain('── Token map ────────────────────────────────────');
  });

  test('empty/no-input to cli scrub → explicit error + exit 1 (covers the silent-empty bug)', async () => {
    const out = await runCliScrub('');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No input received');
    expect(out.stderr).toContain('echo "my text" | bun cli/PrivacyScreen.ts scrub');
    expect(out.stdout).not.toContain('── Scrubbed output ──────────────────────────────');
  });
});
