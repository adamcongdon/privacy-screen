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
  mkUncPath, mkDomainUser, mkMac, mkGuid, mkCreditCard,
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
  type PatternName,
  type ColumnPatternRule,
  type XlsxConfig,
} from './xlsx-types';

// Re-export the shared types so existing consumers `import { PatternName,
// ColumnPatternRule, XlsxConfig } from './xlsx-scrubber'` keep working.
export type { PatternName, ColumnPatternRule, XlsxConfig } from './xlsx-types';
export { isPatternName, PATTERN_NAMES } from './xlsx-types';

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

/**
 * Normalize a user-supplied custom label into a token-type identifier:
 * uppercase, alphanumerics + underscores, length 2–24, must start with a
 * letter. Returns null if the input cannot be normalized into a legal
 * identifier — caller treats null as "reject this override."
 */
export function normalizeCustomLabel(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length < 2 || cleaned.length > 24) return null;
  if (!/^[A-Z]/.test(cleaned)) return null;
  return cleaned;
}

/** Per-sheet, per-header overrides. Missing entries fall back to auto-resolution. */
export type CommitOverrides = Record<string, Record<string, ColumnOverride>>;

/** Summary of a scrub pass — surfaced in the UI and logs. */
export interface XlsxScrubSummary {
  sheets: number;
  rows: number;
  cellsScrubbed: number;
  /** Map of `${sheetName}::${header}` → resolved pattern (or 'skip' / 'regex' / 'unresolved'). */
  columnsResolved: Record<string, string>;
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

interface ResolvedColumn {
  pattern: PatternName | null;
  source: ColumnSource;
}

/**
 * Resolve a header → pattern using the rule list, then heuristics. Pure
 * function — used by both `inspectXlsx` and `scrubXlsx`.
 */
function resolveColumn(
  header: string,
  rules: readonly ColumnPatternRule[],
  autoDetect: boolean,
): ResolvedColumn {
  const trimmed = header.trim();
  if (!trimmed) return { pattern: null, source: 'unresolved' };

  // 1. Explicit rules
  for (const rule of rules) {
    if (rule.header && rule.header.toLowerCase() === trimmed.toLowerCase()) {
      return { pattern: rule.pattern, source: 'rule' };
    }
    if (rule.headerRegex) {
      try {
        const rx = new RegExp(rule.headerRegex, 'i');
        if (rx.test(trimmed)) return { pattern: rule.pattern, source: 'rule' };
      } catch {
        // Malformed user regex — skip rather than crash. Validation in
        // loadConfig catches the bad PatternName; bad regex source is
        // a runtime degrade.
      }
    }
  }

  // 2. Heuristic
  if (autoDetect) {
    for (const h of HEURISTICS) {
      if (h.rx.test(trimmed)) return { pattern: h.pattern, source: 'heuristic' };
    }
  }

  return { pattern: null, source: 'unresolved' };
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
    const text = Buffer.from(buffer).toString('utf8');
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
      const { pattern, source } = resolveColumn(headerRaw, rules, autoDetect);
      columns.push({
        header: headerRaw,
        resolvedPattern: pattern,
        source,
        sampleValue: firstNonEmptyCellText(sheet, col),
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
 * Per-column action resolved at the start of a sheet pass. `skip` =
 * leave cells untouched. `regex` = run cell text through whole-cell
 * `scrubText`. `PatternName` = force-mint via the column's category.
 */
type ColumnAction =
  | { kind: 'skip' }
  | { kind: 'regex' }
  | { kind: 'pattern'; pattern: PatternName }
  | { kind: 'custom'; tokenType: string };

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
): string {
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
        const { pattern } = resolveColumn(header, rules, autoDetect);
        if (pattern) {
          action = { kind: 'pattern', pattern };
          label = pattern;
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
          const next = applyForceMint(text, action.pattern, map, vocab);
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
        // Only touch string cells; skip numbers / dates / booleans
        // (the regex layer has no meaningful match surface on them and
        // mutating them risks data corruption).
        if (!isStringCell(cell)) continue;
        const text = cellTextValue(cell);
        if (!text) continue;
        const result = scrubText(text, map, vocab, ctx);
        if (result.scrubbed !== text) {
          cell.value = result.scrubbed;
          summary.cellsScrubbed += 1;
        }
      }
    }
  });

  const out = await writeWorkbook(wb, fileName ?? '');
  return { scrubbedBuffer: out, summary };
}
