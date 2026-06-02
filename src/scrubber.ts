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
  mkPhone, mkStreetAddress, mkCreditCard, mkUrlPath, mkSensitiveKV,
  mkCredential, mkMac, mkGuid, mkCorpEntity, isFqdnAllowed,
  mkPersonFromHeader, mkPersonAdjacentToEmail, mkSignOffName,
  isValidPersonName, looksLikeIdentifier, looksLikeDate,
} from './patterns';
import { ScrubMap, type MintResult } from './scrub-map';
import { VocabStore } from './vocab';
import { loadConfig, type PrivacyConfig } from './config';

// Lazy import to avoid a circular dependency — the server-side vocab-store
// is only available when running inside the server process. Tests that run
// against the raw scrubber use `vocab: null` and never exercise Step 3b.
let _getActivePatterns: (() => Array<{ id: number; category: string; confidence: number; rx: RegExp }>) | null = null;

function loadGetActivePatterns(): (() => Array<{ id: number; category: string; confidence: number; rx: RegExp }>) | null {
  if (_getActivePatterns !== null) return _getActivePatterns;
  try {
    // Dynamic require — only works inside the server process where the module is available
    const mod = require('../server/lib/vocab-store');
    if (typeof mod.getActivePatterns === 'function') {
      _getActivePatterns = mod.getActivePatterns;
    }
  } catch {
    _getActivePatterns = () => [];
  }
  return _getActivePatterns;
}

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
  /** Optional config — falls back to loadConfig() if absent. */
  config?: PrivacyConfig;
}

/**
 * Scrub text: detect credentials (BLOCK ALWAYS), detect PII (tokenize),
 * detect uncertain spans (review queue). Returns a ScrubResult.
 */
