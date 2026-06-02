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

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
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

  /** Persist a newly minted token. Upserts on real_value conflict. */
  persistMint(
    realValue: string,
    token: string,
    category: string,
    confidence: number,
    project: string | null = null,
    force = false,
  ): void {
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
    this.db
      .query(
        `INSERT INTO vocab (real_value, token, category, confidence, first_seen, last_seen, hit_count, project, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'auto')
         ON CONFLICT(real_value) ${conflictClause}`,
      )
      .run(realValue, token, category, confidence, now, now, project);
  }

  /** Add a span to the review queue (uncertain/heuristic detections). */
  addReviewItem(item: ReviewItem): void {
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
    const rows = this.db
      .query<AllowlistRow, []>(`SELECT pattern, is_regex FROM allowlist`)
      .all();
    const lower = value.toLowerCase();
    for (const { pattern, is_regex } of rows) {
      if (is_regex) {
        try {
          if (new RegExp(pattern, 'i').test(value)) return true;
        } catch {
          // malformed regex in DB — skip
        }
      } else {
        if (lower === pattern.toLowerCase()) return true;
      }
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
  }

  /** Remove a vocab entry (for the CLI forget command). */
  forgetReal(realValue: string): boolean {
    const r = this.db
      .query(`DELETE FROM vocab WHERE real_value = ? COLLATE NOCASE`)
      .run(realValue);
    return (r as { changes: number }).changes > 0;
  }

  /** All pending review items. */
  pendingReview(): Array<ReviewItem & { id: number }> {
    return this.db
      .query<ReviewItem & { id: number }, []>(
        `SELECT id, span, surrounding, suggested_cat, confidence, source_event
         FROM review_queue WHERE status = 'pending' ORDER BY detected_at DESC`,
      )
      .all();
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
