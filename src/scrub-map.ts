/**
 * Bidirectional token map for reversible PII anonymization.
 * Port of se-lz/src/SECC.Core/Models/ScrubMap.cs
 *
 * Token format: {TYPE} for first instance, {TYPE_1} for second, {TYPE_2} for third…
 * Curly-brace format avoids markdown bold/italic corruption.
 *
 * Case handling: lookups are case-insensitive (real→token), storage preserves
 * original case (token→real) so restored values match the original.
 */

// Detects values that ARE themselves token-shaped — refusing them prevents
// vocabulary corruption where a customer literally named "{CUSTOMER}" would
// create a self-referential entry that defeats scrubbing.
// Note: base type uses [A-Z0-9]* (NO underscore) so the optional _\d+ suffix
// parses unambiguously: {SERVER_2} → type=SERVER, n=2.
const TOKEN_SHAPE_RE = /^\{[A-Z][A-Z0-9]*(?:_\d+)?\}$/;

export interface MintResult {
  token: string;
  isNew: boolean;
}

export class ScrubMap {
  // keyed by lowercase real value for case-insensitive lookup
  private realToToken = new Map<string, string>();
  // keyed by token (case-sensitive, tokens are always uppercase)
  private tokenToReal = new Map<string, string>();
  // counts per TYPE so we know what the next N is
  private counters = new Map<string, number>();

  get size(): number {
    return this.realToToken.size;
  }

  get isEmpty(): boolean {
    return this.realToToken.size === 0;
  }

  /**
   * Returns the token for realValue, minting a new one if not yet mapped.
   * Idempotent: same input always returns same token.
   * Returns the existing token and isNew=false on repeat calls.
   */
  mint(type: string, realValue: string): MintResult {
    if (TOKEN_SHAPE_RE.test(realValue)) {
      return { token: realValue, isNew: false };
    }

    const key = realValue.toLowerCase();
    const existing = this.realToToken.get(key);
    if (existing !== undefined) {
      return { token: existing, isNew: false };
    }

    const n = this.counters.get(type) ?? 0;
    this.counters.set(type, n + 1);
    const token = n === 0 ? `{${type}}` : `{${type}_${n}}`;

    this.realToToken.set(key, token);
    this.tokenToReal.set(token, realValue); // preserve original casing
    return { token, isNew: true };
  }

  /**
   * Look up the token for a real value (case-insensitive).
   */
  tokenFor(realValue: string): string | undefined {
    return this.realToToken.get(realValue.toLowerCase());
  }

  /**
   * Look up the real value for a token (case-sensitive, tokens are uppercase).
   */
  realFor(token: string): string | undefined {
    return this.tokenToReal.get(token);
  }

  /**
   * Populate this map from serialized vocab rows (used when loading from SQLite).
   * Reconstructs counters from the token strings.
   */
  loadFromRows(rows: Array<{ real_value: string; token: string }>): void {
    for (const { real_value, token } of rows) {
      if (TOKEN_SHAPE_RE.test(real_value)) continue;
      this.realToToken.set(real_value.toLowerCase(), token);
      this.tokenToReal.set(token, real_value);
    }
    // Reconstruct counters: {SERVER_2} means the SERVER counter must be at 3 (next is _3).
    // [A-Z0-9]* (no underscore) ensures the base type parses cleanly from the _N suffix.
    for (const token of this.tokenToReal.keys()) {
      const m = token.match(/^\{([A-Z][A-Z0-9]*)(?:_(\d+))?\}$/);
      if (!m) continue;
      const type = m[1];
      const n = m[2] ? parseInt(m[2], 10) + 1 : 1;
      const cur = this.counters.get(type) ?? 0;
      if (n > cur) this.counters.set(type, n);
    }
  }

  /**
   * Apply token substitution to text using longest-first matching.
   * Uses lookaround anchors to prevent substring false matches.
   */
  apply(text: string): string {
    if (this.realToToken.size === 0) return text;

    // Sort entries longest-first so "Acme Corp" wins over "Acme"
    const entries = [...this.realToToken.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );

    // Build alternation regex from escaped real values (case-insensitive)
    const pattern = entries
      .map(([k]) => `(?<![\\w])${escapeRegex(k)}(?![\\w])`)
      .join('|');

    const rx = new RegExp(pattern, 'gi');
    return text.replace(rx, (match) => {
      const token = this.realToToken.get(match.toLowerCase());
      return token ?? match;
    });
  }

  /**
   * Restore tokens to real values in text. Longest-token-first to prevent
   * partial token matches (e.g. {SERVER_10} must be replaced before {SERVER_1}).
   */
  restore(text: string): string {
    if (this.tokenToReal.size === 0) return text;

    const entries = [...this.tokenToReal.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );

    let result = text;
    for (const [token, real] of entries) {
      if (result.includes(token)) {
        result = result.split(token).join(real);
      }
    }
    return result;
  }

  entries(): IterableIterator<[string, string]> {
    return this.tokenToReal.entries();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
