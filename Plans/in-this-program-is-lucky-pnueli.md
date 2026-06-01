# Pattern Induction (Non-ML) for privacy-screen

## Context

**Problem.** Today the user can right-click → "Custom…" to mint values under a chosen category (e.g. `INC-12345` as `TICKET`). Each subsequent occurrence requires another manual mint — the program never generalizes. README explicitly states "regex, not ML — it will miss novel name formats." The user's question: can we add automatic detection of *user-minted* pattern shapes *without* invoking AI?

**Answer.** Yes. The vocab table already stores labeled examples (`real_value` grouped by `category`). A deterministic character-class generalizer over those rows can synthesize a regex per category and feed it into the existing detection pipeline through the existing review queue. No model, no training data outside the user's own confirmed mints, no network calls.

**Intended outcome.** After the user mints ≥ N (default 3) values under the same category, the system proposes a regex covering them; the user accepts/edits/rejects via the existing ReviewQueue surface; on accept, the regex runs as one more pass inside `scrubText()` and flags new matches into the same review queue for confirmation.

**Precondition flagged.** `Plans/BUG-forget-deanon.md` (open) — the client `tokenUnion` doesn't evict on forget. Induction will multiply mints; the leak surface grows with it. Either fix that bug first or accept it explicitly as known scope.

## Approach

Five additive pieces, each in isolation testable. No changes to existing built-in regex factories. No changes to the `vocab` table schema (one new sibling table + one optional column on `review_queue`).

### 1. Induction algorithm — `src/induction.ts` (new, pure)

Single exported function:

```ts
export function induceRegex(examples: string[], opts?: InductionOpts): InducedPattern | null;

export interface InducedPattern {
  source: RegExp;       // the generalized regex (global, anchored with \b where possible)
  examples: string[];   // the inputs it was built from
  skeleton: string;     // human-readable shape, e.g. "INC-\d{5}"
  coverage: number;     // fraction of examples matched by the synthesized regex (sanity)
  specificity: number;  // heuristic score: literal-character ratio
}
```

Algorithm (deterministic, no ML):

1. **Tokenize** each example into a run-length sequence of character classes:
   - `[A-Z]+` → `U{n}`
   - `[a-z]+` → `L{n}`
   - `\d+` → `D{n}`
   - punctuation/separators kept as literals (`-`, `_`, `/`, `.`, `:`, space)
2. **Align** token sequences. If all examples share the same skeleton (token-class sequence + literal positions), emit `\bU{n}\d{n}\b`-style regex with concrete `{n}` ranges (min..max across examples).
3. **Generalize divergence**: where literal-position tokens differ, fall back to longest-common-prefix + longest-common-suffix + middle wildcard (`.{m,n}` bounded). If no common anchor exists across ≥ 2 literal characters, abort and return `null` (refuses to over-generalize).
4. **Specificity guard**: reject if regex would match more than ~80% of a small "negative" sample (use `NAME_DENYLIST` and a frozen set of common-English-word stems as the negative corpus — already in `patterns.ts`). Reject if `specificity < 0.3` (mostly wildcards).
5. **Anchor**: always wrap in `\b…\b` unless the skeleton begins/ends with non-word characters. Always set global flag.

Pure function, zero I/O, fully unit-testable with `bun test`.

### 2. Schema additions — `src/vocab.ts`

Add one new table; do not modify existing tables.

```sql
CREATE TABLE IF NOT EXISTS induced_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  regex_source TEXT NOT NULL,
  skeleton TEXT NOT NULL,
  source_examples TEXT NOT NULL,   -- JSON array
  example_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | active | rejected
  confidence REAL NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_induced_category ON induced_patterns(category, status);
```

New methods on `VocabStore`:

- `vocabByCategory(category: string): VocabRow[]` — `SELECT * FROM vocab WHERE category = ? ORDER BY hit_count DESC, last_seen DESC LIMIT 50`. Aggregator that today is missing.
- `categoriesAboveThreshold(min: number): {category: string, count: number}[]` — `SELECT category, COUNT(*) c FROM vocab GROUP BY category HAVING c >= ?`.
- `activePatterns(): InducedPatternRow[]` — `WHERE status='active'`, cached behind `getMap()`-style memoization in `server/lib/vocab-store.ts`.
- `persistInducedPattern(row)`, `setInducedStatus(id, status)`, `bumpInducedHit(id)`.

