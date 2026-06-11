/**
 * Bidirectional token map for reversible PII anonymization.
 * Ported from an internal C# reference implementation.
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

/**
 * Versioned envelope for over-the-wire transport of a ScrubMap. `v=1` is the
 * current format. Bump `v` when the wire shape changes; deserialize refuses
 * any unknown version rather than silently accepting it.
 */
export interface SerializedScrubMap {
  v: 1;
  entries: Array<{ token: string; real: string }>;
}

/**
 * Node in the apply() prefix trie. Keyed by single (lowercased) code points so
 * lookups mirror the old case-insensitive alternation regex. `token` is set on
 * the node that completes a stored real value.
 */
interface TrieNode {
  children: Map<string, TrieNode>;
  token: string | null;
}

// A "word char" for boundary purposes — must match the old regex's
// (?<![\p{L}\p{N}_]) / (?![\p{L}\p{N}_]) anchors exactly. Not global: callers
// pass a single code point, so there is no lastIndex state to reset.
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
function isWordChar(ch: string): boolean {
  return WORD_CHAR_RE.test(ch);
}

export class ScrubMap {
  // keyed by lowercase real value for case-insensitive lookup
  private realToToken = new Map<string, string>();
  // keyed by token (case-sensitive, tokens are always uppercase)
  private tokenToReal = new Map<string, string>();
  // counts per TYPE so we know what the next N is
  private counters = new Map<string, number>();

  // #63 cache: prefix-trie automaton for apply(); invalidated on any mint or load.
  // Replaces a 5000-branch alternation RegExp whose *match* cost (not compile
  // cost) dominated — a trie makes apply() O(text · maxKeyLen) instead of
  // O(text · vocabSize). Output is byte-identical to the old regex (see the
  // semantics notes on apply() and tests/scrub-map-parity.test.ts).
  private _applyTrie: TrieNode | null = null;

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
    this._applyTrie = null; // #63: invalidate apply trie on map mutation
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
    this._applyTrie = null; // #63: invalidate apply trie on load (repopulates map)
  }

  /**
   * Apply token substitution to text using longest-first matching.
   *
   * Behaviour is byte-identical to the previous implementation, which compiled
   * the vocabulary into one alternation regex sorted longest-first:
   *   /(?<![\p{L}\p{N}_])VALUE1|VALUE2|…(?![\p{L}\p{N}_])/giu
   * applied via String.replace(). That made each apply() O(text · vocabSize);
   * for the per-cell xlsx hot path against a 5k-entry map it was the dominant
   * cost (issue #63). A prefix trie reproduces the same semantics in
   * O(text · maxKeyLen):
   *   - case-insensitive (keys are stored lowercased; input is lowered per cp);
   *   - word-boundary anchored on both sides, where a word char is [\p{L}\p{N}_];
   *   - leftmost match wins, and at a given start the LONGEST value wins;
   *   - matches are non-overlapping — scanning resumes after each replacement.
   * The substitution emitted is the token, so the matched span's casing never
   * appears in output. See tests/scrub-map-parity.test.ts for the differential
   * proof against the original regex.
   */
  apply(text: string): string {
    if (this.realToToken.size === 0) return text;

    if (!this._applyTrie) this._applyTrie = this.buildApplyTrie();
    const root = this._applyTrie;

    // Operate on code points (the old regex used the `u` flag) so boundary
    // checks and slicing stay aligned with the original string.
    const cps = Array.from(text);
    const n = cps.length;
    let out = '';
    let i = 0;
    while (i < n) {
      // Left anchor: the char before the match start must not be a word char.
      const leftOk = i === 0 || !isWordChar(cps[i - 1]);
      let bestEnd = -1;
      let bestToken: string | null = null;
      if (leftOk) {
        let node: TrieNode = root;
        let j = i;
        while (j < n) {
          const child: TrieNode | undefined = node.children.get(
            cps[j].toLowerCase(),
          );
          if (!child) break;
          node = child;
          j++;
          // Right anchor: the char after the match end must not be a word char.
          if (node.token !== null && (j === n || !isWordChar(cps[j]))) {
            bestEnd = j; // keep descending — a longer key may also match
            bestToken = node.token;
          }
        }
      }
      if (bestToken !== null && bestEnd > i) {
        out += bestToken;
        i = bestEnd;
      } else {
        out += cps[i];
        i++;
      }
    }
    return out;
  }

  /**
   * Build the apply() prefix trie from the current vocabulary. Keys are already
   * lowercased (case-insensitive storage), so the trie branches on lowercased
   * code points and apply() lowercases the input per code point to match.
   */
  private buildApplyTrie(): TrieNode {
    const root: TrieNode = { children: new Map(), token: null };
    for (const [key, token] of this.realToToken) {
      let node = root;
      for (const cp of key) {
        let next = node.children.get(cp);
        if (!next) {
          next = { children: new Map(), token: null };
          node.children.set(cp, next);
        }
        node = next;
      }
      node.token = token;
    }
    return root;
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

  /**
   * Emit a versioned, JSON-safe envelope of this map's token → real-value
   * pairs. Walks `tokenToReal` so original casing is preserved.
   */
  serialize(): SerializedScrubMap {
    const entries: Array<{ token: string; real: string }> = [];
    for (const [token, real] of this.tokenToReal.entries()) {
      entries.push({ token, real });
    }
    return { v: 1, entries };
  }

  /**
   * Build a fresh `ScrubMap` from a serialized envelope. Throws on shape
   * mismatch (null, wrong version, non-array entries). Malformed individual
   * entries (missing/wrong-typed fields) are dropped silently so a partially
   * corrupt payload still produces a usable map.
   */
  static deserialize(payload: unknown): ScrubMap {
    if (!payload || typeof payload !== 'object') {
      throw new Error('ScrubMap.deserialize: payload must be an object');
    }
    const p = payload as Record<string, unknown>;
    if (p.v !== 1) {
      throw new Error(`ScrubMap.deserialize: unsupported version ${String(p.v)}`);
    }
    if (!Array.isArray(p.entries)) {
      throw new Error('ScrubMap.deserialize: entries must be an array');
    }
    const rows: Array<{ real_value: string; token: string }> = [];
    for (const entry of p.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.token !== 'string' || typeof e.real !== 'string') continue;
      rows.push({ real_value: e.real, token: e.token });
    }
    const map = new ScrubMap();
    map.loadFromRows(rows);
    return map;
  }
}
