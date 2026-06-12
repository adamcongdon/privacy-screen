/**
 * xlsx scrubber + inspector — Issue #23 data layer.
 *
 * Wraps `exceljs` to (a) inspect a workbook and propose per-column PII
 * patterns and (b) scrub a workbook in place, replacing cell values with
 * tokens from a shared `ScrubMap`. Re-serializes the workbook back to xlsx
 * binary so downstream consumers can save the scrubbed file.
 *
 * Column-resolution precedence (highest → lowest):
 *   1. Caller-supplied per-sheet `CommitOverrides`     (UI / commit step)
 *   2. Explicit `XlsxConfig.columnRules`               (privacy-config.yaml)
 *   3. Heuristic header→pattern auto-detect            (autoDetect=true)
 *   4. Unresolved → fall back to whole-cell `scrubText`
 *
 * Force-mint semantics: when a column resolves to a `PatternName`, every
 * non-empty cell in that column is tokenized as that category — regardless
 * of whether the cell text matches the pattern's regex. Cells whose text
 * the regex *does* match are tokenized span-by-span; cells whose text the
 * regex misses are tokenized whole. This is the "header-is-authoritative"
 * model: if the user told us the column is Email, we trust it over any
 * single cell's surface.
 *
 * Touches no other scrubber code paths — `scrubXlsx` imports and calls
 * `scrubText` for the regex-fallback branch, never modifies it.
 */

import ExcelJS from 'exceljs';
import {
  mkEmail, mkPhone, mkIpv4, mkIpv6, mkFqdn, mkStreetAddress,
  mkUncPath, mkDomainUser, mkMac, mkGuid, mkCreditCard, mkCredential,
} from './patterns';
import { ScrubMap } from './scrub-map';
import { VocabStore } from './vocab';
import { scrubText, type ScrubContext } from './scrubber';
// Type-only import to avoid a runtime circular dep — `./config` only
// references xlsx symbols by type, except for `isPatternName` which lives
// in `./xlsx-types` precisely so config.ts can validate without pulling
// `exceljs` into the import graph.
import type { PrivacyConfig } from './config';
import {
  isColumnRuleAction,
  normalizeCustomLabel,
  type ColumnRuleAction,
  type PatternName,
  type ColumnPatternRule,
  type XlsxConfig,
} from './xlsx-types';

// Re-export the shared types so existing consumers `import { PatternName,
// ColumnPatternRule, XlsxConfig } from './xlsx-scrubber'` keep working.
export type { PatternName, ColumnPatternRule, XlsxConfig } from './xlsx-types';
export { isPatternName, PATTERN_NAMES, isColumnRuleAction, COLUMN_RULE_ACTIONS } from './xlsx-types';
export type { ColumnRuleAction } from './xlsx-types';

// ── Public types ─────────────────────────────────────────────────────────────
//
// `PatternName`, `ColumnPatternRule`, `XlsxConfig` come from `./xlsx-types`
// (re-exported above) so that `./config` can validate them without forming
// a circular import with this file (which depends on `./scrubber`, which
// depends on `./config`).

/** Where a column's resolved pattern came from. */
export type ColumnSource = 'rule' | 'heuristic' | 'unresolved';

/** Per-column inspection result returned by `inspectXlsx`. */
export interface ColumnInspection {
  /** Raw header cell text, trimmed. Empty string for blank header cells. */
  header: string;
  /** Resolved pattern, or null when unresolved. */
  resolvedPattern: PatternName | null;
  /** Where the resolved pattern came from. */
  source: ColumnSource;
  /** First non-empty cell value in the column, stringified, max 80 chars. */
  sampleValue: string | null;
  /** Set when the rule's action is skip/regex/custom (not a PatternName). Engineer-B uses this for UI preview. */
  resolvedAction?: 'skip' | 'regex' | 'custom';
}

/** Per-sheet inspection result. */
export interface SheetInspection {
  name: string;
  columns: ColumnInspection[];
  /** Data rows (excluding header row). */
  rowCount: number;
}

