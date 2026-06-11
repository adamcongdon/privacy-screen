/**
 * Token category metadata — single source of truth for the Flow token system.
 *
 * Mirrors `CATS` from the design kit (`reference/kit.jsx`), but stores the base
 * hue under `hue` (the `--cat` CSS variable the `.ps-pill` color-mix rules read)
 * rather than the kit's `color` key. Hues are authoritative per README §Design
 * Tokens (category base hues, line ~247).
 *
 * Every category's identity is carried by its label/token text — color is
 * redundant reinforcement only (WCAG 1.4.1).
 */

export type CategoryMeta = {
  /** Base hue fed to `var(--cat)` for color-mix pill tinting. */
  hue: string;
  /** Human-readable category label. */
  label: string;
};

export const CATS: Record<string, CategoryMeta> = {
  ip: { hue: '#4c8dff', label: 'IP' },
  customer: { hue: '#b07cff', label: 'Customer' },
  email: { hue: '#26c281', label: 'Email' },
  host: { hue: '#22c1d6', label: 'Hostname' },
  phone: { hue: '#f59e0b', label: 'Phone' },
  addr: { hue: '#fb923c', label: 'Address' },
  url: { hue: '#2dd4bf', label: 'URL' },
  account: { hue: '#fb7185', label: 'Account' },
  user: { hue: '#f0a5c0', label: 'User' },
  path: { hue: '#94a3b8', label: 'Path' },
  credential: { hue: '#f76d6d', label: 'Credential' },
};

/**
 * Resolve a category label for display. Unknown categories fall back to a
 * Title-cased rendering of the raw key so the UI never shows an empty label.
 */
export function categoryLabel(key: string | null | undefined): string {
  const norm = (key ?? '').toLowerCase().trim();
  const meta = CATS[norm];
  if (meta) return meta.label;
  if (!norm) return 'Unknown';
  return norm.charAt(0).toUpperCase() + norm.slice(1);
}