### 3. Detection pipeline — `src/scrubber.ts`

Insert one new pass **after** the corp-entity review-queue block (currently `scrubber.ts:174-194`) and **before** `map.apply(text)` (`scrubber.ts:196`).

```ts
// Step 3b: induced user patterns
if (vocab) {
  for (const p of vocab.activePatterns()) {
    const rx = compileRegex(p);  // memoized
    for (const m of text.matchAll(rx)) {
      const span = m[0];
      if (map.tokenFor(span) !== undefined) continue;
      if (vocab.isAllowlisted(span)) continue;
      const surrounding = sliceContext(text, m.index ?? 0, span.length);
      // Route through existing review_queue, NOT direct mint — user confirms each new match
      unsure.push({ span, surrounding, suggestedCategory: p.category, confidence: p.confidence });
      vocab.addReviewItem({ span, surrounding, suggested_cat: p.category,
        confidence: p.confidence, source_event: ctx.sourceEvent });
      vocab.bumpInducedHit(p.id);
    }
  }
}
```

This reuses the existing `unsureSpans` + `review_queue` channel — no UI work in the scrub-result panel itself. New matches just appear in the ReviewQueue with the user's own category as `suggested_cat`.

**Trigger for induction itself** (when do we *create* a candidate?): expose a CLI verb + a backend endpoint. Not implicit on every mint (would be chatty). The first cut is explicit: user clicks "Suggest Patterns" in the Token Map panel, or runs `bun cli/PrivacyScreen.ts induct`. Optional follow-up: a `vocab.ts` trigger that, after `persistMint`, checks `categoriesAboveThreshold(3)` and enqueues a one-shot induction job.

### 4. HTTP surface — `server/routes/patterns.ts` (new)

Mirror `server/routes/review.ts` style. Hono instance exported as `patternsRoute`, mounted in `server/server.ts`.

- `POST /api/patterns/suggest` — body `{category?: string}`. If category given, runs `induceRegex(vocab.vocabByCategory(category))`. If omitted, runs over every category with `count ≥ 3`. Persists results to `induced_patterns` with `status='pending'`. Returns the new rows.
- `GET /api/patterns` — list pending + active patterns.
- `POST /api/patterns/:id` — body `{action: 'activate'|'reject'|'edit', regex?: string}`. On `activate`: `setInducedStatus(id, 'active')` + `resetVocab()` (invalidate cached pattern list). On `edit`: validate the user-provided regex compiles, run it back over the source examples to confirm coverage, then store.
- `DELETE /api/patterns/:id` — hard delete.

Reuse `rateLimited()` and `CRED_RE` guards already in `server/routes/vocab.ts`. Validate `regex_source` compiles inside a try/catch and reject `(?{...}` / lookbehind that ReDoS-attacks (cap pattern length, reject `(.*)*`-style nested quantifiers via a structural check).

### 5. UI — `web/src/components/ReviewQueue.tsx` + new `PatternSuggestions.tsx`

Two surfaces:

- **`PatternSuggestions.tsx`** (new sibling component in the right-hand panel): lists `induced_patterns` rows with `status='pending'`. Each row shows: skeleton (`INC-\d{5}`), example list, "Activate" / "Edit regex" / "Reject" buttons. Editing opens a small dialog showing live match-count against the most recent scrub input.
- **`ReviewQueue.tsx`**: no structural change. New matches from an active induced pattern already arrive as `ReviewItem` rows with `suggested_cat` set to the user's category. The existing `reviewAction(id, 'confirm', type)` already mints them.

Store wiring in `web/src/store.ts`: new slice `patterns: InducedPattern[]`, actions `refreshPatterns()`, `suggestPatterns(category?)`, `patternAction(id, action, regex?)`. Mirror the `reviewItems` slice shape exactly.

Polling: piggyback on the existing 8s `refreshReview()` interval — add `refreshPatterns()` to the same loop in `ReviewQueue.tsx`.

