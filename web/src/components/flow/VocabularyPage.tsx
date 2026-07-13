/**
 * Flow screen 3 — Vocabulary. Promotes components/TokenMap.tsx + TokenMapDrawer.tsx
 * to a full page, wired to the REAL store/API (no seed data).
 *
 * Reused logic (do not reinvent):
 *   - row union (current tokens + cross-session tokenUnion + persisted vocab) →
 *     ported from TokenMapBody (components/TokenMap.tsx).
 *   - forget action → gated by confirm step (#88); store.forgetVocab(realValue, toastLabel?)
 *     where toastLabel=token when the row is masked (so toast + aria-label never leak
 *     real via a11y tree). Direct single-click no longer deletes (deferred until confirm).
 *
 * Store surface (verified against store.ts):
 *   tokens (Token[]), tokenUnion (Map<string,Token>), vocab (VocabRow[]),
 *   refreshVocab, forgetVocab(realValue, toastLabel?).
 *
 * VocabRow shape (api.ts): { real_value, token, category, confidence, first_seen,
 *   last_seen, hit_count, confirmed_by }. Use count = hit_count (persisted rows);
 *   session-only tokens with no persisted row show a use count of "—".
 *
 * WCAG: category filter chips carry a color DOT *and* a text label (1.4.1);
 * Reveal/Forget icon buttons have aria-label; mask defaults on (real value
 * hidden until the user reveals a specific row).
 *
 * #89 (WEB-07): Export is safe-by-default (tokens + categories only). Full
 * export (includes real_value = deanonymization key) requires an explicit
 * checkbox confirmation and uses a -SENSITIVE filename.
 */
import { useEffect, useMemo, useState } from 'react';
import { Search, Download, Eye, EyeOff, Trash2, Lock, AlertTriangle } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useStore } from '../../store';
import { useContextMenu } from '../../lib/useContextMenu';
import { getCategoryHue } from '../../lib/colors';
import { categoryLabel, CATS } from '../../lib/categories';
import type { Token, VocabRow } from '../../api';
import { mergeTokenSources } from '../../lib/tokens';
import { DialogHeader, ScrollableDialogBody, DialogFooter } from '../ui/DialogScroll';
import { cn } from '../../lib/cn';

/** A unified vocab row for the table — merges the session token streams with the
 * persisted vocab list so the page shows everything the user has tokenized. */
export type VocabExportRow = {
  token: string;
  realValue: string;
  category: string;
  /** Persisted hit_count, or null for session-only tokens with no vocab row. */
  uses: number | null;
};

/** @deprecated alias kept for internal use — prefer VocabExportRow */
type Row = VocabExportRow;

/** Safe export row: tokens + categories only — never carries real_value (#89). */
export type SafeExportRow = {
  token: string;
  category: string;
  uses: number | null;
};

/** Full export row: the deanonymization key. Only produced after explicit confirm. */
export type FullExportRow = SafeExportRow & {
  real_value: string;
};

/**
 * Build the JSON export payload (#89).
 * - `includeRealValues === false` (default): tokens + categories (+ uses); no real_value.
 * - `includeRealValues === true`: includes real_value (deanonymization key).
 */
export function buildExportPayload(
  rows: ReadonlyArray<VocabExportRow>,
  includeRealValues: boolean,
): SafeExportRow[] | FullExportRow[] {
  if (includeRealValues) {
    return rows.map((r) => ({
      token: r.token,
      category: r.category,
      uses: r.uses,
      real_value: r.realValue,
    }));
  }
  return rows.map((r) => ({
    token: r.token,
    category: r.category,
    uses: r.uses,
  }));
}

/** Filename for downloads. Full export is visibly flagged SENSITIVE (#89). */
export function exportFilename(
  includeRealValues: boolean,
  now: Date = new Date(),
): string {
  if (!includeRealValues) return 'privacy-screen-vocabulary.json';
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `privacy-screen-vocabulary-SENSITIVE-${y}${m}${d}.json`;
}

/** Trigger a browser JSON download for an already-built payload. */
export function downloadExportJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Build the merged, de-duplicated row set. Mirrors TokenMapBody's union order:
 * current scrub tokens first, then the cross-session union, then persisted vocab.
 * Persisted vocab carries the authoritative hit_count. */
