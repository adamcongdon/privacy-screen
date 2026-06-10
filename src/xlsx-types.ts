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

/** Explicit user-defined column rule from `privacy-config.yaml`. */
export interface ColumnPatternRule {
  /** Exact header match, case-insensitive. Optional. */
  header?: string;
  /** Alternative — JavaScript regex source as string (e.g., 'email|e-?mail'). Optional. */
  headerRegex?: string;
  /** Required — the pattern category to apply to cells in this column. */
  pattern: PatternName;
}

/** Top-level `xlsx:` section of `PrivacyConfig`. */
export interface XlsxConfig {
  /** Explicit user-defined rules, evaluated first. */
  columnRules: ColumnPatternRule[];
  /** Whether to attempt heuristic header→pattern auto-detection. Default true. */
  autoDetect: boolean;
}

/** Closed list of valid `PatternName` literals. Used by config validation. */
export const PATTERN_NAMES: readonly PatternName[] = [
  'Email', 'Phone', 'SSN', 'IPv4', 'IPv6',
  'PersonName', 'StreetAddress', 'FQDN', 'CreditCard',
  'UncPath', 'DomainUser', 'MAC', 'GUID',
];

/** Type guard — true iff `v` is a valid `PatternName` literal. */
export function isPatternName(v: unknown): v is PatternName {
  return typeof v === 'string' && (PATTERN_NAMES as readonly string[]).includes(v);
}
