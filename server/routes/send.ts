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
import { getMap, getVocab } from '../lib/vocab-store';
import { loadConfig } from '../../src/config';
import { streamChat, type ChatMessage } from '../providers/claude-code';

export const sendRoute = new Hono();

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

  return streamSSE(c, async (stream) => {
    let closed = false;
    const safeWrite = async (event: string, data: unknown): Promise<void> => {
      if (closed) return;
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    await new Promise<void>((resolve) => {
      streamChat(
        scrubbedMessages,
        { model: body.model, maxTokens: body.maxTokens },
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