### 6. CLI — `cli/PrivacyScreen.ts`

New subcommand following the `review` template (`PrivacyScreen.ts:50-110` is the example):

- `bun cli/PrivacyScreen.ts induct` — interactive: list categories above threshold, run `induceRegex` per category, show each candidate, prompt accept/edit/reject, persist.
- `bun cli/PrivacyScreen.ts induct --category TICKET --auto` — non-interactive single category.
- `bun cli/PrivacyScreen.ts patterns list|delete <id>` — manage stored patterns.

Update `printHelp()` (`cli/PrivacyScreen.ts:216-230`).

## Files Modified / Created

**New:**
- `src/induction.ts` — pure induction algorithm
- `tests/induction.test.ts` — algorithm unit tests (16+ cases)
- `server/routes/patterns.ts` — HTTP surface
- `web/src/components/PatternSuggestions.tsx` — UI surface

**Modified:**
- `src/vocab.ts:37-80` — add `induced_patterns` table DDL; add `vocabByCategory`, `categoriesAboveThreshold`, `activePatterns`, `persistInducedPattern`, `setInducedStatus`, `bumpInducedHit`
- `src/scrubber.ts:194` — insert induced-pattern pass between corp-entity step and `map.apply()`
- `server/server.ts` — mount `patternsRoute`
- `server/lib/vocab-store.ts` — memoize `activePatterns()` alongside existing map cache
- `web/src/api.ts` — add `suggestPatterns`, `patternAction`, `refreshPatterns`, plus types
- `web/src/store.ts:119-121` — add `patterns` slice + actions
- `web/src/components/ReviewQueue.tsx:24-30` — render `<PatternSuggestions/>` above the existing queue list
- `cli/PrivacyScreen.ts:26-46` — add `induct` and `patterns` cases; update help

**Not modified:**
- `src/patterns.ts` — built-in regex factories are untouched
- `src/scrub-map.ts` — token minting logic untouched
- `vocab` / `review_queue` / `allowlist` / `redaction_log` existing DDL — no migrations

## Verification

Run end-to-end:

1. `bun test tests/induction.test.ts` — algorithm correctness:
   - 3 examples `INC-12345 / INC-99001 / INC-00042` → `\bINC-\d{5}\b`
   - 2 examples (below threshold) → `null`
   - Divergent shapes `INC-123 / TKT-9999` → either common-prefix bail-out or `null`
   - Specificity guard: `["a", "b", "c"]` → `null`
   - Anchor: `192.168.1.1 / 10.0.0.1` should NOT be inducible if a built-in pattern already covers them (allowlist-by-builtin check).
2. `bun test tests/vocab.test.ts` — extend with new methods.
3. `bun test tests/scrubber.test.ts` — extend with a test that loads a `VocabStore` containing an `active` induced pattern, runs `scrubText()` over input containing a new match, asserts the match flows into `unsureSpans` with the right `suggestedCategory`.
4. `bun test tests/server-smoke.test.ts` — add coverage for `POST /api/patterns/suggest`, `POST /api/patterns/:id`.
5. Manual UI flow on `http://127.0.0.1:31338`:
   - Right-click → Custom… → mint `INC-12345` as `TICKET`. Repeat for `INC-99001`, `INC-00042`.
   - Click "Suggest Patterns" in the new panel; verify `\bINC-\d{5}\b` candidate appears.
   - Activate it.
   - Paste new input containing `INC-77777`; verify it appears in ReviewQueue with `suggested_cat=ticket`.
   - Confirm; verify it mints with the user's category.
6. CLI parity: `bun cli/PrivacyScreen.ts induct --category ticket --auto` produces the same regex deterministically.

## Out of Scope (deliberately)

- ML / embeddings / clustering — the user explicitly asked for non-AI.
- Cross-category induction (one pattern that matches multiple categories).
- Pattern decay / auto-deactivation when hit rate drops — add later if useful.
- Fixing `BUG-forget-deanon.md` — flagged as adjacent risk; track in its own plan.
- Modifying built-in patterns in `src/patterns.ts`.