/** Top-level inspection result. */
export interface XlsxInspectResult {
  sheets: SheetInspection[];
}

/** Per-column override emitted from the commit UI. */
export interface ColumnOverride {
  /**
   * PatternName | 'skip' | 'regex' | 'custom'.
   * 'regex' = whole-cell scrubText fallback.
   * 'custom' (issue #39) = treat every non-empty cell as a custom-labeled
   * PII span, force-minting with the user-supplied label as the token type
   * (e.g. label 'ServerName' → '{SERVERNAME}', '{SERVERNAME_1}', …).
   * `label` is required when `pattern === 'custom'`.
   */
  pattern: PatternName | 'skip' | 'regex' | 'custom';
  /** Custom label for the column; required when pattern === 'custom'. */
  label?: string;
}

// normalizeCustomLabel is defined in ./xlsx-types so that src/config.ts can
// import it without forming a circular dependency. Re-export it here so all
// existing consumers that imported it from './xlsx-scrubber' continue to work.
export { normalizeCustomLabel } from './xlsx-types';

/** Per-sheet, per-header overrides. Missing entries fall back to auto-resolution. */
export type CommitOverrides = Record<string, Record<string, ColumnOverride>>;

/** Summary of a scrub pass — surfaced in the UI and logs. */
export interface XlsxScrubSummary {
  sheets: number;
  rows: number;
  cellsScrubbed: number;
  /** Map of `${sheetName}::${header}` → resolved pattern (or 'skip' / 'regex' / 'unresolved'). */
  columnsResolved: Record<string, string>;
  /**
   * SCR-05 (#58): OR-merged across every cell/header/metadata field. When true,
   * the workbook contained a credential and the server must refuse to return the
   * buffer (BLOCK-ALWAYS), exactly like the text/tool paths.
   */
  hasCredentials: boolean;
  /** Redacted credential snippets (never the raw secret) for operator triage. */
  credentialSnippets: string[];
}

/** Top-level result of `scrubXlsx` — buffer + summary. */
export interface XlsxScrubResult {
  scrubbedBuffer: Buffer;
  summary: XlsxScrubSummary;
}

// ── Pattern → regex factory map ──────────────────────────────────────────────

/**
 * Returns a fresh regex for `pattern`, or null when the pattern has no
 * built-in regex (SSN today). Callers that get null must fall back to the
 * whole-cell tokenize path so the user's intent ("treat this column as
 * SSN") is still honored even without a regex.
 */
function resolvePatternRegex(pattern: PatternName): RegExp | null {
  switch (pattern) {
    case 'Email': return mkEmail();
    case 'Phone': return mkPhone();
    case 'IPv4': return mkIpv4();
    case 'IPv6': return mkIpv6();
    case 'FQDN': return mkFqdn();
    case 'StreetAddress': return mkStreetAddress();
    case 'UncPath': return mkUncPath();
    case 'DomainUser': return mkDomainUser();
    case 'MAC': return mkMac();
    case 'GUID': return mkGuid();
    case 'CreditCard': return mkCreditCard();
    case 'PersonName':
      // Person name regexes in `patterns.ts` capture in group 1 and are
      // context-anchored (header slots, sign-offs). They don't fit the
      // "match any name-shaped span in a free cell" need, so for columns
      // we force-mint the whole cell value. (User said "this column is a
      // person name" → trust that signal.)
      return null;
    case 'SSN':
      // No built-in SSN regex today (see Plans/use-architect-to-floating-sky.md
      // §HEURISTIC_MAP). Force-mint whole cell when explicitly configured.
      return null;
  }
}

/**
 * Maps a pattern → the {TYPE} prefix used in minted tokens. Aligned with
 * the existing `scrubText` minting calls in `src/scrubber.ts` so tokens
 * from xlsx and free-text scrubs share the same namespace and counter
 * sequence within a single `ScrubMap`.
 */
