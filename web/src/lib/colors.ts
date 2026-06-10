/**
 * Token category color system — Flow redesign.
 *
 * One base hue per category (README §Design Tokens, line ~247). Pill bg / border
 * / text derive from that single hue via `color-mix(in srgb, …)` instead of
 * per-category Tailwind triples — this also gives light-mode support for free.
 *
 * Categories from the backend arrive lowercase ("ip", "customer", "email", …);
 * tokens look like {IP_1}, {CUSTOMER_2}. Unknown categories hash to a stable
 * hue so highlight colors stay consistent across renders.
 *
 * Backward-compatible exports: `getCategoryStyle` (Tailwind className triple +
 * ring) and `getCategoryInlineStyles` (raw CSS values) keep their existing
 * signatures so current callers (PreviewPane, TokenMap, sanitizeHtmlWithTokens)
 * compile and render unchanged.
 *
 * IMPORTANT (Tailwind JIT): the arbitrary-value classes below are written as
 * FULL STATIC STRING LITERALS so Tailwind's content scanner discovers and emits
 * each one. Do not refactor them into runtime string interpolation — that would
 * hide the class names from the scanner and the pills would render unstyled.
 */

import { CATS } from './categories';

export type TokenStyle = {
  bg: string;
  border: string;
  text: string;
  ring: string;
};

export type InlineTokenStyle = {
  bg: string;
  border: string;
  text: string;
};

/**
 * Per-category Tailwind class triples (+ ring), expressed as literal arbitrary
 * `color-mix` values so the JIT scanner emits them. bg = 17% hue, border = 42%,
 * text = 55% blended toward --text (kept readable in both themes), ring = 42%.
 */
const CLASS_PALETTE: Record<string, TokenStyle> = {
  ip: {
    bg: 'bg-[color-mix(in_srgb,#4c8dff_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#4c8dff_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#4c8dff_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#4c8dff_42%,transparent)]',
  },
  customer: {
    bg: 'bg-[color-mix(in_srgb,#b07cff_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#b07cff_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#b07cff_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#b07cff_42%,transparent)]',
  },
  email: {
    bg: 'bg-[color-mix(in_srgb,#26c281_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#26c281_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#26c281_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#26c281_42%,transparent)]',
  },
  host: {
    bg: 'bg-[color-mix(in_srgb,#22c1d6_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#22c1d6_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#22c1d6_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#22c1d6_42%,transparent)]',
  },
  phone: {
    bg: 'bg-[color-mix(in_srgb,#f59e0b_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#f59e0b_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#f59e0b_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#f59e0b_42%,transparent)]',
  },
  addr: {
    bg: 'bg-[color-mix(in_srgb,#fb923c_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#fb923c_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#fb923c_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#fb923c_42%,transparent)]',
  },
  url: {
    bg: 'bg-[color-mix(in_srgb,#2dd4bf_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#2dd4bf_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#2dd4bf_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#2dd4bf_42%,transparent)]',
  },
  account: {
    bg: 'bg-[color-mix(in_srgb,#fb7185_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#fb7185_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#fb7185_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#fb7185_42%,transparent)]',
  },
  user: {
    bg: 'bg-[color-mix(in_srgb,#f0a5c0_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#f0a5c0_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#f0a5c0_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#f0a5c0_42%,transparent)]',
  },
  path: {
    bg: 'bg-[color-mix(in_srgb,#94a3b8_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#94a3b8_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#94a3b8_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#94a3b8_42%,transparent)]',
  },
  credential: {
    bg: 'bg-[color-mix(in_srgb,#f76d6d_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#f76d6d_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#f76d6d_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#f76d6d_42%,transparent)]',
  },
};

/** Fallback class triples for unknown categories — literal so JIT emits them. */
const CLASS_FALLBACK: TokenStyle[] = [
  {
    bg: 'bg-[color-mix(in_srgb,#6366f1_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#6366f1_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#6366f1_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#6366f1_42%,transparent)]',
  },
  {
    bg: 'bg-[color-mix(in_srgb,#14b8a6_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#14b8a6_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#14b8a6_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#14b8a6_42%,transparent)]',
  },
  {
    bg: 'bg-[color-mix(in_srgb,#f97316_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#f97316_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#f97316_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#f97316_42%,transparent)]',
  },
  {
    bg: 'bg-[color-mix(in_srgb,#d946ef_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#d946ef_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#d946ef_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#d946ef_42%,transparent)]',
  },
  {
    bg: 'bg-[color-mix(in_srgb,#84cc16_17%,transparent)]',
    border: 'border-[color-mix(in_srgb,#84cc16_42%,transparent)]',
    text: 'text-[color-mix(in_srgb,#84cc16_55%,var(--text))]',
    ring: 'ring-[color-mix(in_srgb,#84cc16_42%,transparent)]',
  },
];

/** Base hues for the fallback triples above (same order). */
const FALLBACK_HUES: string[] = ['#6366f1', '#14b8a6', '#f97316', '#d946ef', '#84cc16'];

function normalizeCategory(category: string | null | undefined): string {
  return (category ?? '').toLowerCase().trim();
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Resolve the base `--cat` hue for a category. Known categories use the
 * authoritative palette; unknown categories hash to a stable fallback hue.
 */
export function getCategoryHue(category: string | null | undefined): string {
  const key = normalizeCategory(category);
  const meta = CATS[key];
  if (meta) return meta.hue;
  if (!key) return FALLBACK_HUES[0]!;
  return FALLBACK_HUES[hashString(key) % FALLBACK_HUES.length]!;
}

/**
 * Returns Tailwind className fragments for a token pill. Each field is a literal
 * arbitrary-value class (color-mix derived from the category's base hue) that
 * Tailwind's JIT scanner emits. The same call works in both themes.
 */
export function getCategoryStyle(category: string | null | undefined): TokenStyle {
  const key = normalizeCategory(category);
  if (key && CLASS_PALETTE[key]) return CLASS_PALETTE[key]!;
  if (!key) return CLASS_FALLBACK[0]!;
  return CLASS_FALLBACK[hashString(key) % CLASS_FALLBACK.length]!;
}

// color-mix helper for inline (raw-value) styling.
function mix(hue: string, pct: number, other: string): string {
  return `color-mix(in srgb, ${hue} ${pct}%, ${other})`;
}

/**
 * Returns raw CSS color values (background / border / text) for inline styling,
 * derived from the category's base hue via `color-mix`. Used where styles are
 * applied through a `style` string rather than Tailwind classes.
 */
export function getCategoryInlineStyles(
  category: string | null | undefined,
): InlineTokenStyle {
  const hue = getCategoryHue(category);
  return {
    bg: mix(hue, 17, 'transparent'),
    border: mix(hue, 42, 'transparent'),
    text: mix(hue, 55, 'var(--text)'),
  };
}
