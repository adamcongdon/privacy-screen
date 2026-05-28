#!/usr/bin/env bun
/**
 * PrivacyScreen.hook.ts — PII anonymization gate
 *
 * Intercepts user prompts and tool calls to anonymize customer data,
 * infrastructure identifiers, and credentials before they leave the
 * local machine for Anthropic's API.
 *
 * TRIGGER: UserPromptSubmit | PreToolUse (*) | PostToolUse (*)
 *
 * Behavior by event:
 *   UserPromptSubmit — detect PII → BLOCK with scrubbed suggestion
 *   PreToolUse       — detect PII → MUTATE via updatedInput (or block credentials)
 *   PostToolUse      — detect PII → BLOCK tool result (credentials) or WARN (names)
 *
 * Fail-CLOSED: any uncaught error exits 2 (block). This overrides the
 * existing pipeline's fail-open behavior for this specific inspector.
 */

import { ScrubMap } from '../src/scrub-map';
import { VocabStore, defaultDbPath } from '../src/vocab';
import { scrubText, scrubToolInput } from '../src/scrubber';

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreToolUse / PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;  // older field name
  tool_result?: string;    // Claude Code's actual PostToolUse field name
}

async function main(): Promise<void> {
  let raw: string;
  try {
    const { readFileSync } = await import('fs');
    raw = readFileSync('/dev/stdin', 'utf-8');
    if (!raw.trim()) return;
  } catch {
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const event = input.hook_event_name ?? detectEvent(input);
  const sessionId = input.session_id ?? null;

  // Initialise vocab store and scrub map (fast — SQLite open + index scan)
  const vocab = new VocabStore(defaultDbPath());
  const map = new ScrubMap();
  vocab.loadIntoMap(map);

  try {
    if (event === 'UserPromptSubmit') {
      await handlePrompt(input, map, vocab, sessionId);
    } else if (event === 'PreToolUse') {
      await handlePreTool(input, map, vocab, sessionId);
    } else if (event === 'PostToolUse') {
      await handlePostTool(input, map, vocab, sessionId);
    }
  } finally {
    vocab.close();
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handlePrompt(
  input: HookInput,
  map: ScrubMap,
  vocab: VocabStore,
  sessionId: string | null,
): Promise<void> {
  const prompt = input.prompt ?? '';
  if (prompt.length < 4) return;

  const result = scrubText(prompt, map, vocab, {
    sourceEvent: 'userPromptSubmit',
    sessionId: sessionId ?? undefined,
  });

  if (!result.modified) return;

  vocab.logRedaction(
    sessionId,
    'userPromptSubmit',
    result.mintedTokens.filter((t) => t.isNew).length,
    result.mintedTokens.filter((t) => !t.isNew).length,
    true,
  );

  let reason: string;

  if (result.hasCredentials) {
    reason =
      `[PrivacyScreen] 🚨 CREDENTIAL DETECTED\n\n` +
      `Detected: ${result.credentialSnippets.join(', ')}\n\n` +
      `Remove the credential from your message before resubmitting.\n` +
      `Never paste API keys, tokens, or private keys into the chat.`;
  } else {
    const tokenSummary = buildTokenSummary(result.mintedTokens);
    reason =
      `[PrivacyScreen] 🔒 PII detected. Scrubbed version — copy and resubmit:\n\n` +
      `${result.scrubbed}\n\n` +
      `─── Token map ───\n${tokenSummary}`;
  }

  console.log(JSON.stringify({ decision: 'block', reason }));
}

async function handlePreTool(
  input: HookInput,
  map: ScrubMap,
  vocab: VocabStore,
  sessionId: string | null,
): Promise<void> {
  const toolName = input.tool_name ?? 'unknown';
  const toolInput = input.tool_input;
  if (!toolInput) return;

  const { input: scrubbedInput, result } = scrubToolInput(toolInput, map, vocab, {
    sourceEvent: `preToolUse:${toolName}`,
    sessionId: sessionId ?? undefined,
  });

  if (result.hasCredentials) {
    vocab.logRedaction(sessionId, `preToolUse:${toolName}`, 0, 0, true);
    console.error(
      `[PrivacyScreen] 🚨 CREDENTIAL in ${toolName} call — blocked. Remove credential before retrying.`,
    );
    process.exit(2);
  }

  if (!result.modified) return;

  vocab.logRedaction(
    sessionId,
    `preToolUse:${toolName}`,
    result.mintedTokens.filter((t) => t.isNew).length,
    result.mintedTokens.filter((t) => !t.isNew).length,
    false,
  );

  console.error(
    `[PrivacyScreen] 🔒 Anonymized ${result.mintedTokens.length} PII token(s) in ${toolName} input.`,
  );

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        updatedInput: scrubbedInput,
      },
    }),
  );
}

async function handlePostTool(
  input: HookInput,
  map: ScrubMap,
  vocab: VocabStore,
  sessionId: string | null,
): Promise<void> {
  const toolName = input.tool_name ?? 'unknown';
  const toolResponse = input.tool_result ?? input.tool_response ?? '';
  if (!toolResponse) return;

  // PostToolUse: scan only — cannot rewrite. Block on credentials, warn on PII.
  const result = scrubText(toolResponse, map, vocab, {
    sourceEvent: `postToolUse:${toolName}`,
    sessionId: sessionId ?? undefined,
  });

  if (result.hasCredentials) {
    vocab.logRedaction(sessionId, `postToolUse:${toolName}`, 0, 0, true);
    console.error(
      `[PrivacyScreen] 🚨 CREDENTIAL in ${toolName} output — result blocked from context.`,
    );
    process.exit(2);
  }

  if (result.mintedTokens.length > 0) {
    console.error(
      `[PrivacyScreen] ⚠️  PII in ${toolName} output: ` +
        result.mintedTokens
          .slice(0, 5)
          .map((t) => t.token)
          .join(', ') +
        (result.mintedTokens.length > 5 ? ` …+${result.mintedTokens.length - 5} more` : ''),
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectEvent(input: HookInput): string {
  if (input.prompt !== undefined) return 'UserPromptSubmit';
  if (input.tool_result !== undefined || input.tool_response !== undefined) return 'PostToolUse';
  if (input.tool_input !== undefined) return 'PreToolUse';
  return 'unknown';
}

function buildTokenSummary(tokens: Array<{ realValue: string; token: string; isNew: boolean }>): string {
  const seen = new Map<string, string>();
  for (const { realValue, token } of tokens) {
    seen.set(token, realValue);
  }
  return [...seen.entries()]
    .map(([token, real]) => `  ${token} → "${real}"`)
    .join('\n');
}

// Fail-CLOSED: any unhandled error blocks the submission
main().catch((err) => {
  console.error(`[PrivacyScreen] Fatal error — blocking for safety: ${err}`);
  process.exit(2);
});