function patternToTokenType(pattern: PatternName): string {
  switch (pattern) {
    case 'Email': return 'EMAIL';
    case 'Phone': return 'PHONE';
    case 'SSN': return 'SSN';
    case 'IPv4':
    case 'IPv6': return 'IP';
    case 'PersonName': return 'PERSON';
    case 'StreetAddress': return 'ADDR';
    case 'FQDN': return 'HOST';
    case 'CreditCard': return 'ACCOUNT';
    case 'UncPath': return 'PATH';
    case 'DomainUser': return 'USER';
    case 'MAC': return 'MAC';
    case 'GUID': return 'GUID';
  }
}

// ── Heuristic header → pattern map ───────────────────────────────────────────

interface HeuristicEntry {
  rx: RegExp;
  pattern: PatternName;
}

/**
 * Header-name → pattern heuristics. Order matters: first match wins.
 * Regexes are case-insensitive. Keep narrow — false positives here force
 * the user to override in the commit UI, but a missed match is just a
 * fallback to whole-cell `scrubText`, which is the safer default.
 */
const HEURISTICS: readonly HeuristicEntry[] = [
  { rx: /email|e-?mail/i, pattern: 'Email' },
  { rx: /phone|tel|mobile/i, pattern: 'Phone' },
  { rx: /ssn/i, pattern: 'SSN' },
  { rx: /^ip$|ip[\s_-]?addr/i, pattern: 'IPv4' },
  { rx: /^name$|full[\s_-]?name|person[\s_-]?name/i, pattern: 'PersonName' },
  { rx: /address|street/i, pattern: 'StreetAddress' },
  { rx: /domain|fqdn|host(name)?$/i, pattern: 'FQDN' },
];

// ── Column resolution ────────────────────────────────────────────────────────

/**
 * Per-column action resolved at the start of a sheet pass. `skip` =
 * leave cells untouched. `regex` = run cell text through whole-cell
 * `scrubText`. `pattern` = force-mint via the column's category.
 * `custom` = force-mint with a user-supplied token type.
 *
 * Promoted to module scope (issue #35) so `resolveColumn` can return it
 * directly — the explicit `action`/`label` rule shapes resolve to the same
 * union the row loop in `scrubXlsx` already consumes.
 */
export type ColumnAction =
  | { kind: 'skip' }
  | { kind: 'regex' }
  | { kind: 'pattern'; pattern: PatternName }
  | { kind: 'custom'; tokenType: string };

interface ResolvedColumn {
  action: ColumnAction | null;
  source: ColumnSource;
}

/**
 * Resolve a header → action using the rule list, then heuristics. Pure
 * function — used by both `inspectXlsx` and `scrubXlsx`.
 */
function resolveColumn(
  header: string,
  rules: readonly ColumnPatternRule[],
  autoDetect: boolean,
): ResolvedColumn {
  const trimmed = header.trim();
  if (!trimmed) return { action: null, source: 'unresolved' };

  // 1. Explicit rules
  for (const rule of rules) {
    const headerMatch = rule.header && rule.header.toLowerCase() === trimmed.toLowerCase();
    const regexMatch = rule.headerRegex
      ? (() => {
          try {
            return new RegExp(rule.headerRegex, 'i').test(trimmed);
          } catch {
            return false;
          }
        })()
      : false;

    if (headerMatch || regexMatch) {
      if (rule.action === 'skip') {
        return { action: { kind: 'skip' }, source: 'rule' };
      }
      if (rule.action === 'regex') {
        return { action: { kind: 'regex' }, source: 'rule' };
      }
      if (rule.action === 'custom') {
        return { action: { kind: 'custom', tokenType: rule.label! }, source: 'rule' };
      }
      // pattern branch (back-compat)
      if (rule.pattern) {
        return { action: { kind: 'pattern', pattern: rule.pattern }, source: 'rule' };
      }
    }
  }

  // 2. Heuristic
  if (autoDetect) {
    for (const h of HEURISTICS) {
      if (h.rx.test(trimmed)) {
        return { action: { kind: 'pattern', pattern: h.pattern }, source: 'heuristic' };
      }
    }
  }

  return { action: null, source: 'unresolved' };
}

// ── Cell helpers ─────────────────────────────────────────────────────────────

