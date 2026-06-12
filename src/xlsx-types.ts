/**
 * Shared xlsx config types — kept in their own module so both
 * `src/config.ts` (loader + validation) and `src/xlsx-scrubber.ts`
 * (runtime engine) can depend on them without forming a circular
 * import. Nothing in here imports from `./config` or `./scrubber`.
 */

/**
 * Pattern category that can be applied to an xlsx column. Maps 1:1 to
 * a regex factory in `src/patterns.ts` (except `SSN` and `PersonName`,
 * which force-mint whole cells — see `src/xlsx-scrubber.ts`).
 */
export type PatternName =
  | 'Email' | 'Phone' | 'SSN' | 'IPv4' | 'IPv6'
  | 'PersonName' | 'StreetAddress' | 'FQDN' | 'CreditCard'
  | 'UncPath' | 'DomainUser' | 'MAC' | 'GUID';

/**
 * Explicit action that can be persisted for a column rule (issue #35).
 * Mutually exclusive with `pattern` on `ColumnPatternRule`.
 *   'skip'   — leave every cell in this column untouched (raw passthrough).
 *   'regex'  — run each cell through the whole-cell scrubText regex fallback.
 *   'custom' — force-mint every non-empty cell with a user-supplied label as
 *              the token type (e.g. label 'ServerName' -> {SERVERNAME}).
 *              `label` is required when action === 'custom'.
 */
export type ColumnRuleAction = 'skip' | 'regex' | 'custom';

/**
 * Explicit user-defined column rule from `privacy-config.yaml`.
 *
 * Exactly one of `pattern` or `action` must be present (back-compatible:
 * existing configs with only `{header, pattern}` remain valid).
 *
 * - pattern present -> must be a valid PatternName; action must be absent.
 * - action present  -> must be a ColumnRuleAction; pattern must be absent.
 *   If action === 'custom', `label` is required.
 */
export interface ColumnPatternRule {
  /** Exact header match, case-insensitive. At least one of header/headerRegex required. */
  header?: string;
  /** Alternative — JavaScript regex source as string (e.g., 'email|e-?mail'). */
  headerRegex?: string;
  /**
   * The pattern category to apply to cells in this column.
   * Was required before issue #35; now optional. Mutually exclusive with `action`.
   */
  pattern?: PatternName;
  /**
   * Explicit column action (skip / regex / custom). Mutually exclusive with `pattern`.
   * Persisted by the UI when the user makes a per-column policy choice.
   */
  action?: ColumnRuleAction;
  /**
   * Required when action === 'custom'. Normalized to uppercase token type
   * (e.g. 'ServerName' -> 'SERVERNAME'). Stored in normalized form.
   */
  label?: string;
}

/** Top-level `xlsx:` section of `PrivacyConfig`. */
export interface XlsxConfig {
  /** Explicit user-defined rules, evaluated first. */
  columnRules: ColumnPatternRule[];
  /** Whether to attempt heuristic header->pattern auto-detection. Default true. */
  autoDetect: boolean;
}

/** Closed list of valid `PatternName` literals. Used by config validation. */
export const PATTERN_NAMES: readonly PatternName[] = [
  'Email', 'Phone', 'SSN', 'IPv4', 'IPv6',
  'PersonName', 'StreetAddress', 'FQDN', 'CreditCard',
  'UncPath', 'DomainUser', 'MAC', 'GUID',
];

/** Closed list of valid `ColumnRuleAction` literals. Used by config validation. */
export const COLUMN_RULE_ACTIONS: readonly ColumnRuleAction[] = ['skip', 'regex', 'custom'];

/** Type guard — true iff `v` is a valid `PatternName` literal. */
export function isPatternName(v: unknown): v is PatternName {
  return typeof v === 'string' && (PATTERN_NAMES as readonly string[]).includes(v);
}

/** Type guard — true iff `v` is a valid `ColumnRuleAction` literal. */
export function isColumnRuleAction(v: unknown): v is ColumnRuleAction {
  return typeof v === 'string' && (COLUMN_RULE_ACTIONS as readonly string[]).includes(v);
}

/**
 * Normalize a user-supplied custom label into a token-type identifier:
 * uppercase, alphanumerics + underscores, length 2-24, must start with a
 * letter. Returns null if the input cannot be normalized into a legal
 * identifier — caller treats null as "reject this rule / override."
 *
 * Defined here (not in xlsx-scrubber.ts) so config.ts can import it
 * without creating a circular dependency through xlsx-scrubber -> scrubber -> config.
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
