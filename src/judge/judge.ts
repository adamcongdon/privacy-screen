/**
 * Judge — the out-of-band local LLM secondary validator.
 *
 * Reads already-scrubbed text and asks an LLM to flag residual PII the regex
 * +vocab layer might have missed. Pure logic — all I/O is behind `LlmClient`.
 * The judge is non-fatal by design: every failure path returns
 * `{ spans: [], errorReason }` instead of throwing, so the hook's fire-and-
 * forget caller never crashes on a misbehaving model.
 *
 * Filtering rules (in order): too-short input → input_too_short; overlap with
 * an existing token (already known to the upstream scrubber) → dropped; below
 * `minConfidence` → dropped; malformed entries → dropped silently.
 */

import { ScrubMap } from '../scrub-map';
import { buildJudgePrompt } from './prompt';
import {
  normalizeCategory,
  type ReviewCategory,
} from './normalize';
import type { LlmClient } from './llm-client';

/** A single span the judge wants the operator to triage. */
export interface SuspiciousSpan {
  text: string;
  category: ReviewCategory;
  confidence: number;
  reason: string;
}

/** Per-call options. All fields are required at the call site — callers supply defaults. */
export interface JudgeOptions {
  client: LlmClient;
  /** Wall-clock budget per call (ms). */
  timeoutMs: number;
  /** Hard cap on model response tokens. */
  maxTokens: number;
  /** Hard cap on returned spans (also communicated to the model). */
  maxSpans: number;
  /** Spans below this confidence are dropped. */
  minConfidence: number;
}

/** Result of a judge run. `errorReason` is null on success. */
export interface JudgeResult {
  spans: SuspiciousSpan[];
  errorReason: string | null;
}

/** Minimum scrubbed-text length worth sending to the model. */
const MIN_INPUT_LENGTH = 24;
/** Max length of `text` field stored per span. */
const MAX_SPAN_TEXT = 200;
/** Max length of `reason` field stored per span. */
const MAX_SPAN_REASON = 280;
/** Matches scrubber-emitted tokens like {PERSON_33}, {IP_1}, {CUSTOMER_8}. */
const SCRUB_TOKEN_RE = /\{[A-Z][A-Z0-9]*(?:_\d+)?\}/g;
/** Neutral placeholder shown to the model instead of scrubber tokens. */
const NEUTRAL_PLACEHOLDER = '[*]';
/** Max characters per chunk sent to the model. Keeps output within max_tokens budget. */
const MAX_CHUNK_CHARS = 1800;

/**
 * Run the judge against `scrubbed`. Long inputs are split into chunks so each
 * fits within the model's max_tokens budget. Never throws — failures collapse
 * to an empty spans array with a descriptive `errorReason`.
 */
export async function runJudge(
  scrubbed: string,
  tokenMap: ScrubMap,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  if (scrubbed.length < MIN_INPUT_LENGTH) {
    return { spans: [], errorReason: 'input_too_short' };
  }

  const masked = scrubbed.replace(SCRUB_TOKEN_RE, NEUTRAL_PLACEHOLDER);
  const chunks = chunkText(masked, MAX_CHUNK_CHARS);

  const spans: SuspiciousSpan[] = [];
  const seen = new Set<string>();
  let lastError: string | null = null;

  for (const chunk of chunks) {
    if (spans.length >= opts.maxSpans) break;
    const result = await runChunk(chunk, tokenMap, opts, seen, spans);
    if (result.errorReason) lastError = result.errorReason;
  }

  return { spans, errorReason: spans.length === 0 ? lastError : null };
}

/** Run the judge against a single chunk, accumulating into the shared spans+seen. */
async function runChunk(
  chunk: string,
  tokenMap: ScrubMap,
  opts: JudgeOptions,
  seen: Set<string>,
  spans: SuspiciousSpan[],
): Promise<{ errorReason: string | null }> {
  const { system, user } = buildJudgePrompt(chunk, opts.maxSpans - spans.length);

  let raw: string;
  try {
    raw = await opts.client.complete({
      system,
      user,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return { errorReason: `parse_failed: ${errMessage(err)}` };
  }

  const cleaned = stripMarkdownFences(raw);
  process.stderr.write(`[privacy-screen] judge.raw: ${cleaned}\n`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { errorReason: `parse_failed: ${errMessage(err)}` };
  }

  for (const candidate of extractSpans(parsed)) {
    if (spans.length >= opts.maxSpans) break;
    const span = validateAndShape(candidate, tokenMap, opts.minConfidence);
    if (span && !seen.has(span.text)) {
      seen.add(span.text);
      spans.push(span);
    }
  }

  return { errorReason: null };
}

/** Pull spans from the parsed JSON — handles both {suspicious_spans:[]} and bare []. */
function extractSpans(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = (parsed as { suspicious_spans?: unknown }).suspicious_spans;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Validate one candidate span. Returns the shaped `SuspiciousSpan` or null if
 * the entry is malformed, too short, already-tokenized, or below confidence.
 */
function validateAndShape(
  candidate: unknown,
  tokenMap: ScrubMap,
  minConfidence: number,
): SuspiciousSpan | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const c = candidate as Record<string, unknown>;
  if (
    typeof c.text !== 'string' ||
    typeof c.category !== 'string' ||
    typeof c.confidence !== 'number' ||
    typeof c.reason !== 'string'
  ) {
    return null;
  }
  if (c.confidence < minConfidence) return null;
  if (c.text.length < 2) return null;
  if (tokenMap.tokenFor(c.text) !== undefined) return null;
  // Drop spans that are or contain scrubber token placeholders (defense-in-depth).
  if (/\{[A-Z][A-Z0-9]*(?:_\d+)?\}/.test(c.text)) return null;
  // Drop spans that are exactly the neutral placeholder the model saw.
  const trimmed = c.text.trim();
  if (trimmed === '[*]' || trimmed === '*') return null;

  return {
    text: c.text.slice(0, MAX_SPAN_TEXT),
    category: normalizeCategory(c.category),
    confidence: c.confidence,
    reason: c.reason.slice(0, MAX_SPAN_REASON),
  };
}

/**
 * Split text into chunks of at most `maxChars` characters, preferring to
 * break on blank lines, then newlines, then spaces.
 */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length >= MIN_INPUT_LENGTH) chunks.push(remaining);
  return chunks;
}

/** Best-effort message extraction from `unknown` thrown values. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Strip markdown code fences (```json ... ``` or ``` ... ```) from model output. */
function stripMarkdownFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}
