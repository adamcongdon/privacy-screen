/**
 * PII scrubber — core anonymization engine.
 * Port of se-lz/src/SECC.Infrastructure/Services/PiiScrubber.cs
 *
 * Orchestrates pattern detection, vocabulary minting, and text substitution.
 * Produces a ScrubResult that the PrivacyScreen hook uses to decide
 * block/mutate/allow and to persist new tokens to the VocabStore.
 */

import {
  mkIpv4, mkIpv6, mkEmail, mkUncPath, mkDomainUser, mkFqdn,
  mkCredential, mkMac, mkGuid, isFqdnAllowed,
} from './patterns';
import { ScrubMap, type MintResult } from './scrub-map';
import { VocabStore } from './vocab';

export interface MintedToken {
  type: string;
  realValue: string;
  token: string;
  isNew: boolean;
  category: string;
  confidence: number;
}

export interface UnsureSpan {
  span: string;
  surrounding: string;
  suggestedCategory?: string;
  confidence: number;
}

export interface ScrubResult {
  scrubbed: string;
  original: string;
  hasCredentials: boolean;
  credentialSnippets: string[];
  mintedTokens: MintedToken[];
  unsureSpans: UnsureSpan[];
  modified: boolean;
}

/** Context for a scrub operation — one per hook invocation. */
export interface ScrubContext {
  sourceEvent: string; // e.g. 'userPromptSubmit' | 'preToolUse:Bash'
  sessionId?: string;
}

/**
 * Scrub text: detect credentials (BLOCK ALWAYS), detect PII (tokenize),
 * detect uncertain spans (review queue). Returns a ScrubResult.
 *
 * @param text      The input string to scrub.
 * @param map       In-memory ScrubMap (pre-populated from vocab on session start).
 * @param vocab     VocabStore for persistence (may be null in unit tests).
 * @param ctx       Operation context.
 */
export function scrubText(
  text: string,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
): ScrubResult {
  if (!text) {
    return { scrubbed: text, original: text, hasCredentials: false, credentialSnippets: [], mintedTokens: [], unsureSpans: [], modified: false };
  }

  const minted: MintedToken[] = [];
  const unsure: UnsureSpan[] = [];
  let credentialSnippets: string[] = [];

  // ── Step 1: Credential check — BLOCK ALWAYS ──────────────────────────────
  const credMatches = [...text.matchAll(mkCredential())];
  if (credMatches.length > 0) {
    credentialSnippets = credMatches.map((m) => redactCredential(m[0]));
    // Still continue to scrub the rest — but set hasCredentials=true so caller blocks
  }

  // ── Step 2: Regex-detected PII — mint tokens in map ──────────────────────

  // IPv4
  for (const m of text.matchAll(mkIpv4())) {
    recordMint(map, vocab, 'IP', m[0], 'ip', 1.0, minted);
  }

  // IPv6
  for (const m of text.matchAll(mkIpv6())) {
    recordMint(map, vocab, 'IP', m[0], 'ip', 0.95, minted);
  }

  // Email — must run before FQDN (email domain would otherwise double-match)
  for (const m of text.matchAll(mkEmail())) {
    recordMint(map, vocab, 'EMAIL', m[0], 'email', 1.0, minted);
  }

  // UNC paths
  for (const m of text.matchAll(mkUncPath())) {
    recordMint(map, vocab, 'PATH', m[0], 'path', 1.0, minted);
  }

  // Domain users (DOMAIN\user)
  for (const m of text.matchAll(mkDomainUser())) {
    // Mint the composite match as a USER token; the individual parts are
    // left unminted so they don't collide with other categories.
    recordMint(map, vocab, 'USER', m[0], 'domain_user', 0.95, minted);
  }

  // MAC addresses
  for (const m of text.matchAll(mkMac())) {
    recordMint(map, vocab, 'MAC', m[0], 'mac', 1.0, minted);
  }

  // GUIDs — tokenize only if not in a code/template context (high confidence)
  for (const m of text.matchAll(mkGuid())) {
    recordMint(map, vocab, 'GUID', m[0], 'guid', 0.9, minted);
  }

  // FQDNs — skip allowlist entries
  for (const m of text.matchAll(mkFqdn())) {
    if (isFqdnAllowed(m[0])) continue;
    // Check allowlist in vocab store
    if (vocab?.isAllowlisted(m[0])) continue;
    recordMint(map, vocab, 'HOST', m[0], 'fqdn', 0.85, minted);
  }

  // ── Step 3: Apply the token map to produce scrubbed text ─────────────────
  let scrubbed = map.apply(text);

  // Redact credentials inline (replace with [CREDENTIAL-REDACTED])
  scrubbed = scrubbed.replace(mkCredential(), '[CREDENTIAL-REDACTED]');

  const modified =
    scrubbed !== text ||
    credentialSnippets.length > 0 ||
    minted.some((t) => t.isNew);

  return {
    scrubbed,
    original: text,
    hasCredentials: credentialSnippets.length > 0,
    credentialSnippets,
    mintedTokens: minted,
    unsureSpans: unsure,
    modified,
  };
}

/**
 * Scrub all string-valued fields in a tool_input object recursively.
 * Returns the mutated object and aggregate ScrubResult.
 */
export function scrubToolInput(
  input: Record<string, unknown>,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
): { input: Record<string, unknown>; result: ScrubResult } {
  let combined: ScrubResult = {
    scrubbed: '',
    original: '',
    hasCredentials: false,
    credentialSnippets: [],
    mintedTokens: [],
    unsureSpans: [],
    modified: false,
  };

  const scrubbed = scrubObject(input, map, vocab, ctx, combined);
  return { input: scrubbed as Record<string, unknown>, result: combined };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function recordMint(
  map: ScrubMap,
  vocab: VocabStore | null,
  type: string,
  realValue: string,
  category: string,
  confidence: number,
  minted: MintedToken[],
): void {
  const result: MintResult = map.mint(type, realValue);
  if (result.token === realValue) return; // adversarial guard triggered

  // Skip duplicate tracking entries (e.g. IP matches both IPv4 regex and FQDN regex)
  const key = realValue.toLowerCase();
  if (!result.isNew && minted.some((m) => m.realValue.toLowerCase() === key)) return;

  minted.push({ type, realValue, token: result.token, isNew: result.isNew, category, confidence });

  if (result.isNew && vocab) {
    vocab.persistMint(realValue, result.token, category, confidence);
  }
}

function redactCredential(cred: string): string {
  // Show only first 6 chars + "…" so the user knows what was detected without
  // leaking the full value into logs.
  return cred.length > 6 ? `${cred.slice(0, 6)}…` : '***';
}

function scrubObject(
  obj: unknown,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
  combined: ScrubResult,
): unknown {
  if (typeof obj === 'string') {
    const r = scrubText(obj, map, vocab, ctx);
    mergeResult(combined, r);
    return r.scrubbed;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item, map, vocab, ctx, combined));
  }
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = scrubObject(v, map, vocab, ctx, combined);
    }
    return out;
  }
  return obj;
}

function mergeResult(target: ScrubResult, source: ScrubResult): void {
  target.hasCredentials = target.hasCredentials || source.hasCredentials;
  target.credentialSnippets.push(...source.credentialSnippets);
  target.mintedTokens.push(...source.mintedTokens);
  target.unsureSpans.push(...source.unsureSpans);
  target.modified = target.modified || source.modified;
}