/**
 * Coerce a cell value to its display string, mirroring exceljs's `cell.text`
 * but applied to a raw value we pulled off a cell. Returns null for
 * empty/null/undefined.
 */
function cellTextValue(cell: ExcelJS.Cell): string {
  // exceljs `cell.text` resolves formulas + rich text; prefer it when present.
  // For numeric / date cells it stringifies appropriately.
  const t = cell.text;
  if (t === null || t === undefined) return '';
  return String(t);
}

/** True iff a cell is logically empty (null / undefined / empty string). */
function isEmptyCell(cell: ExcelJS.Cell): boolean {
  const v = cell.value;
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  return false;
}

/** True iff the cell's underlying value is a string (not number/date/etc.). */
function isStringCell(cell: ExcelJS.Cell): boolean {
  return typeof cell.value === 'string';
}

/** Mask a detected credential to a short, non-reversible snippet. */
function redactXlsxCredential(cred: string): string {
  const head = cred.slice(0, 4);
  return `${head}…[${cred.length} chars]`;
}

/**
 * SCR-04/05 (#57/#58): scrub a single piece of cell-or-metadata text.
 * Runs the credential gate first (a credential is replaced with
 * [CREDENTIAL-REDACTED] and flagged on the summary — never tokenized/persisted),
 * otherwise runs the standard scrubText pipeline. Returns the cleaned string
 * and whether it changed.
 */
function scrubScalarText(
  text: string,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
  summary: XlsxScrubSummary,
): { value: string; changed: boolean } {
  if (!text) return { value: text, changed: false };
  const creds = [...text.matchAll(mkCredential())];
  if (creds.length > 0) {
    summary.hasCredentials = true;
    summary.credentialSnippets.push(...creds.map((m) => redactXlsxCredential(m[0])));
    const replaced = text.replace(mkCredential(), '[CREDENTIAL-REDACTED]');
    return { value: replaced, changed: replaced !== text };
  }
  const result = scrubText(text, map, vocab, ctx);
  if (result.hasCredentials) {
    summary.hasCredentials = true;
    summary.credentialSnippets.push(...result.credentialSnippets);
  }
  return { value: result.scrubbed, changed: result.scrubbed !== text };
}

/**
 * SCR-04 (#57): scrub a cell regardless of its value shape — plain string,
 * rich text ({ richText: [{text}] }), hyperlink ({ text, hyperlink }), or a
 * cached formula result ({ formula, result }). Mutates cell.value in place and
 * returns true if anything changed. Numbers/dates/booleans are left untouched.
 */
function scrubCellAnyShape(
  cell: ExcelJS.Cell,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
  summary: XlsxScrubSummary,
): boolean {
  const v = cell.value as unknown;

  // Plain string.
  if (typeof v === 'string') {
    const r = scrubScalarText(v, map, vocab, ctx, summary);
    if (r.changed) cell.value = r.value;
    return r.changed;
  }

  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;

    // Rich text: { richText: [{ text, font? }, ...] }
    if (Array.isArray(obj.richText)) {
      let changed = false;
      for (const run of obj.richText as Array<{ text?: string }>) {
        if (typeof run.text === 'string') {
          const r = scrubScalarText(run.text, map, vocab, ctx, summary);
          if (r.changed) { run.text = r.value; changed = true; }
        }
      }
      if (changed) cell.value = { ...obj } as unknown as ExcelJS.CellValue;
      return changed;
    }

    // Hyperlink: { text, hyperlink } — scrub BOTH the display text and target.
    if (typeof obj.hyperlink === 'string' || typeof obj.text === 'string') {
      let changed = false;
      const next: Record<string, unknown> = { ...obj };
      if (typeof obj.text === 'string') {
        const r = scrubScalarText(obj.text, map, vocab, ctx, summary);
        if (r.changed) { next.text = r.value; changed = true; }
      }
      if (typeof obj.hyperlink === 'string') {
        const r = scrubScalarText(obj.hyperlink, map, vocab, ctx, summary);
        if (r.changed) { next.hyperlink = r.value; changed = true; }
      }
      if (changed) cell.value = next as unknown as ExcelJS.CellValue;
      return changed;
    }

    // Cached formula result: { formula, result } — scrub the result string.
    if ('formula' in obj && typeof obj.result === 'string') {
      const r = scrubScalarText(obj.result, map, vocab, ctx, summary);
      if (r.changed) {
        cell.value = { ...obj, result: r.value } as unknown as ExcelJS.CellValue;
        return true;
      }
      return false;
    }
  }

  return false;
}

