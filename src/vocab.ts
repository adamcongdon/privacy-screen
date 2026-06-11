/**
 * SQLite-backed vocabulary store for PrivacyScreen.
 * Persists token mappings across hook invocations and sessions.
 * Schema: vocab, review_queue, allowlist, redaction_log.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { ScrubMap } from './scrub-map';

/** Extract the TYPE from a token string `{TYPE}` or `{TYPE_n}`. */
function tokenTypeOf(token: string): string {
  const m = /^\{([A-Z0-9]+?)(?:_\d+)?\}$/.exec(token);
  return m ? m[1] : token.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

export interface VocabRow {
  real_value: string;
  token: string;
  category: string;
  confidence: number;
  first_seen: number;
  last_seen: number;
  hit_count: number;
  project: string | null;
  confirmed_by: string | null;
}

export interface ReviewItem {
  span: string;
  surrounding: string;
  suggested_cat?: string;
  confidence: number;
  source_event: string;
}

export interface AllowlistRow {
  pattern: string;
  is_regex: number;
}

export interface InducedPatternRow {
  id: number;
  category: string;
  regex_source: string;
  skeleton: string;
  source_examples: string;
  example_count: number;
  status: string;
  confidence: number;
  first_seen: number;
  last_seen: number;
  hit_count: number;
}

export interface NewInducedPattern {
  category: string;
  regex_source: string;
  skeleton: string;
  source_examples: string[];
  confidence: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS vocab (
  real_value   TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  category     TEXT NOT NULL,
  confidence   REAL NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 1,
  project      TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_vocab_token    ON vocab(token);
CREATE INDEX IF NOT EXISTS idx_vocab_category ON vocab(category);

CREATE TABLE IF NOT EXISTS review_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  span         TEXT NOT NULL,
  surrounding  TEXT NOT NULL,
  suggested_cat TEXT,
  confidence   REAL NOT NULL,
  source_event TEXT NOT NULL,
  detected_at  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS allowlist (
  pattern   TEXT PRIMARY KEY,
  is_regex  INTEGER NOT NULL DEFAULT 0,
  added_by  TEXT NOT NULL DEFAULT 'user',
  added_at  INTEGER NOT NULL,
  reason    TEXT
);

CREATE TABLE IF NOT EXISTS redaction_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT,
  event          TEXT NOT NULL,
  tokens_minted  INTEGER NOT NULL DEFAULT 0,
  tokens_reused  INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  timestamp      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS induced_patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category        TEXT NOT NULL,
  regex_source    TEXT NOT NULL,
  skeleton        TEXT NOT NULL,
  source_examples TEXT NOT NULL,
  example_count   INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  confidence      REAL NOT NULL,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_induced_category ON induced_patterns(category, status);
`;

export class VocabStore {
  private db: Database;

  // #63 cache: precomputed allowlist for fast isAllowlisted (literals Set + precompiled regexes).
  // Invalidated on addAllowlist. Avoids repeated full SELECT + on-the-fly RegExp per lookup.
  private _allowlistCache: { literals: Set<string>; regexes: RegExp[] } | null = null;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    // SCR-03 (#56): concurrent hook processes write to one vocab.db. Without a
    // busy_timeout a second writer throws SQLITE_BUSY immediately; with it the
    // writer waits for the lock instead of failing mid-scrub.
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(DDL);
  }

  /** Load all confirmed vocab into a ScrubMap. */
  loadIntoMap(map: ScrubMap): void {
    const rows = this.db
      .query<Pick<VocabRow, 'real_value' | 'token'>, []>(
        `SELECT real_value, token FROM vocab WHERE confirmed_by IS NOT NULL`,
      )
      .all();
    map.loadFromRows(rows);
  }

  /**
   * Persist a newly minted token. Upserts on real_value conflict.
   *
   * Returns the token that is actually persisted for `realValue`. This is
   * usually the `token` passed in, but under cross-process contention
   * (SCR-03 / #56) two VocabStores with independent in-memory counters can
   * compute the same token for *different* real values. The first writer
   * wins the `token` UNIQUE constraint; the second would throw. Instead we
   * catch that specific conflict and atomically re-derive the next free token
   * for the type from the DB, so minting never throws and never duplicates a
   * token. Callers should adopt the returned token.
   */
  persistMint(
    realValue: string,
    token: string,
    category: string,
    confidence: number,
    project: string | null = null,
    force = false,
  ): string {
    const now = Date.now();
    // force=true: explicit user mint — overwrite category/token/confidence so the
    // user's intent always wins over a prior auto-detection under a different category.
    const conflictClause = force
      ? `DO UPDATE SET
           category = excluded.category,
           token = excluded.token,
           confidence = excluded.confidence,
           last_seen = excluded.last_seen,
           hit_count = hit_count + 1`
      : `DO UPDATE SET
           last_seen = excluded.last_seen,
           hit_count = hit_count + 1`;

    const insert = (tok: string): void => {
      this.db
        .query(
          `INSERT INTO vocab (real_value, token, category, confidence, first_seen, last_seen, hit_count, project, confirmed_by)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'auto')
           ON CONFLICT(real_value) ${conflictClause}`,
        )
        .run(realValue, tok, category, confidence, now, now, project);
    };

    let tok = token;
    // Bounded retry: each iteration re-derives the next free token for the type
    // and retries. The IMMEDIATE transaction + busy_timeout serialize writers,
    // so the loop converges in at most a few iterations under real contention.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        // If this real_value already owns a token, keep it (idempotent).
        const existing = this.db
          .query<{ token: string }, [string]>(`SELECT token FROM vocab WHERE real_value = ?`)
          .get(realValue);
        if (existing && !force) {
          insert(tok); // bumps hit_count/last_seen via ON CONFLICT(real_value)
          this.db.exec('COMMIT');
          return existing.token;
        }
        insert(tok);
        this.db.exec('COMMIT');
        return tok;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* no active txn */ }
        const msg = (err as Error)?.message ?? String(err);
        // Only retry on a token-UNIQUE collision (different real_value owns it).
        if (!/UNIQUE/i.test(msg) || !/token/i.test(msg)) throw err;
        const next = this.nextFreeToken(tokenTypeOf(tok));
        if (next === tok) throw err; // can't make progress — surface it
        tok = next;
      }
    }
    // Exhausted retries — last attempt outside the loop so the original error
    // surfaces rather than silently dropping the mint.
    insert(tok);
    return tok;
  }

  /**
   * Derive the next free token string for a token type by scanning existing
   * tokens of that type in the DB. Mirrors ScrubMap's `{TYPE}` / `{TYPE_n}`
   * shape: the first is `{TYPE}`, then `{TYPE_1}`, `{TYPE_2}`, …
   */
  private nextFreeToken(type: string): string {
    const rows = this.db
      .query<{ token: string }, [string, string]>(
        `SELECT token FROM vocab WHERE token = ? OR token LIKE ?`,
      )
      .all(`{${type}}`, `{${type}_%}`);
    const used = new Set(rows.map((r) => r.token));
    if (!used.has(`{${type}}`)) return `{${type}}`;
    let n = 1;
    while (used.has(`{${type}_${n}}`)) n++;
    return `{${type}_${n}}`;
  }

  /**
   * Add a span to the review queue (uncertain/heuristic detections).
   *
   * Allowlist gate (issue #41): spans that already match an allowlist entry
   * are silently dropped instead of being enqueued. Without this, a user
   * who allowlists a pattern keeps seeing the same span reappear on every
   * subsequent run, because the judge re-detects it and writes a fresh
   * pending row each time. Filtering at the canonical persistence layer
   * means every caller (judge, manual enqueue, future writers) gets the
   * guarantee for free. Returns true if the item was inserted, false if
   * it was suppressed by the allowlist.
   */
  addReviewItem(item: ReviewItem): boolean {
    if (this.isAllowlisted(item.span)) return false;
    this.db
      .query(
        `INSERT INTO review_queue (span, surrounding, suggested_cat, confidence, source_event, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.span,
        item.surrounding,
        item.suggested_cat ?? null,
        item.confidence,
        item.source_event,
        Date.now(),
      );
    return true;
  }

  /** Log a redaction event for telemetry. */
  logRedaction(
    sessionId: string | null,
    event: string,
    tokensMinted: number,
    tokensReused: number,
    blocked: boolean,
  ): void {
    this.db
      .query(
        `INSERT INTO redaction_log (session_id, event, tokens_minted, tokens_reused, blocked, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, event, tokensMinted, tokensReused, blocked ? 1 : 0, Date.now());
  }

  /** Check if a string matches any allowlist entry. */
  isAllowlisted(value: string): boolean {
    if (!this._allowlistCache) {
      // #63: build cache once (literals as Set for O(1), regexes precompiled).
      const rows = this.db
        .query<AllowlistRow, []>(`SELECT pattern, is_regex FROM allowlist`)
        .all();
      const literals = new Set<string>();
      const regexes: RegExp[] = [];
      for (const { pattern, is_regex } of rows) {
        if (is_regex) {
          try {
            regexes.push(new RegExp(pattern, 'i'));
          } catch {
            // malformed regex in DB — skip
          }
        } else {
          literals.add(pattern.toLowerCase());
        }
      }
      this._allowlistCache = { literals, regexes };
    }

    const lower = value.toLowerCase();
    if (this._allowlistCache.literals.has(lower)) return true;
    for (const rx of this._allowlistCache.regexes) {
      if (rx.test(value)) return true;
    }
    return false;
  }

  /** Add a literal or regex pattern to the allowlist. */
  addAllowlist(pattern: string, isRegex = false, reason?: string): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO allowlist (pattern, is_regex, added_by, added_at, reason)
         VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(pattern, isRegex ? 1 : 0, Date.now(), reason ?? null);
    this._allowlistCache = null; // #63: invalidate allowlist cache on mutation
  }

  /** Remove a vocab entry (for the CLI forget command). */
  forgetReal(realValue: string): boolean {
    const r = this.db
      .query(`DELETE FROM vocab WHERE real_value = ? COLLATE NOCASE`)
      .run(realValue);
    return (r as { changes: number }).changes > 0;
  }

  /**
   * Bulk clear the entire vocab table (for Settings "Clear vocab" / #87).
   * Single-statement DELETE is atomic. Returns #rows deleted.
   * Guarantees 1 request / 1 refresh pair / 1 toast no matter how many rows.
   */
  clearAll(): number {
    const r = this.db.query(`DELETE FROM vocab`).run();
    return (r as { changes: number }).changes;
  }

  /**
   * All pending review items.
   *
   * Allowlist filter (issue #41): rows that were queued BEFORE an
   * allowlist entry covered their span must also disappear from the
   * queue — otherwise the user has to manually click through stale
   * matches that they've already declared safe. We filter at read time
   * so the fix takes effect immediately on the next GET /api/review.
   */
  /** True if `value` already has a confirmed/auto token in the vocab table. */
  hasToken(value: string): boolean {
    const row = this.db
      .query<{ token: string }, [string]>(`SELECT token FROM vocab WHERE real_value = ?`)
      .get(value);
    return row !== null && row !== undefined;
  }

  pendingReview(): Array<ReviewItem & { id: number }> {
    const rows = this.db
      .query<ReviewItem & { id: number }, []>(
        `SELECT id, span, surrounding, suggested_cat, confidence, source_event
         FROM review_queue WHERE status = 'pending' ORDER BY detected_at DESC`,
      )
      .all();

    // #116: drop spans that are allowlisted OR already approved in Vocabulary
    // (they're no longer "pending" — the Scrub pane already tokenizes them).
    const live = rows.filter(
      (row) => !this.isAllowlisted(row.span) && !this.hasToken(row.span),
    );

    // #116: collapse overlapping/substring spans of the same value to a single
    // canonical entry (the longest span wins). The review queue was dominated
    // by truncations/substrings of one value (e.g. an FQDN and "my.host.l",
    // "my.host."), all proposed as the same category — these are not distinct
    // findings. Keep the first (newest, longest-preferred) representative per
    // family and drop any later span that is a substring of an already-kept one
    // (or vice-versa), case-insensitively.
    const kept: Array<ReviewItem & { id: number }> = [];
    // Process longest-first so the canonical full value is kept and its
    // substrings are absorbed.
    const byLengthDesc = [...live].sort((a, b) => b.span.length - a.span.length);
    for (const row of byLengthDesc) {
      const s = row.span.toLowerCase();
      const overlaps = kept.some((k) => {
        const ks = k.span.toLowerCase();
        return ks.includes(s) || s.includes(ks);
      });
      if (!overlaps) kept.push(row);
    }
    // Restore the original newest-first ordering for the UI.
    const keptIds = new Set(kept.map((k) => k.id));
    return live.filter((row) => keptIds.has(row.id));
  }

  /** Transition a review item to a new status. */
  setReviewStatus(id: number, status: 'confirmed' | 'allowlisted' | 'ignored'): void {
    this.db
      .query(`UPDATE review_queue SET status = ? WHERE id = ?`)
      .run(status, id);
  }

  /** Look up a vocab row by its token string (e.g. "{CUSTOMER}"). Returns null if not found. */
  findByToken(token: string): VocabRow | null {
    const row = this.db
      .query<VocabRow, [string]>(`SELECT * FROM vocab WHERE token = ? LIMIT 1`)
      .get(token);
    return row ?? null;
  }

  /** All vocab rows. */
  allVocab(category?: string): VocabRow[] {
    if (category) {
      return this.db
        .query<VocabRow, [string]>(`SELECT * FROM vocab WHERE category = ? ORDER BY real_value`)
        .all(category);
    }
    return this.db.query<VocabRow, []>(`SELECT * FROM vocab ORDER BY category, real_value`).all();
  }

  /** Redaction stats grouped by day. */
  stats(days = 7): Array<{ day: string; minted: number; reused: number; blocked: number }> {
    return this.db
      .query<
        { day: string; minted: number; reused: number; blocked: number },
        [number]
      >(
        `SELECT date(timestamp / 1000, 'unixepoch') AS day,
                SUM(tokens_minted) AS minted,
                SUM(tokens_reused) AS reused,
                SUM(blocked)       AS blocked
         FROM redaction_log
         WHERE timestamp > ?
         GROUP BY day
         ORDER BY day DESC`,
      )
      .all(Date.now() - days * 86_400_000);
  }

  /** All vocab rows for a specific category. */
  vocabByCategory(category: string): VocabRow[] {
    return this.db
      .query<VocabRow, [string]>(`SELECT * FROM vocab WHERE category = ? ORDER BY real_value`)
      .all(category);
  }

  /** Categories that have at least `min` vocab entries. */
  categoriesAboveThreshold(min: number): Array<{ category: string; count: number }> {
    return this.db
      .query<{ category: string; count: number }, [number]>(
        `SELECT category, COUNT(*) AS count FROM vocab GROUP BY category HAVING count >= ? ORDER BY count DESC`,
      )
      .all(min);
  }

  /** All active induced patterns. */
  activePatterns(): InducedPatternRow[] {
    return this.db
      .query<InducedPatternRow, []>(
        `SELECT * FROM induced_patterns WHERE status = 'active' ORDER BY id`,
      )
      .all();
  }

  /** All pending induced patterns. */
  pendingPatterns(): InducedPatternRow[] {
    return this.db
      .query<InducedPatternRow, []>(
        `SELECT * FROM induced_patterns WHERE status = 'pending' ORDER BY id`,
      )
      .all();
  }

  /** Insert a new induced pattern. Returns the new row id. */
  persistInducedPattern(row: NewInducedPattern): number {
    const now = Date.now();
    // Skip if a non-rejected pattern with the same category+skeleton already exists.
    const existing = this.db
      .query(`SELECT id FROM induced_patterns WHERE category = ? AND skeleton = ? AND status != 'rejected' LIMIT 1`)
      .get(row.category, row.skeleton) as { id: number } | undefined;
    if (existing) return existing.id;

    const result = this.db
      .query(
        `INSERT INTO induced_patterns
           (category, regex_source, skeleton, source_examples, example_count, status, confidence, first_seen, last_seen, hit_count)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0)`,
      )
      .run(
        row.category,
        row.regex_source,
        row.skeleton,
        JSON.stringify(row.source_examples),
        row.source_examples.length,
        row.confidence,
        now,
        now,
      );
    return Number((result as { lastInsertRowid: bigint | number }).lastInsertRowid);
  }

  /** Set the status of an induced pattern. */
  setInducedStatus(id: number, status: 'pending' | 'active' | 'rejected'): void {
    this.db
      .query(`UPDATE induced_patterns SET status = ?, last_seen = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  /** Update the regex source of an induced pattern. */
  updateInducedRegex(id: number, regex_source: string): void {
    this.db
      .query(`UPDATE induced_patterns SET regex_source = ?, last_seen = ? WHERE id = ?`)
      .run(regex_source, Date.now(), id);
  }

  /** Increment hit count on an active induced pattern match. */
  bumpInducedHit(id: number): void {
    this.db
      .query(`UPDATE induced_patterns SET hit_count = hit_count + 1, last_seen = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  /** Remove an induced pattern permanently. */
  deleteInducedPattern(id: number): void {
    this.db.query(`DELETE FROM induced_patterns WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Default DB path. Uses os.homedir() so it works on Windows (%USERPROFILE%). */
export function defaultDbPath(): string {
  return join(homedir(), '.claude', 'PAI', 'MEMORY', 'SCRUBBER', 'vocab.db');
}
