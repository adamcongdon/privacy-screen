/**
 * SRV-09 / #82 — streamChat JSONL parsing + spawn seam tests.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  streamChat,
  formatPrompt,
  buildClaudePrintArgs,
  __test_setClaudeSpawn,
  type ClaudeSpawnFn,
} from '../server/providers/claude-code';

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (() => true) as FakeChild['kill'];
  return child;
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function resultLine(
  opts: { is_error?: boolean; result?: string; input?: number; output?: number } = {},
): string {
  return JSON.stringify({
    type: 'result',
    is_error: !!opts.is_error,
    result: opts.result,
    usage: { input_tokens: opts.input ?? 1, output_tokens: opts.output ?? 2 },
  });
}

describe('formatPrompt', () => {
  test('single user message is raw content', () => {
    expect(formatPrompt([{ role: 'user', content: 'hello {IP}' }])).toBe('hello {IP}');
  });

  test('multi-turn prefixes roles and ends with Assistant:', () => {
    const p = formatPrompt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ]);
    expect(p).toContain('User: hi');
    expect(p).toContain('Assistant: yo');
    expect(p).toContain('User: again');
    expect(p.trimEnd().endsWith('Assistant:')).toBe(true);
  });
});

describe('streamChat with spawn seam (SRV-09 / #82)', () => {
  let lastSpawn: { cmd: string; args: string[]; stdin: string } | null = null;
  let child: FakeChild;

  beforeEach(() => {
    lastSpawn = null;
    child = makeFakeChild();
    const fake: ClaudeSpawnFn = (cmd, args) => {
      lastSpawn = { cmd, args: [...args], stdin: '' };
      // Capture stdin writes
      const chunks: Buffer[] = [];
      child.stdin.on('data', (c: Buffer) => chunks.push(c));
      child.stdin.on('end', () => {
        lastSpawn!.stdin = Buffer.concat(chunks).toString();
      });
      return child;
    };
    __test_setClaudeSpawn(fake);
  });

  afterEach(() => {
    __test_setClaudeSpawn(null);
  });

  test('scrubbed-only content reaches stdin (no raw PII path)', async () => {
    const done = streamChat(
      [{ role: 'user', content: 'Contact {EMAIL} at {IP}' }],
      {},
      {
        onText: () => {},
        onError: () => {},
        onDone: () => {},
      },
    );
    // Finish stream after stdin ends
    await new Promise((r) => setTimeout(r, 5));
    child.stdout.write(assistantLine('ok') + '\n');
    child.stdout.write(resultLine() + '\n');
    child.emit('close', 0);
    await done;

    expect(lastSpawn?.cmd).toBe('claude');
    expect(lastSpawn?.stdin).toBe('Contact {EMAIL} at {IP}');
    expect(lastSpawn?.stdin).not.toMatch(/@|\d+\.\d+\.\d+\.\d+/);
    // Isolation flags still present
    expect(lastSpawn?.args).toContain('--setting-sources');
  });

  test('partial-delta math: extending prefix emits only new suffix', async () => {
    const deltas: string[] = [];
    const done = streamChat(
      [{ role: 'user', content: 'hi' }],
      {},
      {
        onText: (t) => deltas.push(t),
        onError: () => {},
        onDone: () => {},
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.write(assistantLine('Hel') + '\n');
    child.stdout.write(assistantLine('Hello') + '\n');
    child.stdout.write(assistantLine('Hello world') + '\n');
    child.stdout.write(resultLine({ input: 3, output: 4 }) + '\n');
    child.emit('close', 0);
    await done;

    expect(deltas).toEqual(['Hel', 'lo', ' world']);
  });

  test('is_error result surfaces onError with message', async () => {
    const errors: Error[] = [];
    const done = streamChat(
      [{ role: 'user', content: 'x' }],
      {},
      {
        onText: () => {},
        onError: (e) => {
          errors.push(e);
        },
        onDone: () => {},
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.write(resultLine({ is_error: true, result: 'rate limited by provider' }) + '\n');
    child.emit('close', 0);
    await done;
    expect(errors[0]?.message).toBe('rate limited by provider');
  });

  test('non-zero exit without result surfaces stderr tail', async () => {
    const errors: Error[] = [];
    const done = streamChat(
      [{ role: 'user', content: 'x' }],
      {},
      {
        onText: () => {},
        onError: (e) => {
          errors.push(e);
        },
        onDone: () => {},
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    child.stderr.write('line1\nline2\nFATAL boom\n');
    child.emit('close', 1);
    await done;
    expect(errors[0]?.message).toContain('claude exited with code 1');
    expect(errors[0]?.message).toContain('FATAL boom');
  });

  test('onDone receives usage from result event', async () => {
    const usages: Array<{ input_tokens: number; output_tokens: number }> = [];
    const done = streamChat(
      [{ role: 'user', content: 'x' }],
      {},
      {
        onText: () => {},
        onError: () => {},
        onDone: (u) => {
          usages.push(u);
        },
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    child.stdout.write(resultLine({ input: 11, output: 22 }) + '\n');
    child.emit('close', 0);
    await done;
    expect(usages[0]).toEqual({ input_tokens: 11, output_tokens: 22 });
  });
});

describe('send route credential gate (source contract)', () => {
  test('send.ts returns 400 on credentials before streamChat/spawn', async () => {
    const src = await Bun.file(new URL('../server/routes/send.ts', import.meta.url)).text();
    expect(src).toContain("error: 'credential detected'");
    // credential check precedes streamSSE / streamChat
    const credIdx = src.indexOf("error: 'credential detected'");
    const streamChatIdx = src.indexOf('streamChat(');
    expect(credIdx).toBeGreaterThan(-1);
    expect(streamChatIdx).toBeGreaterThan(credIdx);
  });
});
