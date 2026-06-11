/**
 * POST /api/send — scrub + relay to Anthropic + Server-Sent Events stream back.
 *
 * Body: { messages: [{role, content}], model?, maxTokens? }
 *
 * Behavior:
 *   1. Each message.content is scrubbed via the shared ScrubMap (idempotent for
 *      already-scrubbed text from /api/scrub previews).
 *   2. If hasCredentials → respond 400 immediately; do NOT relay.
 *   3. Otherwise stream Anthropic response as SSE. Each chunk is forwarded as-is
 *      (still tokenized — deanonymization is the client's job).
 *
 * SSE event format:
 *   event: text    data: {"delta": "..."}
 *   event: done    data: {"usage": {...}}
 *   event: error   data: {"message": "..."}
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { scrubText } from '../../src/scrubber';
import type { ScrubMap } from '../../src/scrub-map';
import type { VocabStore } from '../../src/vocab';
import type { PrivacyConfig } from '../../src/config';
import { getMap, getVocab } from '../lib/vocab-store';
import { loadConfig } from '../../src/config';
import { publicSettings } from '../secrets';
import { streamChat, type ChatMessage } from '../providers/claude-code';

export const sendRoute = new Hono();

/**
 * SRV-04 (#77): resolve the system prompt for the send path. The saved
 * settings.system_prompt can itself contain PII, so it MUST be scrubbed with
 * the same credential gate as message content before it reaches the provider.
 * Returns the scrubbed prompt, or a credential signal so the caller can refuse
 * to relay. An empty/whitespace prompt resolves to undefined (no system arg).
 */
export function resolveSystemPrompt(
  raw: string | undefined,
  map: ScrubMap,
  vocab: VocabStore | null,
  cfg: PrivacyConfig,
): { system?: string; hasCredentials: boolean; credentialSnippets: string[] } {
  if (!raw || !raw.trim()) return { hasCredentials: false, credentialSnippets: [] };
  const result = scrubText(raw, map, vocab, { sourceEvent: 'app:send:system', config: cfg });
  if (result.hasCredentials) {
    return { hasCredentials: true, credentialSnippets: result.credentialSnippets };
  }
  return { system: result.scrubbed, hasCredentials: false, credentialSnippets: [] };
}

sendRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (messages.length === 0) {
    return c.json({ error: 'messages array required' }, 400);
  }

  const cfg = loadConfig();
  const map = getMap();
  const vocab = getVocab();

  // Scrub every message. Idempotent on already-tokenized text.
  const scrubbedMessages: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') continue;
    const result = scrubText(m.content, map, vocab, {
      sourceEvent: 'app:send',
      config: cfg,
    });
    if (result.hasCredentials) {
      return c.json(
        {
          error: 'credential detected',
          credentialSnippets: result.credentialSnippets,
          message: 'A credential was detected in the message. Remove it before sending.',
        },
        400,
      );
    }
    scrubbedMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: result.scrubbed,
    });
  }

  // SRV-04 (#77): wire the saved system prompt into the send path — scrubbed,
  // behind the same credential gate. Previously it was persisted but ignored.
  const sys = resolveSystemPrompt(publicSettings().system_prompt, map, vocab, cfg);
  if (sys.hasCredentials) {
    return c.json(
      {
        error: 'credential detected',
        credentialSnippets: sys.credentialSnippets,
        message: 'A credential was detected in the saved system prompt. Remove it in Settings before sending.',
      },
      400,
    );
  }

  return streamSSE(c, async (stream) => {
    let closed = false;
    const safeWrite = async (event: string, data: unknown): Promise<void> => {
      if (closed) return;
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    await new Promise<void>((resolve) => {
      streamChat(
        scrubbedMessages,
        { model: body.model, maxTokens: body.maxTokens, system: sys.system },
        {
          onText: (delta) => {
            void safeWrite('text', { delta });
          },
          onError: (err) => {
            void safeWrite('error', { message: err.message }).finally(() => {
              closed = true;
              resolve();
            });
          },
          onDone: (usage) => {
            void safeWrite('done', { usage }).finally(() => {
              closed = true;
              resolve();
            });
          },
        },
      );
    });
  });
});
