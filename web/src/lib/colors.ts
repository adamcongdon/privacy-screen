/**
 * Token category -> Tailwind class mapping.
 *
 * Categories that come from the backend appear in lowercase ("ip", "customer",
 * "email", "host", "credential", etc.). Tokens themselves look like {IP_1},
 * {CUSTOMER_2}, {EMAIL_3}. We hash the category name to fall back to a
 * deterministic palette for unknown categories so the highlight color is
 * stable across renders.
 */

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

const PALETTE: Record<string, TokenStyle> = {
  ip: {
    bg: 'bg-blue-500/20',
    border: 'border-blue-500/40',
    text: 'text-blue-200',
    ring: 'ring-blue-400/40',
  },
  customer: {
    bg: 'bg-purple-500/20',
    border: 'border-purple-500/40',
    text: 'text-purple-200',
    ring: 'ring-purple-400/40',
  },
  email: {
    bg: 'bg-emerald-500/20',
    border: 'border-emerald-500/40',
    text: 'text-emerald-200',
    ring: 'ring-emerald-400/40',
  },
  host: {
    bg: 'bg-cyan-500/20',
    border: 'border-cyan-500/40',
    text: 'text-cyan-200',
    ring: 'ring-cyan-400/40',
  },
  hostname: {
    bg: 'bg-cyan-500/20',
    border: 'border-cyan-500/40',
    text: 'text-cyan-200',
    ring: 'ring-cyan-400/40',
  },
  credential: {
    bg: 'bg-red-500/25',
    border: 'border-red-500/50',
    text: 'text-red-200',
    ring: 'ring-red-400/50',
  },
  user: {
    bg: 'bg-amber-500/20',
    border: 'border-amber-500/40',
    text: 'text-amber-200',
    ring: 'ring-amber-400/40',
  },
  path: {
    bg: 'bg-pink-500/20',
    border: 'border-pink-500/40',
    text: 'text-pink-200',
    ring: 'ring-pink-400/40',
  },
};

const FALLBACK: TokenStyle[] = [
  {
    bg: 'bg-indigo-500/20',
    border: 'border-indigo-500/40',
    text: 'text-indigo-200',
    ring: 'ring-indigo-400/40',
  },
  {
    bg: 'bg-teal-500/20',
    border: 'border-teal-500/40',
    text: 'text-teal-200',
    ring: 'ring-teal-400/40',
  },
  {
    bg: 'bg-orange-500/20',
    border: 'border-orange-500/40',
    text: 'text-orange-200',
    ring: 'ring-orange-400/40',
  },
  {
    bg: 'bg-fuchsia-500/20',
    border: 'border-fuchsia-500/40',
    text: 'text-fuchsia-200',
    ring: 'ring-fuchsia-400/40',
  },
  {
    bg: 'bg-lime-500/20',
    border: 'border-lime-500/40',
    text: 'text-lime-200',
    ring: 'ring-lime-400/40',
  },
];

const INLINE_PALETTE: Record<string, InlineTokenStyle> = {
  ip: {
    bg: 'rgba(59,130,246,0.15)',
    border: 'rgba(59,130,246,0.45)',
    text: 'rgb(30,64,175)',
  },
  customer: {
    bg: 'rgba(168,85,247,0.15)',
    border: 'rgba(168,85,247,0.45)',
    text: 'rgb(107,33,168)',
  },
  email: {
    bg: 'rgba(16,185,129,0.15)',
    border: 'rgba(16,185,129,0.45)',
    text: 'rgb(6,95,70)',
  },
  host: {
    bg: 'rgba(6,182,212,0.15)',
    border: 'rgba(6,182,212,0.45)',
    text: 'rgb(14,116,144)',
  },
  hostname: {
    bg: 'rgba(6,182,212,0.15)',
    border: 'rgba(6,182,212,0.45)',
    text: 'rgb(14,116,144)',
  },
  credential: {
    bg: 'rgba(239,68,68,0.18)',
    border: 'rgba(239,68,68,0.5)',
    text: 'rgb(153,27,27)',
  },
  user: {
    bg: 'rgba(245,158,11,0.18)',
    border: 'rgba(245,158,11,0.45)',
    text: 'rgb(146,64,14)',
  },
  path: {
    bg: 'rgba(236,72,153,0.15)',
    border: 'rgba(236,72,153,0.45)',
    text: 'rgb(157,23,77)',
  },
};

const INLINE_FALLBACK: InlineTokenStyle[] = [
  {
    bg: 'rgba(99,102,241,0.15)',
    border: 'rgba(99,102,241,0.45)',
    text: 'rgb(55,48,163)',
  },
  {
    bg: 'rgba(20,184,166,0.15)',
    border: 'rgba(20,184,166,0.45)',
    text: 'rgb(17,94,89)',
  },
  {
    bg: 'rgba(249,115,22,0.15)',
    border: 'rgba(249,115,22,0.45)',
    text: 'rgb(154,52,18)',
  },
  {
    bg: 'rgba(217,70,239,0.15)',
    border: 'rgba(217,70,239,0.45)',
    text: 'rgb(134,25,143)',
  },
  {
    bg: 'rgba(132,204,22,0.15)',
    border: 'rgba(132,204,22,0.45)',
    text: 'rgb(63,98,18)',
  },
];

function normalizeCategory(category: string | null | undefined): string {
  return (category ?? '').toLowerCase().trim();
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function getCategoryStyle(category: string | null | undefined): TokenStyle {
  const key = normalizeCategory(category);
  if (key && PALETTE[key]) return PALETTE[key];
  if (!key) return FALLBACK[0]!;
  return FALLBACK[hashString(key) % FALLBACK.length]!;
}

export function getCategoryInlineStyles(category: string | null | undefined): InlineTokenStyle {
  const key = normalizeCategory(category);
  if (key && INLINE_PALETTE[key]) return INLINE_PALETTE[key];
  if (!key) return INLINE_FALLBACK[0]!;
  return INLINE_FALLBACK[hashString(key) % INLINE_FALLBACK.length]!;
}