/** Truncate `s` to `max` chars, suffixing with ellipsis when shortened. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Walk a column from row 2 downward and return the first non-empty cell's
 * stringified text, truncated to `max` chars. Returns null when the entire
 * column is empty. Pure read — no side effects.
 */
function firstNonEmptyCellText(
  sheet: ExcelJS.Worksheet,
  colIndex: number,
  max = 80,
): string | null {
  const last = sheet.actualRowCount;
  for (let row = 2; row <= last; row += 1) {
    const cell = sheet.getRow(row).getCell(colIndex);
    if (isEmptyCell(cell)) continue;
    const txt = cellTextValue(cell).trim();
    if (!txt) continue;
    return truncate(txt, max);
  }
  return null;
}

// ── Buffer normalization ─────────────────────────────────────────────────────

/**
 * Accept Buffer or ArrayBuffer; return a Buffer-shaped value for exceljs's
 * `xlsx.load`. The exceljs type signature uses an older `Buffer` definition
 * than Bun's `@types/bun` ships, so we cast at the boundary rather than
 * polluting call sites with the same workaround.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asBuffer(buffer: Buffer | ArrayBuffer): any {
  if (Buffer.isBuffer(buffer)) return buffer;
  return Buffer.from(buffer);
}

/**
 * Load either an .xlsx buffer (binary) or a .csv buffer (utf8 text) into an
 * ExcelJS Workbook using the appropriate reader. This lets the *same*
 * column-resolution + per-cell scrub logic in inspectXlsx/scrubXlsx serve
 * both file types (#35: CSV now gets the ignore / individual column options
 * via the existing xlsx scrub path and UI).
 *
 * CSV path: synthesizes an in-memory stream (no disk) and uses wb.csv.read.
 * The resulting workbook has a single worksheet (default name "Sheet1").
 */
async function loadWorkbook(
  buffer: Buffer | ArrayBuffer,
  fileName = '',
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) {
    const { Readable } = await import('stream');
    const text = asBuffer(buffer).toString('utf8');
    const stream = Readable.from([text]);
    await wb.csv.read(stream);
  } else {
    await wb.xlsx.load(asBuffer(buffer));
  }
  return wb;
}

/**
 * Write the (possibly mutated) workbook back to bytes.
 * Chooses xlsx.writeBuffer or csv.writeBuffer based on original fileName.
 * Mirrors loadWorkbook so round-tripping a .csv upload produces valid .csv.
 */
async function writeWorkbook(
  wb: ExcelJS.Workbook,
  fileName = '',
): Promise<Buffer> {
  if (/\.csv$/i.test(fileName)) {
    const arr = await wb.csv.writeBuffer();
    return Buffer.from(arr as ArrayBuffer);
  }
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}

// ── Public: inspectXlsx ──────────────────────────────────────────────────────

/**
 * Inspect a workbook and propose per-column patterns. NO side effects, NO
 * mutation, NO scrubbing. Safe to call on the raw upload buffer.
 *
 * Supports both .xlsx and .csv (the latter via the shared exceljs workbook
 * model so CSV gets the exact same per-column "skip"/"regex"/Pattern options
 * and UI as xlsx — this is the CSV parse option requested in #35).
 *
 * @param buffer   file bytes (xlsx binary or csv utf8 text)
 * @param config   Optional XlsxConfig (rules + autoDetect). Defaults to
 *                 `{ columnRules: [], autoDetect: true }`.
 * @param fileName Optional original name; if it ends in .csv we load via
 *                 the csv reader instead of xlsx.load.
 */
