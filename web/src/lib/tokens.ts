import type { Token } from '../api';

/**
 * Shared token-run / de-anon utilities (extracted for #92).
 * Single source of truth for TOKEN_RE grammar + render splitting + token union merge.
 *
 * Server mint format (src/scrub-map.ts, src/scrubber.ts):
 *   {TYPE}, {TYPE_1}, {TYPE_2}…   (base uses [A-Z0-9]* then optional _\d+ suffix)
 * The render RE is intentionally permissive on _ (for safety in matchAll on wire text)
 * but the mint never produces embedded _ in the base type.
 */

export const TOKEN_RE = /\{[A-Z][A-Z0-9_]*\}/g;

export type Run =
  | { type: 'text'; text: string }
  | { type: 'token'; raw: string; meta: Token | null };

/**
 * Split scrubbed (still-tokenized) text into runs of plain text and token pills.
 * Used for both the live preview and the assistant reply view (wire vs real).
 * Lookup uses the provided tokens list (current turn); callers merge with tokenUnion
 * when they need prior-turn tokens for deanonymization.
 */
export function tokenizeForRender(scrubbed: string, tokens: Token[]): Run[] {
  if (!scrubbed) return [];
  const byToken = new Map<string, Token>();
  for (const t of tokens) byToken.set(t.token, t);
  const out: Run[] = [];
  let lastIdx = 0;
  for (const m of scrubbed.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > lastIdx) out.push({ type: 'text', text: scrubbed.slice(lastIdx, i) });
    const raw = m[0];
    out.push({ type: 'token', raw, meta: byToken.get(raw) ?? null });
    lastIdx = i + raw.length;
  }
  if (lastIdx < scrubbed.length) out.push({ type: 'text', text: scrubbed.slice(lastIdx) });
  return out;
}

/**
 * Merge multiple token sources (arrays or Maps) into a single de-duplicated Token[]
 * preserving first-seen order. Current-turn tokens first, then cross-session union, etc.
 * Replaces the duplicated inline merge logic previously in ScrubSend (replyTokens)
 * and VocabularyPage (buildRows token-union portion).
 */
export function mergeTokenSources(
  ...sources: (readonly Token[] | Map<string, Token>)[]
): Token[] {
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const src of sources) {
    const list: Token[] = src instanceof Map ? Array.from(src.values()) : (src as Token[]);
    for (const t of list) {
      if (t && t.token && !seen.has(t.token)) {
        seen.add(t.token);
        out.push(t);
      }
    }
  }
  return out;
}