export function scrubText(
  text: string,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
): ScrubResult {
  if (!text) {
    return emptyResult(text);
  }

  const cfg = ctx.config ?? loadConfig();
  const minted: MintedToken[] = [];
  const unsure: UnsureSpan[] = [];
  let credentialSnippets: string[] = [];

  // Pre-populate map with user-configured customer + person names so they
  // always tokenize as CUSTOMER_N / PERSON_N. Idempotent — already-minted
  // entries are reused. Allowlisted names are skipped so the "forget" flow
  // can permanently silence a previously-minted name.
  preMintCustomers(map, vocab, cfg);
  preMintPersons(map, vocab, cfg);

  // ── Step 1: Credential check — BLOCK ALWAYS ──────────────────────────────
  const credMatches = [...text.matchAll(mkCredential())];
  if (credMatches.length > 0) {
    credentialSnippets = credMatches.map((m) => redactCredential(m[0]));
    // Continue to scrub the rest — hasCredentials still signals block to caller
  }

  // Sensitive key=value pairs — value portion redacted, not tokenized
  const kvMatches = [...text.matchAll(mkSensitiveKV())];
  if (kvMatches.length > 0) {
    for (const m of kvMatches) {
      credentialSnippets.push(`${m[1]}=…`);
    }
  }

  // ── Step 2: Regex-detected PII — mint tokens in map ──────────────────────

  for (const m of text.matchAll(mkIpv4())) {
    maybeRecordMint(map, vocab, 'IP', m[0], 'ip', 1.0, minted);
  }
  for (const m of text.matchAll(mkIpv6())) {
    maybeRecordMint(map, vocab, 'IP', m[0], 'ip', 0.95, minted);
  }
  // Email — must run before FQDN so the domain part doesn't double-match
  for (const m of text.matchAll(mkEmail())) {
    maybeRecordMint(map, vocab, 'EMAIL', m[0], 'email', 1.0, minted);
  }

  // Person detection — three complementary patterns, each guarded by
  // isValidPersonName to reject denylist tokens and short single-word matches.
  // Runs after Email so the address itself is already a token by the time we
  // sweep for names alongside it. Allowlisted names are skipped via
  // maybeRecordMint (Feature 3 — "forget" must stick across re-scrubs).
  for (const m of text.matchAll(mkPersonFromHeader())) {
    const name = m[1];
    if (!isValidPersonName(name, cfg.name_allowlist)) continue;
    maybeRecordMint(map, vocab, 'PERSON', name, 'person', 0.92, minted);
  }
  for (const m of text.matchAll(mkPersonAdjacentToEmail())) {
    const name = m[1];
    if (!isValidPersonName(name, cfg.name_allowlist)) continue;
    maybeRecordMint(map, vocab, 'PERSON', name, 'person', 0.85, minted);
  }
  for (const m of text.matchAll(mkSignOffName())) {
    const name = m[1];
    if (!isValidPersonName(name, cfg.name_allowlist)) continue;
    maybeRecordMint(map, vocab, 'PERSON', name, 'person', 0.9, minted);
  }

  for (const m of text.matchAll(mkUncPath())) {
    maybeRecordMint(map, vocab, 'PATH', m[0], 'path', 1.0, minted);
  }
  for (const m of text.matchAll(mkDomainUser())) {
    maybeRecordMint(map, vocab, 'USER', m[0], 'domain_user', 0.95, minted);
  }
  for (const m of text.matchAll(mkMac())) {
    maybeRecordMint(map, vocab, 'MAC', m[0], 'mac', 1.0, minted);
  }
  for (const m of text.matchAll(mkGuid())) {
    maybeRecordMint(map, vocab, 'GUID', m[0], 'guid', 0.9, minted);
  }

  // New OpenAI-taxonomy parity categories
  for (const m of text.matchAll(mkPhone())) {
    maybeRecordMint(map, vocab, 'PHONE', m[0], 'phone', 0.9, minted);
  }
  for (const m of text.matchAll(mkStreetAddress())) {
    maybeRecordMint(map, vocab, 'ADDR', m[0], 'address', 0.85, minted);
  }
  for (const m of text.matchAll(mkCreditCard())) {
    maybeRecordMint(map, vocab, 'ACCOUNT', m[0], 'account_number', 0.95, minted);
  }
  // URL paths — only catch the full URL once; mkFqdn covers the bare host case
  for (const m of text.matchAll(mkUrlPath())) {
    // skip if the URL host is allowlisted (e.g. https://github.com/...)
    const hostMatch = m[0].match(/^https?:\/\/([^/]+)/);
    const host = hostMatch?.[1] ?? '';
    if (host && isFqdnAllowed(host, cfg.fqdn_allowlist_extra)) continue;
    maybeRecordMint(map, vocab, 'URL', m[0], 'url', 0.9, minted);
  }

  // FQDNs — skip allowlist entries (built-in + config extras + DB allowlist),
  // plus JS-identifier / CSS-selector chains that look domain-shaped but are
  // really code (`content.classList.contains`, `Array.prototype.indexOf`).
  // The maybeRecordMint helper *also* checks the DB allowlist, so the explicit
  // check here is redundant but kept for readability.
  for (const m of text.matchAll(mkFqdn())) {
    if (isFqdnAllowed(m[0], cfg.fqdn_allowlist_extra)) continue;
    if (vocab?.isAllowlisted(m[0])) continue;
    if (looksLikeIdentifier(m[0])) continue;
    if (looksLikeDate(m[0])) continue;
    maybeRecordMint(map, vocab, 'HOST', m[0], 'fqdn', 0.85, minted);
  }

  // ── Step 3: Heuristic Corp/Inc/LLC suspects → REVIEW QUEUE ───────────────
  // These are NOT minted automatically. They're written to the review queue
  // for Adam to confirm/allowlist/ignore via the CLI.
  for (const m of text.matchAll(mkCorpEntity())) {
    const span = m[0];
    // Skip if it's already in vocab (user already confirmed it) or allowlisted
    if (map.tokenFor(span) !== undefined) continue;
    if (vocab?.isAllowlisted(span)) continue;

    const surrounding = sliceContext(text, m.index ?? 0, span.length);
    unsure.push({ span, surrounding, suggestedCategory: 'customer', confidence: 0.6 });
    if (vocab) {
      vocab.addReviewItem({
        span,
        surrounding,
        suggested_cat: 'customer',
        confidence: 0.6,
        source_event: ctx.sourceEvent,
      });
    }
  }

  // ── Step 3b: User-induced patterns (active, confirmed via PatternSuggestions UI) ─
  // Runs regardless of persist so the scrubbed output always reflects active
  // patterns. DB writes (persistMint, bumpInducedHit) are skipped when vocab
  // is null (persist=false preview scrubs).
  const getActivePatterns = loadGetActivePatterns();
  const activePatterns = getActivePatterns ? getActivePatterns() : [];
  if (activePatterns.length > 0) {
    const hitIds = new Set<number>();
    for (const p of activePatterns) {
      p.rx.lastIndex = 0;
      for (const m of text.matchAll(p.rx)) {
        const span = m[0];
        if (map.tokenFor(span) !== undefined) continue;
        if (vocab?.isAllowlisted(span)) continue;
        const r = map.mint(p.category.toUpperCase(), span);
        if (vocab) vocab.persistMint(span, r.token, p.category, p.confidence);
        minted.push({ type: p.category.toUpperCase(), realValue: span, token: r.token, isNew: r.isNew, category: p.category, confidence: p.confidence });
        hitIds.add(p.id);
      }
    }
    if (vocab) {
      for (const id of hitIds) vocab.bumpInducedHit(id);
    }
  }

  // ── Step 4: Apply the token map to produce scrubbed text ─────────────────
  let scrubbed = map.apply(text);
  scrubbed = scrubbed.replace(mkCredential(), '[CREDENTIAL-REDACTED]');
  scrubbed = scrubbed.replace(mkSensitiveKV(), (_full, key) => `${key}=[REDACTED]`);

  const modified =
    scrubbed !== text ||
    credentialSnippets.length > 0 ||
    minted.some((t) => t.isNew) ||
    unsure.length > 0;

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
 * Scrub all string-valued fields in a tool_input object recursively,
 * skipping fields configured in PrivacyConfig.skip_scrub_fields[toolName].
 *
 * Why skip some fields: Edit's old_string/new_string must round-trip through
 * the tool unmodified or the file string match fails. Grep/Glob patterns
 * must match the actual file contents on disk, not their tokenized form.
 */
export function scrubToolInput(
  input: Record<string, unknown>,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
  toolName: string,
): { input: Record<string, unknown>; result: ScrubResult } {
  const cfg = ctx.config ?? loadConfig();
  const skipFields = new Set(cfg.skip_scrub_fields[toolName] ?? []);

  let combined: ScrubResult = emptyResult('');
  const ctxWithCfg: ScrubContext = { ...ctx, config: cfg };

  const scrubbed = scrubObject(input, map, vocab, ctxWithCfg, combined, skipFields, /*depth*/ 0);
  return { input: scrubbed as Record<string, unknown>, result: combined };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function emptyResult(text: string): ScrubResult {
  return {
    scrubbed: text,
    original: text,
    hasCredentials: false,
    credentialSnippets: [],
    mintedTokens: [],
    unsureSpans: [],
    modified: false,
  };
}

function preMintCustomers(
  map: ScrubMap,
  vocab: VocabStore | null,
  cfg: PrivacyConfig,
): void {
  for (const name of cfg.customer_names) {
    if (vocab?.isAllowlisted(name)) continue;
    if (map.tokenFor(name) !== undefined) continue;
    const r = map.mint('CUSTOMER', name);
    if (r.isNew && vocab) {
      vocab.persistMint(name, r.token, 'customer', 1.0);
    }
  }
}

function preMintPersons(
  map: ScrubMap,
  vocab: VocabStore | null,
  cfg: PrivacyConfig,
): void {
  for (const name of cfg.person_names) {
    if (vocab?.isAllowlisted(name)) continue;
    if (map.tokenFor(name) !== undefined) continue;
    const r = map.mint('PERSON', name);
    if (r.isNew && vocab) {
      vocab.persistMint(name, r.token, 'person', 1.0);
    }
  }
}

/**
 * Wrapper around recordMint that consults the DB allowlist first. The
 * "forget" flow adds a real value to the allowlist so it permanently bypasses
 * tokenization on subsequent scrubs — even credential and sensitive-KV pipes
 * still block, because those never call this helper.
 */
function maybeRecordMint(
  map: ScrubMap,
  vocab: VocabStore | null,
  type: string,
  realValue: string,
  category: string,
  confidence: number,
  minted: MintedToken[],
): void {
  if (vocab?.isAllowlisted(realValue)) return;
  recordMint(map, vocab, type, realValue, category, confidence, minted);
}

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

  const key = realValue.toLowerCase();
  if (!result.isNew && minted.some((m) => m.realValue.toLowerCase() === key)) return;

  minted.push({ type, realValue, token: result.token, isNew: result.isNew, category, confidence });

  if (result.isNew && vocab) {
    vocab.persistMint(realValue, result.token, category, confidence);
  }
}

function redactCredential(cred: string): string {
  return cred.length > 6 ? `${cred.slice(0, 6)}…` : '***';
}

function sliceContext(text: string, idx: number, len: number, radius = 32): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

function scrubObject(
  obj: unknown,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
  combined: ScrubResult,
  skipFields: Set<string>,
  depth: number,
): unknown {
  if (depth > 16) return obj; // pathological-nesting guard

  if (typeof obj === 'string') {
    const r = scrubText(obj, map, vocab, ctx);
    mergeResult(combined, r);
    return r.scrubbed;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => scrubObject(item, map, vocab, ctx, combined, skipFields, depth + 1));
  }
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (skipFields.has(k)) {
        // Still scan for credentials so we don't leak secrets via "skipped" fields,
        // but pass the value through unmodified.
        if (typeof v === 'string') {
          const creds = [...v.matchAll(mkCredential())];
          if (creds.length > 0) {
            combined.hasCredentials = true;
            combined.credentialSnippets.push(...creds.map((m) => redactCredential(m[0])));
          }
        }
        out[k] = v;
        continue;
      }
      out[k] = scrubObject(v, map, vocab, ctx, combined, skipFields, depth + 1);
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