export async function inspectXlsx(
  buffer: Buffer | ArrayBuffer,
  config?: XlsxConfig,
  fileName?: string,
): Promise<XlsxInspectResult> {
  const wb = await loadWorkbook(buffer, fileName ?? '');

  const rules = config?.columnRules ?? [];
  const autoDetect = config?.autoDetect ?? true;
  const sheets: SheetInspection[] = [];

  wb.eachSheet((sheet) => {
    const headerRow = sheet.getRow(1);
    const columns: ColumnInspection[] = [];
    const colCount = Math.max(sheet.actualColumnCount, headerRow.cellCount);

    for (let col = 1; col <= colCount; col += 1) {
      const headerCell = headerRow.getCell(col);
      const headerRaw = isEmptyCell(headerCell) ? '' : cellTextValue(headerCell).trim();
      const { action, source } = resolveColumn(headerRaw, rules, autoDetect);
      // Back-compat: resolvedPattern is set from the action when it's a pattern kind.
      const resolvedPattern = action?.kind === 'pattern' ? action.pattern : null;
      // For ColumnInspection, report the action kind for skip/regex/custom so the UI (Engineer-B) can use it.
      const resolvedAction = action && action.kind !== 'pattern'
        ? (action.kind as 'skip' | 'regex' | 'custom')
        : undefined;
      columns.push({
        header: headerRaw,
        resolvedPattern,
        source,
        sampleValue: firstNonEmptyCellText(sheet, col),
        ...(resolvedAction !== undefined ? { resolvedAction } : {}),
      });
    }

    sheets.push({
      name: sheet.name,
      columns,
      // actualRowCount counts every row that has any data, including the
      // header row. Subtract 1 to get data rows; clamp at 0 for header-only
      // (or fully empty) sheets.
      rowCount: Math.max(0, sheet.actualRowCount - 1),
    });
  });

  return { sheets };
}

// ── Public: scrubXlsx ────────────────────────────────────────────────────────

/**
 * Apply force-mint to a single cell, returning the new string value. If
 * the pattern's regex matches inside the cell, replace each match with
 * the minted token. If the regex misses (or there's no regex for this
 * pattern), mint a single token for the whole cell value.
 */
function applyForceMint(
  cellText: string,
  pattern: PatternName,
  map: ScrubMap,
  vocab: VocabStore | null,
  summary: XlsxScrubSummary,
): string {
  // SCR-05 (#58): never mint/persist a credential — a force-minted column
  // (e.g. Email) could otherwise tokenize a leaked API key into vocab.db where
  // restore() could resurrect it. Redact and flag instead.
  const creds = [...cellText.matchAll(mkCredential())];
  if (creds.length > 0) {
    summary.hasCredentials = true;
    summary.credentialSnippets.push(...creds.map((m) => redactXlsxCredential(m[0])));
    return cellText.replace(mkCredential(), '[CREDENTIAL-REDACTED]');
  }

  const type = patternToTokenType(pattern);
  const rx = resolvePatternRegex(pattern);

  if (rx) {
    let anyMatch = false;
    const replaced = cellText.replace(rx, (match) => {
      anyMatch = true;
      const r = map.mint(type, match);
      if (r.isNew && vocab) vocab.persistMint(match, r.token, type.toLowerCase(), 1.0);
      return r.token;
    });
    if (anyMatch) return replaced;
    // Regex missed → fall through to whole-cell mint so the column rule
    // is still honored.
  }

  const r = map.mint(type, cellText);
  if (r.isNew && vocab) vocab.persistMint(cellText, r.token, type.toLowerCase(), 1.0);
  return r.token;
}

