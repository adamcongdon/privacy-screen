/**
 * Hook auto-approve + async judge audit (Issue #6 / #98 HOOK-06).
 *
 * When `cfg.hook.auto_approve_clean = true` AND the scrubber finds zero PII,
 * the hook MUST pass through silently — no stdout block, exit 0. Gating is
 * scrubber-only (ISC-20); the judge is best-effort audit only.
 *
 * #98: the clean path must fire-and-forget POST to the async judge endpoint
 * (`/api/judge` body with tokenMap + sourceEvent), NOT block up to 400ms on
 * `/api/judge/sync` and discard the result. Tests pin:
 *   - receiver receives exactly one POST with tokenMap when flag+llm on
 *   - dirty scrubber path still blocks (auto-approve cannot fire)
 *   - default config (flag omitted) never consults the judge
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_PATH = new URL('../hooks/PrivacyScreen.hook.ts', import.meta.url).pathname;

interface CapturedPost {
  body: string;
  path: string;
  url: string;
}

interface ReceiverHandle {
  url: string;
  posts: CapturedPost[];
  stop(): void;
}

/**
 * Async judge receiver — accepts POST /api/judge (and any path under override).
 * Returns 202 so the hook's fire-and-forget path treats the audit as accepted.
 */
function startAsyncJudgeReceiver(): ReceiverHandle {
  const posts: CapturedPost[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }
      const url = new URL(req.url);
      const body = await req.text();
      posts.push({ body, path: url.pathname, url: req.url });
      return new Response(JSON.stringify({ ok: true, queued: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    // Override keeps full path; dispatchJudge uses resolveJudgeEndpoint('async').
    url: `http://127.0.0.1:${server.port}/api/judge`,
    posts,
    stop: () => server.stop(),
  };
}

let workDir: string;
let configPath: string;
let dbPath: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pai-privacy-auto-approve-'));
  configPath = join(workDir, 'PRIVACY_CONFIG.yaml');
  dbPath = join(workDir, 'vocab.db');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(opts: {
  autoApproveClean: boolean;
  llmEnabled: boolean;
}): void {
  writeFileSync(
    configPath,
    `mode: enforce\n` +
      `db_path: ${dbPath}\n` +
      `customer_names:\n  - "Acme Corp"\n` +
      `hook:\n` +
      `  auto_approve_clean: ${opts.autoApproveClean}\n` +
      `llm_validate:\n` +
      `  enabled: ${opts.llmEnabled}\n`,
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

describe('hook auto-approve (Issue #6 / #98)', () => {
  test('(a) clean + flag on → silent pass + async judge audit POST', async () => {
    // Plain text with NO PII. Scrubber clean → auto-approve silent pass.
    // #98: must POST async /api/judge with tokenMap (not sync precheck discard).
    writeConfig({ autoApproveClean: true, llmEnabled: true });
    const recv = startAsyncJudgeReceiver();
    try {
      const out = await runHook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'What is the weather forecast for tomorrow afternoon?',
        },
        { PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url },
      );
      expect(out.exitCode).toBe(0);
      // ISC-20: silent pass-through — no stdout block, no mutation.
      expect(out.stdout.trim()).toBe('');
      expect(out.parsed).toBeNull();

      // Pin #98 async audit semantics (hollow "posts optional" is not enough).
      expect(recv.posts.length).toBe(1);
      expect(recv.posts[0].path).toBe('/api/judge');
      const body = JSON.parse(recv.posts[0].body) as {
        scrubbed?: string;
        tokenMap?: unknown;
        sourceEvent?: string;
      };
      expect(typeof body.scrubbed).toBe('string');
      expect(body.scrubbed).toContain('weather forecast');
      expect(body.tokenMap).toBeDefined();
      expect(body.sourceEvent).toBe('userPromptSubmit:auto-approve');
    } finally {
      recv.stop();
    }
  });

  test('(b) scrubber-dirty → BLOCK; auto-approve does not fire', async () => {
    // Text contains PII the scrubber catches (IP + customer name). Flag on
    // does not matter — modified path must block. No async judge audit on
    // this branch (auto-approve gate not entered).
    writeConfig({ autoApproveClean: true, llmEnabled: true });
    const recv = startAsyncJudgeReceiver();
    try {
      const out = await runHook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'Server 10.99.88.77 is down at Acme Corp lab',
        },
        { PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url },
      );
      expect(out.exitCode).toBe(0);
      expect(out.parsed).toMatchObject({ decision: 'block' });
      const reason = (out.parsed as { reason: string }).reason;
      expect(reason).toContain('Double check it for sensitive data, personal data, PII');
      // Dirty path does not enter auto-approve → no async judge audit.
      expect(recv.posts.length).toBe(0);
    } finally {
      recv.stop();
    }
  });

  test('default config (auto_approve_clean omitted) → flag is false', async () => {
    // No `hook:` section — auto-approve defaults OFF (ISC-21). Clean prompt
    // still silent-passes (nothing to block) but must NOT consult the judge.
    writeFileSync(
      configPath,
      `mode: enforce\n` +
        `db_path: ${dbPath}\n` +
        `customer_names:\n  - "Acme Corp"\n` +
        `llm_validate:\n` +
        `  enabled: true\n`,
    );
    const recv = startAsyncJudgeReceiver();
    try {
      const out = await runHook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'What is the weather forecast for tomorrow afternoon?',
        },
        { PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url },
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe('');
      expect(recv.posts.length).toBe(0);
    } finally {
      recv.stop();
    }
  });

  test('(c) flag on but llm_validate off → silent pass, no judge POST', async () => {
    writeConfig({ autoApproveClean: true, llmEnabled: false });
    const recv = startAsyncJudgeReceiver();
    try {
      const out = await runHook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'What is the weather forecast for tomorrow afternoon?',
        },
        { PRIVACY_SCREEN_JUDGE_ENDPOINT: recv.url },
      );
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe('');
      expect(recv.posts.length).toBe(0);
    } finally {
      recv.stop();
    }
  });
});
