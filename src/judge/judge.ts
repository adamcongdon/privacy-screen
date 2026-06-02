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
import { buildJudgePrompt, JUDGE_SCHEMA } from './prompt';
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

/**
 * Run the judge against `scrubbed`. Never throws — failures collapse to an
 * empty spans array with a descriptive `errorReason`.
 */
export async function runJudge(
  scrubbed: string,
  tokenMap: ScrubMap,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  if (scrubbed.length < MIN_INPUT_LENGTH) {
    return { spans: [], errorReason: 'input_too_short' };
  }

  const { system, user } = buildJudgePrompt(scrubbed, opts.maxSpans);

  let raw: string;
  try {
    raw = await opts.client.complete({
      system,
      user,
      schema: JUDGE_SCHEMA,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return { spans: [], errorReason: `parse_failed: ${errMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { spans: [], errorReason: `parse_failed: ${errMessage(err)}` };
  }

  const rawSpans = extractSpans(parsed);
  const spans: SuspiciousSpan[] = [];
  for (const candidate of rawSpans) {
    if (spans.length >= opts.maxSpans) break;
    const span = validateAndShape(candidate, tokenMap, opts.minConfidence);
    if (span) spans.push(span);
  }

  return { spans, errorReason: null };
}

/** Pull `suspicious_spans` off an unknown parsed JSON value, or return []. */
function extractSpans(parsed: unknown): unknown[] {
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

  return {
    text: c.text.slice(0, MAX_SPAN_TEXT),
    category: normalizeCategory(c.category),
    confidence: c.confidence,
    reason: c.reason.slice(0, MAX_SPAN_REASON),
  };
}

/** Best-effort message extraction from `unknown` thrown values. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