function buildRows(
  tokens: Token[],
  tokenUnion: Map<string, Token>,
  vocab: VocabRow[],
): Row[] {
  const byReal = new Map<string, number>();
  for (const v of vocab) byReal.set(v.real_value, v.hit_count);

  const seen = new Set<string>();
  const out: Row[] = [];
  const push = (token: string, realValue: string, category: string) => {
    if (seen.has(token)) return;
    seen.add(token);
    out.push({
      token,
      realValue,
      category,
      uses: byReal.has(realValue) ? byReal.get(realValue)! : null,
    });
  };

  // Use shared merge for the token sources (current + union) — dedup + order preserved.
  for (const t of mergeTokenSources(tokens, tokenUnion)) {
    push(t.token, t.realValue, t.category);
  }
  for (const v of vocab) push(v.token, v.real_value, v.category);
  return out;
}

/** Filter chip — color dot + text label (never color alone). Selected uses
 * --acc-tint / --acc. */
function Chip({
  label,
  hue,
  selected,
  onClick,
}: {
  label: string;
  hue?: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[12px] font-medium transition-colors"
      style={
        selected
          ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent', fontWeight: 600 }
          : { borderColor: 'var(--border)', color: 'var(--text-dim)' }
      }
    >
      {hue && (
        <span
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: 2, background: hue, flex: 'none' }}
        />
      )}
      {label}
    </button>
  );
}

