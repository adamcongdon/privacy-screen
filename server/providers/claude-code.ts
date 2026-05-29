/**
 * Claude Code provider — inference via `claude --print` subprocess.
 *
 * No API key required. Authentication piggybacks on the user's existing
 * `claude login` (OAuth, keychain-backed). Our spawned subprocess inherits
 * the same auth.
 *
 * Stream protocol: `--output-format stream-json --include-partial-messages`
 * emits JSONL events. We parse and forward the assistant text deltas to the
 * caller; everything else (hooks, MCP, tool calls) is filtered out.
 *
 * Why not `--bare`: bare mode strictly requires ANTHROPIC_API_KEY — it skips
 * OAuth and keychain reads. Defeats the "no API key" requirement. We accept
 * the small overhead of normal-mode hooks for the auth flexibility.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onError: (err: Error) => void;
  onDone: (usage: { input_tokens: number; output_tokens: number }) => void;
}

export interface StreamOptions {
  model?: string;
  system?: string;
  maxTokens?: number; // accepted for parity; claude CLI does not expose --max-tokens for print mode
  abortSignal?: AbortSignal;
}

const DEFAULT_MODEL = 'sonnet';

/**
 * Render a multi-message conversation into a single prompt for `claude --print`.
 * The CLI's print mode is one-shot — no conversation thread is maintained
 * across invocations. We prefix each turn with a role marker so the model
 * can read prior context.
 */
function formatPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0].role === 'user') {
    return messages[0].content;
  }
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`${role}: ${m.content}`);
  }
  lines.push('Assistant:');
  return lines.join('\n\n');
}

export async function streamChat(
  messages: ChatMessage[],
  opts: StreamOptions,
  cb: StreamCallbacks,
): Promise<void> {
  const prompt = formatPrompt(messages);

  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--disable-slash-commands',
    '--model', opts.model ?? DEFAULT_MODEL,
    '--tools', '', // disable all tools — pure inference only
  ];

  if (opts.system) {
    args.push('--append-system-prompt', opts.system);
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    cb.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, { once: true });
  }

  child.stdin.write(prompt);
  child.stdin.end();

  let buffer = '';
  let lastAssistantText = ''; // for delta calculation across partial-message events
  let finalUsage: { input_tokens: number; output_tokens: number } | null = null;
  let resultEmitted = false;
  let stderrBuf = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      handleEvent(line);
    }
  });

  function handleEvent(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON noise (shouldn't happen on stdout, but be defensive)
    }
    const type = String(event.type ?? '');

    if (type === 'assistant') {
      const msg = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      if (!msg?.content) return;
      const fullText = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!fullText) return;
      // Emit only what's new since last partial. If the new text is a prefix
      // extension of the previous (the common case for partial-messages), send
      // the delta. Otherwise (a fresh assistant turn), reset and send all.
      if (fullText.startsWith(lastAssistantText) && fullText.length > lastAssistantText.length) {
        const delta = fullText.slice(lastAssistantText.length);
        lastAssistantText = fullText;
        cb.onText(delta);
      } else if (fullText !== lastAssistantText) {
        lastAssistantText = fullText;
        cb.onText(fullText);
      }
      return;
    }

    if (type === 'result') {
      resultEmitted = true;
      const isError = !!event.is_error;
      const usage = (event.usage as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
      finalUsage = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      };
      if (isError) {
        const msg = typeof event.result === 'string' ? event.result : 'claude returned an error';
        cb.onError(new Error(msg));
      } else {
        cb.onDone(finalUsage);
      }
      // Don't kill — let it close naturally so we drain stderr too.
    }
  }

  return new Promise<void>((resolve) => {
    child.on('error', (err) => {
      cb.onError(err);
      resolve();
    });
    child.on('close', (code) => {
      // If we never saw a result event AND exit was non-zero, surface the error.
      if (!resultEmitted && code !== 0) {
        const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
        cb.onError(new Error(`claude exited with code ${code}${tail ? `\n${tail}` : ''}`));
      } else if (!resultEmitted && finalUsage === null) {
        cb.onError(new Error('claude stream ended without a result event'));
      }
      resolve();
    });
  });
}
