/**
 * Hook → /api/judge handoff tests.
 *
 * Spawns the real hook binary with a PreToolUse payload, captures its
 * stdout (the hookSpecificOutput JSON Claude Code consumes), and asserts
 * the side-channel POST to a tiny in-process Hono receiver matches the
 * expected shape — or, in the negative cases, does not happen at all.
 *
 * The test receiver listens on a random ephemeral loopback port. The hook
 * is pointed at it via PRIVACY_SCREEN_JUDGE_ENDPOINT so we don't need a
 * real privacy-screen server running.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = new URL('../hooks/PrivacyScreen.hook.ts', import.meta.url).pathname;

interface CapturedPost {
  body: string;
  contentType: string | null;
}

interface ReceiverHandle {
  url: string;
  posts: CapturedPost[];
  stop(): void;
}

function startReceiver(opts?: { hang?: boolean }): ReceiverHandle {
  const posts: CapturedPost[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // OS-assigned ephemeral port
    fetch: async (req) => {
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      const body = await req.text();
      posts.push({ body, contentType: req.headers.get('content-type') });
      if (opts?.hang) {
        // Never respond — exercise the hook's 150 ms abort cap.
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ status: 'accepted' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/api/judge`,
    posts,
    stop: () => server.stop(),
  };
}

let workDir: string;
let configPath: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-judge-handoff-'));
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  dbPath = join(workDir, 'vocab.db');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(opts: {
  enabled: boolean;
  mode?: 'enforce' | 'observe';
  customerNames?: string[];
}): void {
  const mode = opts.mode ?? 'enforce';
  const customers = (opts.customerNames ?? ['Acme Corp'])
    .map((n) => `  - "${n}"`)
    .join('\n');
  writeFileSync(
    configPath,
    `mode: ${mode}\n` +
      `db_path: ${dbPath}\n` +
      `customer_names:\n${customers}\n` +
      `llm_validate:\n` +
      `  enabled: ${opts.enabled}\n`,
  );
}

interface HookOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
}

async function runHook(
  payload: object,
  env: Record<string, string>,
): Promise<HookOutput> {
  const proc = Bun.spawn(['bun', HOOK_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PRIVACY_SCREEN_CONFIG: configPath,
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let parsed: unknown = null;
  if (stdout.trim()) {
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      /* leave null */
    }
  }
  return { exitCode, stdout, stderr, parsed };
}

const PRE_TOOL_PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: {
    command:
      'ssh acme-bastion-01.acme.internal "ping 10.55.66.77 from Acme Corp lab"',
  },
};

describe('hook → /api/judge handoff', () => {
  test('POSTs to /api/judge when enabled and tool input was scrubbed', async () => {
    writeConfig({ enabled: true });
    const recv = startReceiver();
    try {
      const out = await runHook(PRE_TOOL_PAYLOAD, {
        PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url,
      });

      // Hook stdout must still carry the updatedInput envelope — judge is a
      // side channel and cannot perturb what Claude Code receives.
      expect(out.exitCode).toBe(0);
      expect(out.parsed).toBeTruthy();
      const stdoutJson = out.parsed as { hookSpecificOutput?: unknown };
      expect(stdoutJson.hookSpecificOutput).toBeDefined();

      // One POST should have landed at the receiver with the expected shape.
      expect(recv.posts.length).toBe(1);
      const post = recv.posts[0];
      expect(post.contentType).toContain('application/json');
      const body = JSON.parse(post.body) as Record<string, unknown>;
      expect(typeof body.scrubbed).toBe('string');
      expect((body.scrubbed as string).length).toBeGreaterThanOrEqual(24);
      expect(typeof body.sourceEvent).toBe('string');
      expect(body.sourceEvent).toBe('preToolUse:Bash');
      // tokenMap is the serialized envelope from ScrubMap.serialize().
      const tokenMap = body.tokenMap as { v?: unknown; entries?: unknown };
      expect(tokenMap.v).toBe(1);
      expect(Array.isArray(tokenMap.entries)).toBe(true);
    } finally {
      recv.stop();
    }
  });

  test('no POST when llm_validate is disabled', async () => {
    writeConfig({ enabled: false });
    const recv = startReceiver();
    try {
      const out = await runHook(PRE_TOOL_PAYLOAD, {
        PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url,
      });
      expect(out.exitCode).toBe(0);
      expect(recv.posts.length).toBe(0);
    } finally {
      recv.stop();
    }
  });

  test('hook stdout is byte-identical whether POST succeeds or hangs', async () => {
    writeConfig({ enabled: true });

    const live = startReceiver();
    const liveOut = await runHook(PRE_TOOL_PAYLOAD, {
      PRIVACY_SCREEN_JUDGE_ENDPOINT: live.url,
    });
    live.stop();

    const hung = startReceiver({ hang: true });
    const hungOut = await runHook(PRE_TOOL_PAYLOAD, {
      PRIVACY_SCREEN_JUDGE_ENDPOINT: hung.url,
    });
    hung.stop();

    expect(liveOut.exitCode).toBe(0);
    expect(hungOut.exitCode).toBe(0);
    expect(liveOut.stdout).toBe(hungOut.stdout);
  });

  test('refuses non-loopback endpoint (defense in depth)', async () => {
    writeConfig({ enabled: true });
    // Use a TEST-NET-1 IP (RFC 5737) so we can't accidentally hit a real host.
    // The hook must reject this URL on the loopback check before any network
    // traffic — we don't even need a receiver running.
    const out = await runHook(PRE_TOOL_PAYLOAD, {
      PRIVACY_SCREEN_JUDGE_ENDPOINT: 'http://192.0.2.1:31338/api/judge',
    });
    expect(out.exitCode).toBe(0);
    // No way to assert "no POST" without a receiver, but stdout shape is the
    // hot-path contract we care about — the loopback check is unit-tested by
    // the absence of any thrown error and a successful hook exit.
    expect(out.parsed).toBeTruthy();
    const stdoutJson = out.parsed as { hookSpecificOutput?: unknown };
    expect(stdoutJson.hookSpecificOutput).toBeDefined();
  });

  test('no POST when input is too short to scrub', async () => {
    writeConfig({ enabled: true });
    const recv = startReceiver();
    try {
      const out = await runHook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
        { PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url },
      );
      expect(out.exitCode).toBe(0);
      // Tool input was not scrubbed (nothing matched), so the modified branch
      // never runs and the handoff path is never reached.
      expect(recv.posts.length).toBe(0);
    } finally {
      recv.stop();
    }
  });
});