export function VocabularyPage({ query }: { query: string }): JSX.Element {
  const tokens = useStore((s) => s.tokens);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const vocab = useStore((s) => s.vocab);
  const refreshVocab = useStore((s) => s.refreshVocab);
  const forgetVocab = useStore((s) => s.forgetVocab);
  const setCustomDialogOpen = useContextMenu((s) => s.openCustomDialog); // "New category" chip (feature 3)

  const [category, setCategory] = useState<string>('all');
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  // #88: confirm step (deferred delete) so single-click never permanently forgets.
  // confirmToken identifies the *token* (safe, never holds realValue). When set,
  // the row shows inline confirm/cancel instead of direct trash. This also lets
  // us choose token vs real for the aria-label and the toastLabel passed to store.
  const [confirmToken, setConfirmToken] = useState<string | null>(null);

  // Pull the persisted vocab once on mount so the page is populated even on a
  // cold route (boot already fetches, but a direct deep-link to #/vocab might
  // race it; this is cheap and idempotent).
  useEffect(() => {
    void refreshVocab();
  }, [refreshVocab]);

  const allRows = useMemo(
    () => buildRows(tokens, tokenUnion, vocab),
    [tokens, tokenUnion, vocab],
  );

  // Categories present in the data, ordered by the canonical CATS order so the
  // chip row is stable. Only show chips for categories that actually exist.
  const presentCats = useMemo(() => {
    const present = new Set(allRows.map((r) => r.category.toLowerCase()));
    const ordered = Object.keys(CATS).filter((c) => present.has(c));
    // Any non-canonical categories tacked on at the end so they're still filterable.
    for (const c of present) if (!CATS[c]) ordered.push(c);
    return ordered;
  }, [allRows]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (category !== 'all' && r.category.toLowerCase() !== category) return false;
      if (!q) return true;
      return (
        r.token.toLowerCase().includes(q) || r.realValue.toLowerCase().includes(q)
      );
    });
  }, [allRows, category, query]);

  // By-category counts for the rail bar chart (over the full set, not the filtered
  // view — the chart is a stable overview).
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of allRows) {
      const c = r.category.toLowerCase();
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return presentCats
      .map((c) => ({ cat: c, n: m.get(c) ?? 0 }))
      .filter((x) => x.n > 0);
  }, [allRows, presentCats]);
  const max = Math.max(1, ...counts.map((c) => c.n));

  return (
    <div className="flex min-h-full items-start gap-4">
      {/* ── table column ─────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* category filter chips */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Chip
            label={`All · ${allRows.length}`}
            selected={category === 'all'}
            onClick={() => setCategory('all')}
          />
          {presentCats.map((c) => (
            <Chip
              key={c}
              label={categoryLabel(c)}
              hue={getCategoryHue(c)}
              selected={category === c}
              onClick={() => setCategory(c)}
            />
          ))}

          {/* New category (handoff feature 3) — dashed chip at end of filter row */}
          <button
            type="button"
            onClick={() => setCustomDialogOpen('')}
            className="inline-flex items-center rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-text-faint hover:border-[var(--acc)] hover:text-[var(--acc)]"
            title="Create a new token category (color + label)"
          >
            ＋ New category
          </button>
        </div>

        <div className="ps-panel overflow-hidden">
          {/* column header */}
          <div
            className="flex items-center px-4 py-[9px] text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-faint"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span style={{ width: 160 }}>Token</span>
            <span style={{ width: 100 }}>Category</span>
            <span className="min-w-0 flex-1">Real value</span>
            <span style={{ width: 56, textAlign: 'right' }}>Uses</span>
            <span style={{ width: 80 }} aria-hidden="true" />
          </div>

          {rows.length === 0 ? (
            <div className="px-4 py-[26px] text-center text-[12.5px] text-text-faint">
              {allRows.length === 0
                ? 'No tokens yet. Values you tokenize on the Scrub screen appear here.'
                : 'No tokens match.'}
            </div>
          ) : (
            <ul>
              {rows.map((r, i) => {
                const rev = !!revealed[r.token];
                const masked = '•'.repeat(Math.min(14, Math.max(4, r.realValue.length)));
                return (
                  <li
                    key={r.token}
                    className="flex items-center px-4 py-2.5 text-[12.5px]"
                    style={{ borderTop: i ? '1px solid var(--hairline)' : 0 }}
                  >
                    <span style={{ width: 160 }} className="min-w-0">
                      <span className="ps-pill" style={{ ['--cat' as string]: getCategoryHue(r.category) }}>
                        {r.token}
                      </span>
                    </span>
                    <span style={{ width: 100 }} className="text-text-dim">
                      {categoryLabel(r.category)}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-text-dim"
                      title={rev ? r.realValue : 'hidden — click reveal'}
                    >
                      {rev ? r.realValue : masked}
                    </span>
                    <span
                      style={{ width: 56, textAlign: 'right' }}
                      className="font-mono text-text-faint"
                    >
                      {r.uses ?? '—'}
                    </span>
                    <span style={{ width: 80 }} className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setRevealed((s) => ({ ...s, [r.token]: !s[r.token] }))}
                        aria-label={rev ? `Hide value for ${r.token}` : `Reveal value for ${r.token}`}
                        className="rounded-md px-1.5 py-1 text-text-faint hover:bg-surface-2 hover:text-text"
                      >
                        {rev ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                      </button>
                      {confirmToken === r.token ? (
                        // #88 confirm step (deferred): no single click deletes. Inline confirm
                        // uses displayLabel (token when masked) so a11y + confirm UI never leak real.
                        <span className="flex items-center gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={() => {
                              const displayLabel = rev ? r.realValue : r.token;
                              void forgetVocab(r.realValue, displayLabel);
                              setConfirmToken(null);
                            }}
                            aria-label={`Confirm forget for ${rev ? r.realValue : r.token}`}
                            className="rounded-md px-1 py-0.5 text-danger hover:bg-surface-2"
                            title="Confirm forget (deferred delete)"
                          >
                            confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmToken(null)}
                            aria-label="Cancel forget"
                            className="rounded-md px-1 py-0.5 text-text-faint hover:bg-surface-2"
                          >
                            cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmToken(r.token)}
                          aria-label={`Forget ${rev ? r.realValue : r.token}`}
                          className="rounded-md px-1.5 py-1 text-text-faint hover:bg-surface-2 hover:text-danger"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── right rail ───────────────────────────────────────────────────── */}
      <aside className="flex w-[240px] flex-none flex-col gap-3.5">
        <div className="ps-panel" style={{ padding: 16 }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
            By category
          </span>
          {counts.length === 0 ? (
            <p className="mt-3 text-[12px] text-text-faint">Nothing tokenized yet.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-[9px]">
              {counts.map(({ cat, n }) => (
                <div key={cat} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-text-dim">{categoryLabel(cat)}</span>
                    <span className="font-mono text-text-faint">{n}</span>
                  </div>
                  <div
                    className="h-[5px] overflow-hidden rounded-[3px]"
                    style={{ background: 'var(--surface-3)' }}
                  >
                    <div
                      style={{
                        width: `${(n / max) * 100}%`,
                        height: '100%',
                        background: getCategoryHue(cat),
                        opacity: 0.8,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ps-panel flex items-start gap-2" style={{ padding: 14 }}>
          <Lock size={15} color="var(--ok)" aria-hidden="true" />
          <span className="text-[11.5px] leading-snug text-text-dim">
            Values live only in <span className="font-mono">~/.privacy-screen</span> on this device.
          </span>
        </div>
      </aside>
    </div>
  );
}

/** #89 warning copy — full export is the deanonymization key. */
export const FULL_EXPORT_WARNING =
  'This file contains real values and is the key to deanonymize past conversations. It should not be stored in a synced or backed-up folder.';

/**
 * Export choice dialog (#89). Default path is tokens+categories only (no
 * real_value). Full export requires an explicit checkbox acknowledgement.
 */
export function VocabExportDialog({
  open,
  onOpenChange,
  rowCount,
  onExportSafe,
  onExportFull,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowCount: number;
  onExportSafe: () => void;
  onExportFull: () => void;
}): JSX.Element {
  const [ackFull, setAckFull] = useState(false);

  // Reset the gate whenever the dialog re-opens so a prior ack cannot stick.
  useEffect(() => {
    if (open) setAckFull(false);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader
            title="Export vocabulary"
            description={
              <>
                Choose what to write to disk. The safe default is tokens and
                categories only — it does <strong>not</strong> include real values.
              </>
            }
          />

          <ScrollableDialogBody className="space-y-4">
            <p className="text-xs text-zinc-400">
              {rowCount} token{rowCount === 1 ? '' : 's'} ready to export. Downloads
              stay on this device (never a network send).
            </p>

            <div className="rounded-md border border-amber-900/50 bg-amber-950/30 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-amber-400"
                  aria-hidden="true"
                />
                <p className="text-xs leading-relaxed text-amber-100/90">{FULL_EXPORT_WARNING}</p>
              </div>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={ackFull}
                  onChange={(e) => setAckFull(e.target.checked)}
                  className="mt-0.5"
                  data-testid="export-full-ack"
                />
                <span>
                  I understand this file is the deanonymization key and will not put it
                  in a synced folder.
                </span>
              </label>
            </div>
          </ScrollableDialogBody>

          <DialogFooter className="!items-stretch sm:!items-center">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!ackFull}
              onClick={onExportFull}
              data-testid="export-full-btn"
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium',
                ackFull
                  ? 'border-amber-800/80 bg-amber-950/40 text-amber-100 hover:bg-amber-900/50'
                  : 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600',
              )}
              title={
                ackFull
                  ? 'Download full vocabulary including real values'
                  : 'Check the acknowledgement box to enable full export'
              }
            >
              Export full (SENSITIVE)
            </button>
            <button
              type="button"
              onClick={onExportSafe}
              data-testid="export-safe-btn"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Export tokens only
            </button>
          </DialogFooter>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Header-right controls for the Vocabulary route: a search input + an Export
 * button. The search query is lifted to App so it can be passed into the page
 * body (which lives in the Shell `children`, a sibling of `headerRight`).
 *
 * #89: Export opens a choice dialog — safe default omits real_value; full
 * export requires explicit checkbox confirmation. */
export function VocabHeaderRight({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (q: string) => void;
}): JSX.Element {
  const tokens = useStore((s) => s.tokens);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const vocab = useStore((s) => s.vocab);
  const pushToast = useStore((s) => s.pushToast);
  const [exportOpen, setExportOpen] = useState(false);

  const rows = useMemo(
    () => buildRows(tokens, tokenUnion, vocab),
    [tokens, tokenUnion, vocab],
  );

  const onExportClick = () => {
    if (rows.length === 0) {
      pushToast('info', 'Nothing to export yet.');
      return;
    }
    setExportOpen(true);
  };

  const finishExport = (includeRealValues: boolean) => {
    const payload = buildExportPayload(rows, includeRealValues);
    const filename = exportFilename(includeRealValues);
    downloadExportJson(payload, filename);
    setExportOpen(false);
    const kind = includeRealValues ? 'full (SENSITIVE)' : 'tokens-only';
    pushToast(
      'success',
      `Exported ${rows.length} token${rows.length === 1 ? '' : 's'} (${kind}).`,
    );
  };

  return (
    <>
      <div
        className="flex items-center gap-2 rounded-[9px] border border-border bg-surface-2 px-2.5"
        style={{ width: 230, height: 32 }}
      >
        <Search size={15} className="text-text-faint" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search values or tokens…"
          aria-label="Search vocabulary"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-text placeholder:text-text-faint"
        />
      </div>
      <button
        type="button"
        onClick={onExportClick}
        className="flex items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-2.5 text-[12px] font-medium text-text-dim hover:bg-surface-3 hover:text-text"
        style={{ height: 32 }}
      >
        <Download size={14} aria-hidden="true" /> Export
      </button>
      <VocabExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        rowCount={rows.length}
        onExportSafe={() => finishExport(false)}
        onExportFull={() => finishExport(true)}
      />
    </>
  );
}