/**
 * Scrub an xlsx workbook and return the re-serialized bytes + a summary.
 *
 * Per-column action precedence:
 *   overrides[sheet][header]  →  config rule  →  heuristic  →  unresolved
 *
 * When unresolved, cell text is passed through `scrubText` (whole-cell
 * regex fallback). Non-string cells (numbers, dates, booleans) are
 * touched only when the column is force-minted to a `PatternName` — for
 * `skip` they're preserved, for `regex` they're left alone (numbers aren't
 * PII surface in the regex layer).
 *
 * @param buffer    file bytes (xlsx or csv)
 * @param map       Shared scrub map (token namespace + counter state)
 * @param vocab     Vocab store for persistence; null = preview (no DB writes)
 * @param config    `{ xlsx, baseConfig }` — xlsx config drives column
 *                  resolution; baseConfig is passed to the `scrubText`
 *                  fallback so it sees the same allowlists / customer names
 *                  the rest of the system uses.
 * @param overrides Optional per-sheet, per-header overrides from the UI.
 * @param fileName  Optional original filename; determines csv vs xlsx
 *                  load + write format so CSV uploads get column policies
 *                  (#35) and round-trip as .scrubbed.csv .
 */
export async function scrubXlsx(
  buffer: Buffer | ArrayBuffer,
  map: ScrubMap,
  vocab: VocabStore | null,
  config: { xlsx: XlsxConfig; baseConfig: PrivacyConfig },
  overrides?: CommitOverrides,
  fileName?: string,
): Promise<XlsxScrubResult> {
  const wb = await loadWorkbook(buffer, fileName ?? '');

  const rules = config.xlsx.columnRules ?? [];
  const autoDetect = config.xlsx.autoDetect ?? true;
  const ctx: ScrubContext = {
    sourceEvent: 'xlsx:scrub',
    config: config.baseConfig,
  };

  const summary: XlsxScrubSummary = {
    sheets: 0,
    rows: 0,
    cellsScrubbed: 0,
    columnsResolved: {},
    hasCredentials: false,
    credentialSnippets: [],
  };

  wb.eachSheet((sheet) => {
    summary.sheets += 1;
    const headerRow = sheet.getRow(1);
    const colCount = Math.max(sheet.actualColumnCount, headerRow.cellCount);
    const sheetOverrides = overrides?.[sheet.name] ?? {};

    // Resolve a per-column action once before iterating rows.
    const colActions: Array<{
      header: string;
      action: ColumnAction;
      label: string;
    }> = [];

    for (let col = 1; col <= colCount; col += 1) {
      const headerCell = headerRow.getCell(col);
      const header = isEmptyCell(headerCell) ? '' : cellTextValue(headerCell).trim();

      let action: ColumnAction;
      let label: string;

      const ov = header ? sheetOverrides[header] : undefined;
      if (ov) {
        if (ov.pattern === 'skip') {
          action = { kind: 'skip' };
          label = 'skip';
        } else if (ov.pattern === 'regex') {
          action = { kind: 'regex' };
          label = 'regex';
        } else if (ov.pattern === 'custom') {
          // Custom-label override (#39). The label has already been
          // normalized by the server's commit validator; if for any
          // reason it isn't, normalize defensively and fall back to
          // 'regex' on rejection so we never write a bogus token type.
          const tokenType = normalizeCustomLabel(ov.label ?? '');
          if (tokenType) {
            action = { kind: 'custom', tokenType };
            label = `custom:${tokenType}`;
          } else {
            action = { kind: 'regex' };
            label = 'regex';
          }
        } else {
          action = { kind: 'pattern', pattern: ov.pattern };
          label = ov.pattern;
        }
      } else {
        const { action: resolved, source: resolvedSource } = resolveColumn(header, rules, autoDetect);
        void resolvedSource; // source is informational; scrubXlsx uses action directly
        if (resolved) {
          action = resolved;
          if (resolved.kind === 'pattern') {
            label = resolved.pattern;
          } else if (resolved.kind === 'custom') {
            label = `custom:${resolved.tokenType}`;
          } else {
            label = resolved.kind; // 'skip' or 'regex'
          }
        } else if (header) {
          // Unresolved column with a header — fall back to whole-cell scrubText.
          action = { kind: 'regex' };
          label = 'regex';
        } else {
          // Empty header — skip the column entirely.
          action = { kind: 'skip' };
          label = 'skip';
        }
      }

      colActions.push({ header, action, label });
      if (header) {
        summary.columnsResolved[`${sheet.name}::${header}`] = label;
      }
    }

    // Use `rowCount` (highest row index with a value), NOT `actualRowCount`
    // (count of non-empty rows). A sparse workbook with an all-null row in
    // the middle would otherwise stop iteration early and miss rows below.
    const lastRow = sheet.rowCount;
    // Data rows start at row 2.
    for (let row = 2; row <= lastRow; row += 1) {
      summary.rows += 1;
      const rowObj = sheet.getRow(row);
      for (let col = 1; col <= colCount; col += 1) {
        const action = colActions[col - 1].action;
        if (action.kind === 'skip') continue;
        const cell = rowObj.getCell(col);
        if (isEmptyCell(cell)) continue;

        if (action.kind === 'pattern') {
          // Force-mint: always coerce to string and tokenize.
          const text = cellTextValue(cell);
          if (!text) continue;
          const next = applyForceMint(text, action.pattern, map, vocab, summary);
          if (next !== text) {
            cell.value = next;
            summary.cellsScrubbed += 1;
          }
          continue;
        }

        if (action.kind === 'custom') {
          // Custom-label force-mint (#39). Whole-cell tokenize against the
          // user-supplied token type. No regex layer — the user explicitly
          // declared the column to be a custom PII type, so every non-empty
          // cell counts.
          const text = cellTextValue(cell);
          if (!text) continue;
          // SCR-05 (#58): credential check before any mint/persist.
          const creds = [...text.matchAll(mkCredential())];
          if (creds.length > 0) {
            summary.hasCredentials = true;
            summary.credentialSnippets.push(...creds.map((m) => redactXlsxCredential(m[0])));
            cell.value = text.replace(mkCredential(), '[CREDENTIAL-REDACTED]');
            summary.cellsScrubbed += 1;
            continue;
          }
          const r = map.mint(action.tokenType, text);
          if (r.isNew && vocab) {
            vocab.persistMint(text, r.token, action.tokenType.toLowerCase(), 1.0);
          }
          if (r.token !== text) {
            cell.value = r.token;
            summary.cellsScrubbed += 1;
          }
          continue;
        }

        // action.kind === 'regex' — whole-cell scrubText fallback.
        // SCR-04 (#57): handle EVERY value shape (plain string, rich text,
        // hyperlink, cached formula result), not just plain strings — those
        // object-valued cells previously passed through uncleaned.
        if (scrubCellAnyShape(cell, map, vocab, ctx, summary)) {
          summary.cellsScrubbed += 1;
        }
      }
    }

    // SCR-04 (#57): scrub the HEADER ROW itself — a PII value in a header
    // (a person's name/email used as a column title) was never scrubbed.
    const headerRowObj = sheet.getRow(1);
    for (let col = 1; col <= colCount; col += 1) {
      const hc = headerRowObj.getCell(col);
      if (isEmptyCell(hc)) continue;
      if (scrubCellAnyShape(hc, map, vocab, ctx, summary)) {
        summary.cellsScrubbed += 1;
      }
    }

    // SCR-04 (#57): scrub the sheet name too (it can carry a customer name).
    const cleanName = scrubScalarText(sheet.name, map, vocab, ctx, summary);
    if (cleanName.changed && cleanName.value.trim()) {
      try { sheet.name = cleanName.value; } catch { /* invalid sheet name — leave as-is */ }
    }
  });

  // SCR-04 (#57): blank workbook core metadata (creator / lastModifiedBy /
  // company) before serialization — these embed the author's real identity and
  // a bare personal name won't reliably regex-match, so we neutralize them
  // outright rather than rely on tokenization.
  for (const prop of ['creator', 'lastModifiedBy', 'company'] as const) {
    const val = (wb as unknown as Record<string, unknown>)[prop];
    if (typeof val === 'string' && val.trim()) {
      (wb as unknown as Record<string, unknown>)[prop] = '[REDACTED]';
    }
  }

  const out = await writeWorkbook(wb, fileName ?? '');
  return { scrubbedBuffer: out, summary };
}
