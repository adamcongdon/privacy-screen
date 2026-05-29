/**
 * De-anonymization helper.
 *
 * Replaces tokens in `text` with their realValue counterparts. Tokens are
 * sorted longest-first so {SERVER_10} is matched before {SERVER_1} would
 * partially consume it. Split-join is used instead of a regex so token
 * contents (which may contain regex metacharacters in theory, though they
 * never do in practice) cannot break the substitution.
 *
 * This is the ONLY place real PII is materialized for display. Network state
 * (composer, message history, API requests) always stays tokenized.
 */
export type TokenLike = { token: string; realValue: string };

export function deanonymize(text: string, tokens: ReadonlyArray<TokenLike>): string {
  if (!text || tokens.length === 0) return text;
  const sorted = [...tokens].sort((a, b) => b.token.length - a.token.length);
  let out = text;
  for (const { token, realValue } of sorted) {
    if (!token || !out.includes(token)) continue;
    out = out.split(token).join(realValue);
  }
  return out;
}
