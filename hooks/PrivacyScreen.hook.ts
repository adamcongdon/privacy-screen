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
import { scrubText, scrubToolInput, type MintedToken } from '../src/scrubber';
import { loadConfig, type PrivacyConfig } from '../src/config';
import { checkJudgeSync } from './lib/judge-sync';

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
const JUDGE_DISPATCH_BUDGET_MS = 150; // fire-and-forget POST cap to the long-lived server
const JUDGE_SYNC_BUDGET_MS = 400;   // sync auto-approve precheck cap (Issue #6)
const JUDGE_MIN_SCRUBBED_LEN = 24;   // mirrors the judge module's MIN_INPUT_LENGTH
const FINDINGS_PREVIEW_PHRASE =
  'Double check it for sensitive data, personal data, PII';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.mode === 'disabled') return;

  let raw: string;
  try {
    // Bun.stdin.text() is reliable across macOS + Linux pipes. The previous
    // readFileSync('/dev/stdin') silently returned an empty string when stdin
    // was a Bun.spawn pipe under Linux, which made every hook test trip the
    // early-exit path with no stdout/stderr.
    raw = await Bun.stdin.text();
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
    try {
      vocab.close();
    } catch (err) {
      process.stderr.write('[PrivacyScreen] vocab.close failed: ' + ((err as Error)?.message ?? String(err)) + '\n');
    }
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

  // ── Auto-approve precheck (Issue #6) ─────────────────────────────────────
  // When the operator has explicitly opted into `hook.auto_approve_clean`
  // AND the scrubber has nothing to say AND the judge sync endpoint confirms
  // the payload is clean, the hook is silent. Fail-CLOSED — any uncertainty
  // (judge unavailable, timeout, or any suspicious_count > 0) just means
  // we fall through to the normal pipeline (which also passes through here
  // because `result.modified === false`). Net behavior change on the
  // clean-input path: an audit-trail POST to /api/judge/sync. The endpoint
  // itself is opt-in via `llm_validate.enabled`.
  if (cfg.hook.auto_approve_clean && !result.modified) {
    // Only consult the judge if the scrubber found nothing. If scrubber
    // found PII (result.modified === true), auto-approve cannot fire per
    // ISC-20, so the consultation would be wasted work.
    await checkJudgeSync(prompt, cfg, JUDGE_SYNC_BUDGET_MS);
    // We do not branch on the result here — when scrubber-findings == 0
    // the hook is silent regardless. The consultation exists for the
    // audit-trail / confidence-gauge contract in Issue #6.
    return;
  }

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
    const findingsPreview = buildFindingsPreview(result.mintedTokens, result.scrubbed);
    reason =
      `[PrivacyScreen] 🔒 PII detected. ${FINDINGS_PREVIEW_PHRASE}.\n\n` +
      `Findings: ${findingsPreview}\n\n` +
      `Scrubbed version — copy and resubmit:\n\n` +
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

  // Fire-and-forget the LLM judge (opt-in, default off). The hook's stdout
  // JSON is already on its way to Claude Code by the time fetch awaits, so
  // this adds no user-visible latency on the read side — but we cap at
  // JUDGE_DISPATCH_BUDGET_MS so the hook can still exit promptly. Failures
  // are silent; the judge is best-effort by design.
  await dispatchJudge(
    JSON.stringify(scrubbedInput),
    map,
    `preToolUse:${toolName}`,
    cfg,
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

/**
 * Build a one-line findings preview the operator can scan at a glance
 * (Issue #6, ISC-19). Groups tokens by the uppercased category prefix
 * (the same prefix the scrub-map uses when minting — `IP`, `CUSTOMER`,
 * `EMAIL`, `PHONE`, `PERSON`, …) and renders as `CATEGORY×COUNT, …`,
 * sorted by descending count then category for deterministic output.
 *
 * Counting policy: each *occurrence* (one entry in `mintedTokens`) is
 * one finding. Two distinct IPs in the same prompt show as `IP×2`. The
 * scrubber already de-duplicates by token within the run, so re-mints
 * of the same realValue do not inflate the count.
 */
function buildFindingsPreview(
  tokens: MintedToken[],
  scrubbedText?: string,
): string {
  const counts = new Map<string, number>();

  // Primary signal: mintedTokens (covers regex-detected PII like IP, EMAIL,
  // PHONE, account-number, etc.).
  for (const t of tokens) {
    const category = (t.type ?? t.category ?? 'UNKNOWN').toUpperCase();
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  // Secondary signal: scan the scrubbed text for {CATEGORY} / {CATEGORY_N}
  // tokens that the pre-mint path (customer_names / person_names) writes
  // directly without populating `mintedTokens`. Each unique token in the
  // scrubbed output counts as one finding for its category.
  if (scrubbedText) {
    const seen = new Set<string>();
    for (const m of scrubbedText.matchAll(/\{([A-Z][A-Z_]*?)(?:_\d+)?\}/g)) {
      const tokenLiteral = m[0];
      if (seen.has(tokenLiteral)) continue;
      seen.add(tokenLiteral);
      const category = m[1];
      // Avoid double-counting: if any mintedToken already has this token
      // literal, the primary signal already counted it.
      const alreadyCounted = tokens.some((t) => t.token === tokenLiteral);
      if (alreadyCounted) continue;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return 'none';
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return entries.map(([cat, n]) => `${cat}×${n}`).join(', ');
}

/**
 * Fire-and-forget POST to the privacy-screen server's /api/judge endpoint.
 * Returns void; never throws. Capped at 150 ms via AbortSignal so a slow or
 * dead server cannot block the hook past its outer 8 s timeout.
 *
 * Safety:
 *   - No-ops when `cfg.llm_validate.enabled === false`.
 *   - No-ops when scrubbed text is shorter than the judge's MIN_INPUT_LENGTH.
 *   - Endpoint is always `http://127.0.0.1:${PRIVACY_SCREEN_PORT ?? 31338}/api/judge`
 *     unless overridden by `PRIVACY_SCREEN_JUDGE_ENDPOINT` (used by tests).
 *   - Refuses any endpoint whose hostname is not in LOOPBACK_HOSTS — defense
 *     in depth against env-var misconfig leaking PII off-box.
 */
async function dispatchJudge(
  scrubbed: string,
  map: ScrubMap,
  sourceEvent: string,
  cfg: PrivacyConfig,
): Promise<void> {
  if (!cfg.llm_validate.enabled) return;
  if (scrubbed.length < JUDGE_MIN_SCRUBBED_LEN) return;

  const endpoint = judgeEndpoint();
  if (endpoint === null) return; // non-loopback URL — refused

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scrubbed,
        tokenMap: map.serialize(),
        sourceEvent,
      }),
      signal: AbortSignal.timeout(JUDGE_DISPATCH_BUDGET_MS),
    });
  } catch (err) {
    if (process.env.PRIVACY_SCREEN_DEBUG_JUDGE === '1') {
      process.stderr.write('[PrivacyScreen] dispatchJudge: ' + ((err as Error)?.message ?? String(err)) + '\n');
    }
    // Silent by default. Judge is best-effort; the regex+vocab layer already shipped.
  }
}

/**
 * Resolve the judge endpoint URL. Honors PRIVACY_SCREEN_JUDGE_ENDPOINT for
 * tests; otherwise builds `http://127.0.0.1:${PRIVACY_SCREEN_PORT ?? 31338}/api/judge`.
 * Returns null if the resolved URL fails parse or is not loopback.
 */
function judgeEndpoint(): string | null {
  const override = process.env.PRIVACY_SCREEN_JUDGE_ENDPOINT;
  const port = process.env.PRIVACY_SCREEN_PORT ?? '31338';
  const url = override ?? `http://127.0.0.1:${port}/api/judge`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return url;
}

main().catch((err) => {
  process.stderr.write(`[PrivacyScreen] Fatal error — blocking for safety: ${err}\n`);
  process.exit(2);
});
