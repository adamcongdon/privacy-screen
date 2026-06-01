/**
 * SQLite-backed vocabulary store for PrivacyScreen.
 * Persists token mappings across hook invocations and sessions.
 * Schema: vocab, review_queue, allowlist, redaction_log.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
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
  ): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO vocab (real_value, token, category, confidence, first_seen, last_seen, hit_count, project, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'auto')
         ON CONFLICT(real_value) DO UPDATE SET
           last_seen = excluded.last_seen,
           hit_count = hit_count + 1`,
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

  close(): void {
    this.db.close();
  }
}

/** Default DB path derived from the location of this file. */
export function defaultDbPath(): string {
  const home = process.env.HOME ?? '/Users/adam.congdon';
  return `${home}/.claude/PAI/MEMORY/SCRUBBER/vocab.db`;
}
