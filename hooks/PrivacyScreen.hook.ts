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
 * Modes (via PRIVACY_CONFIG.yaml `mode:` or PRIVACY_SCREEN_MODE env):
 *   enforce  — full block + mutation behavior (default)
 *   observe  — detect + log only; nothing blocks, nothing mutates
 *   disabled — early exit, no-op
 *
 * Fail-CLOSED: any uncaught error exits 2 (block). Overrides the existing
 * pipeline's fail-open behavior for this specific inspector.
 */

import { ScrubMap } from '../src/scrub-map';
import { VocabStore, defaultDbPath } from '../src/vocab';
import { scrubText, scrubToolInput } from '../src/scrubber';
import { loadConfig, type PrivacyConfig } from '../src/config';

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreToolUse / PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_result?: string;
}

const MAX_INPUT_BYTES = 1_000_000; // 1MB — anything larger gets logged + passed through
const SCRUB_BUDGET_MS = 1500;       // soft budget; hook still has 8s outer timeout

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.mode === 'disabled') return;

  let raw: string;
  try {
    const { readFileSync } = await import('fs');
    raw = readFileSync('/dev/stdin', 'utf-8');
    if (!raw.trim()) return;
  } catch {
    return;
  }

  if (raw.length > MAX_INPUT_BYTES) {
    process.stderr.write(
      `[PrivacyScreen] Input ${raw.length}B exceeds ${MAX_INPUT_BYTES}B — passing through unmodified.\n`,
    );
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

  const dbPath = cfg.db_path ?? defaultDbPath();
  const vocab = new VocabStore(dbPath);
  const map = new ScrubMap();
  vocab.loadIntoMap(map);

  const started = Date.now();
  try {
    if (event === 'UserPromptSubmit') {
      await handlePrompt(input, map, vocab, sessionId, cfg);
    } else if (event === 'PreToolUse') {
      await handlePreTool(input, map, vocab, sessionId, cfg);
    } else if (event === 'PostToolUse') {
      await handlePostTool(input, map, vocab, sessionId, cfg);
    }
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed > SCRUB_BUDGET_MS) {
      process.stderr.write(
        `[PrivacyScreen] ⚠️  Scrub took ${elapsed}ms (budget ${SCRUB_BUDGET_MS}ms) on event ${event}.\n`,
      );
    }
    vocab.close();
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handlePrompt(
  input: HookInput,
  map: ScrubMap,
  vocab: VocabStore,
  sessionId: string | null,
  cfg: PrivacyConfig,
): Promise<void> {
  const prompt = input.prompt ?? '';
  if (prompt.length < 4) return;

  const result = scrubText(prompt, map, vocab, {
    sourceEvent: 'userPromptSubmit',
    sessionId: sessionId ?? undefined,
    config: cfg,
  });

  if (!result.modified) return;

  const minted = result.mintedTokens.filter((t) => t.isNew).length;
  const reused = result.mintedTokens.filter((t) => !t.isNew).length;
  vocab.logRedaction(sessionId, 'userPromptSubmit', minted, reused, cfg.mode === 'enforce');

  if (cfg.mode === 'observe') {
    process.stderr.write(
      `[PrivacyScreen:observe] would block prompt. minted=${minted} reused=${reused} ` +
        `creds=${result.hasCredentials} unsure=${result.unsureSpans.length}\n`,
    );
    return;
  }

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
  cfg: PrivacyConfig,
): Promise<void> {
  const toolName = input.tool_name ?? 'unknown';
  const toolInput = input.tool_input;
  if (!toolInput) return;

  const { input: scrubbedInput, result } = scrubToolInput(
    toolInput,
    map,
    vocab,
    { sourceEvent: `preToolUse:${toolName}`, sessionId: sessionId ?? undefined, config: cfg },
    toolName,
  );

  if (result.hasCredentials) {
    vocab.logRedaction(sessionId, `preToolUse:${toolName}`, 0, 0, true);
    if (cfg.mode === 'observe') {
      process.stderr.write(
        `[PrivacyScreen:observe] would block credential in ${toolName} call.\n`,
      );
      return;
    }
    process.stderr.write(
      `[PrivacyScreen] 🚨 CREDENTIAL in ${toolName} call — blocked. Remove credential before retrying.\n`,
    );
    process.exit(2);
  }

  if (!result.modified) return;

  const minted = result.mintedTokens.filter((t) => t.isNew).length;
  const reused = result.mintedTokens.filter((t) => !t.isNew).length;
  vocab.logRedaction(sessionId, `preToolUse:${toolName}`, minted, reused, false);

  if (cfg.mode === 'observe') {
    process.stderr.write(
      `[PrivacyScreen:observe] would anonymize ${result.mintedTokens.length} token(s) in ${toolName} input. ` +
        `Pass-through enabled.\n`,
    );
    return;
  }

  process.stderr.write(
    `[PrivacyScreen] 🔒 Anonymized ${result.mintedTokens.length} PII token(s) in ${toolName} input.\n`,
  );

  console.log(
    JSON.stringify({
      hookSpecificOutput: { updatedInput: scrubbedInput },
    }),
  );
}

async function handlePostTool(
  input: HookInput,
  map: ScrubMap,
  vocab: VocabStore,
  sessionId: string | null,
  cfg: PrivacyConfig,
): Promise<void> {
  const toolName = input.tool_name ?? 'unknown';
  const toolResponse = input.tool_result ?? input.tool_response ?? '';
  if (!toolResponse) return;

  // PostToolUse: scan only — cannot rewrite. Block on credentials, warn on PII.
  const result = scrubText(toolResponse, map, vocab, {
    sourceEvent: `postToolUse:${toolName}`,
    sessionId: sessionId ?? undefined,
    config: cfg,
  });

  if (result.hasCredentials) {
    vocab.logRedaction(sessionId, `postToolUse:${toolName}`, 0, 0, true);
    if (cfg.mode === 'observe') {
      process.stderr.write(
        `[PrivacyScreen:observe] would block credential in ${toolName} output.\n`,
      );
      return;
    }
    process.stderr.write(
      `[PrivacyScreen] 🚨 CREDENTIAL in ${toolName} output — result blocked from context.\n`,
    );
    process.exit(2);
  }

  if (result.mintedTokens.length > 0) {
    const preview = result.mintedTokens
      .slice(0, 5)
      .map((t) => t.token)
      .join(', ');
    const more = result.mintedTokens.length > 5 ? ` …+${result.mintedTokens.length - 5} more` : '';
    process.stderr.write(`[PrivacyScreen] ⚠️  PII in ${toolName} output: ${preview}${more}\n`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectEvent(input: HookInput): string {
  if (input.prompt !== undefined) return 'UserPromptSubmit';
  if (input.tool_result !== undefined || input.tool_response !== undefined) return 'PostToolUse';
  if (input.tool_input !== undefined) return 'PreToolUse';
  return 'unknown';
}

function buildTokenSummary(
  tokens: Array<{ realValue: string; token: string; isNew: boolean }>,
): string {
  const seen = new Map<string, string>();
  for (const { realValue, token } of tokens) {
    seen.set(token, realValue);
  }
  return [...seen.entries()].map(([token, real]) => `  ${token} → "${real}"`).join('\n');
}

main().catch((err) => {
  process.stderr.write(`[PrivacyScreen] Fatal error — blocking for safety: ${err}\n`);
  process.exit(2);
});
