/**
 * Category normalization for judge output.
 *
 * The LLM emits categories from a closed vocabulary (`LlmCategory`); the review
 * queue stores a slightly different vocabulary (`ReviewCategory`) that matches
 * the existing vocab-induction pipeline. This module is the single source of
 * truth for that mapping. Unknown / malformed input always lands on `'unsure'`.
 */

/** Categories the judge may emit (must match the JSON schema in `prompt.ts`). */
export type LlmCategory =
  | 'person'
  | 'org'
  | 'address'
  | 'credential'
  | 'hostname'
  | 'other';

/** Categories the review queue understands. */
export type ReviewCategory =
  | 'person'
  | 'customer'
  | 'address'
  | 'credential'
  | 'fqdn'
  | 'unsure';

/** Static lookup from LLM category → review-queue category. */
export const LLM_TO_REVIEW_CATEGORY: Record<LlmCategory, ReviewCategory> = {
  person: 'person',
  org: 'customer',
  address: 'address',
  credential: 'credential',
  hostname: 'fqdn',
  other: 'unsure',
};

const VALID_LLM_CATEGORIES = new Set<string>(Object.keys(LLM_TO_REVIEW_CATEGORY));

/**
 * Normalize an unknown category value (typically straight from JSON.parse) to a
 * `ReviewCategory`. Anything not in the LLM vocabulary becomes `'unsure'`.
 */
export function normalizeCategory(raw: unknown): ReviewCategory {
  if (typeof raw !== 'string') return 'unsure';
  if (!VALID_LLM_CATEGORIES.has(raw)) return 'unsure';
  return LLM_TO_REVIEW_CATEGORY[raw as LlmCategory];
}
