/**
 * Flow screen 2 — Review queue. Re-skins components/ReviewQueue.tsx +
 * PatternSuggestions, wired to the REAL store/API (no seed array).
 *
 * Store surface (verified against store.ts):
 *   reviewItems (ReviewItem[]), refreshReview, reviewAction(id, action, type),
 *   isJudging, judgeStatus.
 *
 * ReviewItem shape (api.ts): { id, span, surrounding, suggested_cat, confidence,
 *   source_event }. Heuristic vs judge is derived from `source_event`: items
 *   whose source mentions "judge"/"llm" are judge findings, everything else is a
 *   corp-entity heuristic.
 *
 * Session stats: pending = live queue length. The web review API exposes no
 * cumulative confirmed/allowed counters, so we count the user's own actions this
 * session locally (incremented in reviewAction wrappers) rather than inventing a
 * store field — honest and resets per session, matching "This session".
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Check,
  Shield,
  X,
  Filter,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import { useStore } from '../../store';
import { getCategoryHue } from '../../lib/colors';
import { categoryLabel } from '../../lib/categories';
import type { ReviewItem } from '../../api';
import { Segmented } from '../ui/Segmented';

const POLL_MS = 8000; // matches the existing ReviewQueue poll cadence

type FilterKind = 'all' | 'heuristic' | 'judge';

/** Judge findings are tagged in `source_event` (e.g. "judge: multilingual name").
 * Everything else is a corp-entity heuristic. */
function isJudgeItem(it: ReviewItem): boolean {
  const src = (it.source_event ?? '').toLowerCase();
  return src.includes('judge') || src.includes('llm');
}

/** Default category an item confirms to. Backend stores categories lowercase;
 * suggested_cat may be null → fall back to 'customer' (the dominant review case). */
function itemCategory(it: ReviewItem): string {
  return (it.suggested_cat ?? 'customer').toLowerCase();
}

function ConfidenceBar({ value }: { value: number }): JSX.Element {
  const pct = Math.round(value * 100);
  const fill = value > 0.7 ? 'var(--ok)' : 'var(--warn)';
  return (
    <div className="flex min-w-[96px] items-center gap-2">
      <div
        className="h-[5px] flex-1 overflow-hidden rounded-[3px]"
        style={{ background: 'var(--surface-3)' }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`Confidence ${pct} percent`}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: fill }} />
      </div>
      <span className="font-mono text-[10.5px] text-text-faint">{pct}%</span>
    </div>
  );
}

function ItemCard({
  item,
  onAction,
}: {
  item: ReviewItem;
  onAction: (id: number, action: 'confirm' | 'allowlist' | 'ignore', type: string) => void;
}): JSX.Element {
  const judge = isJudgeItem(item);
  const cat = itemCategory(item);
  const label = categoryLabel(cat);
  const hue = getCategoryHue(cat);
  return (
    <div className="ps-panel" style={{ padding: 15 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="font-mono text-[15px] font-semibold text-text">{item.span}</span>
          <span
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium"
            style={
              judge
                ? { background: 'var(--acc-tint)', color: 'var(--acc)', borderColor: 'transparent' }
                : { borderColor: 'var(--border)', color: 'var(--text-dim)' }
            }
          >
            {judge ? (
              <>
                <Sparkles size={11} color="var(--acc)" aria-hidden="true" /> judge
              </>
            ) : (
              <>
                <Filter size={11} aria-hidden="true" /> heuristic
              </>
            )}
          </span>
          <span
            className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-text-dim"
          >
            <span
              aria-hidden="true"
              style={{ width: 6, height: 6, borderRadius: 2, background: hue }}
            />
            → {label}
          </span>
        </div>
        <ConfidenceBar value={item.confidence} />
      </div>

      {item.surrounding && (
        <p
          className="font-mono text-text-dim"
          style={{ fontSize: 11.5, lineHeight: 1.5, margin: '9px 0 12px' }}
          title={item.surrounding}
        >
          {item.surrounding}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onAction(item.id, 'confirm', cat)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium"
          style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}
        >
          <Check size={14} aria-hidden="true" /> Confirm as {label}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onAction(item.id, 'allowlist', cat)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-dim hover:bg-surface-2 hover:text-text"
        >
          <Shield size={14} aria-hidden="true" /> Always allow
        </button>
        <button
          type="button"
          onClick={() => onAction(item.id, 'ignore', cat)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-dim hover:bg-surface-2 hover:text-text"
        >
          <X size={14} aria-hidden="true" /> Ignore
        </button>
      </div>
    </div>
  );
}

function FilterControl({
  value,
  onChange,
  total,
}: {
  value: FilterKind;
  onChange: (v: FilterKind) => void;
  total: number;
}): JSX.Element {
  const opts: ReadonlyArray<{ value: FilterKind; label: string; icon?: JSX.Element }> = [
    { value: 'all', label: `All · ${total}` },
    { value: 'heuristic', label: 'Heuristic', icon: <Filter size={13} aria-hidden="true" /> },
    { value: 'judge', label: 'Judge', icon: <Sparkles size={13} aria-hidden="true" /> },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter review items"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
    >
      {opts.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors"
            style={active ? { background: 'var(--acc-tint)', color: 'var(--acc)' } : { color: 'var(--text-dim)' }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const LEGEND: ReadonlyArray<{ icon: JSX.Element; title: string; desc: string }> = [
  {
    icon: <Check size={15} color="var(--ok)" aria-hidden="true" />,
    title: 'Confirm',
    desc: 'Mints a permanent token — future runs auto-scrub it.',
  },
  {
    icon: <Shield size={15} color="var(--acc)" aria-hidden="true" />,
    title: 'Always allow',
    desc: 'Never flag this string again.',
  },
  {
    icon: <X size={15} color="var(--text-faint)" aria-hidden="true" />,
    title: 'Ignore',
    desc: 'One-time pass; may resurface later.',
  },
];

export function ReviewPage(): JSX.Element {
  const items = useStore((s) => s.reviewItems);
  const refreshReview = useStore((s) => s.refreshReview);
  const reviewAction = useStore((s) => s.reviewAction);

  const [filter, setFilter] = useState<FilterKind>('all');
  // Session counters — local; the review API exposes no cumulative totals.
  const [confirmed, setConfirmed] = useState(0);
  const [allowed, setAllowed] = useState(0);

  useEffect(() => {
    void refreshReview();
    const id = setInterval(() => void refreshReview(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshReview]);

  const handleAction = useCallback(
    (id: number, action: 'confirm' | 'allowlist' | 'ignore', type: string) => {
      if (action === 'confirm') setConfirmed((n) => n + 1);
      else if (action === 'allowlist') setAllowed((n) => n + 1);
      void reviewAction(id, action, type);
    },
    [reviewAction],
  );

  const shown = useMemo(
    () =>
      items.filter((it) =>
        filter === 'all' ? true : filter === 'judge' ? isJudgeItem(it) : !isJudgeItem(it),
      ),
    [items, filter],
  );

  return (
    <div className="flex min-h-full items-start gap-4">
      {/* ── list column ──────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3">
          <FilterControl value={filter} onChange={setFilter} total={items.length} />
        </div>

        {shown.length === 0 ? (
          <div
            className="ps-panel flex flex-col items-center gap-2.5 text-center"
            style={{ padding: 40 }}
          >
            <div
              className="grid h-[44px] w-[44px] place-items-center rounded-xl"
              style={{ background: 'var(--ok-tint)' }}
              aria-hidden="true"
            >
              <CheckCircle2 size={22} color="var(--ok)" />
            </div>
            <span className="text-[14px] font-semibold text-text">Queue clear</span>
            <span className="text-[12px] text-text-faint">
              Nothing waiting on review. New low-confidence spans will land here.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {shown.map((it) => (
              <ItemCard key={it.id} item={it} onAction={handleAction} />
            ))}
          </div>
        )}
      </div>

      {/* ── right rail ───────────────────────────────────────────────────── */}
      <aside className="flex w-[270px] flex-none flex-col gap-3.5">
        <div className="ps-panel" style={{ padding: 16 }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
            This session
          </span>
          <div className="mt-3 flex gap-4">
            <Stat value={items.length} label="pending" />
            <Stat value={confirmed} label="confirmed" color="var(--ok)" />
            <Stat value={allowed} label="allowed" />
          </div>
        </div>

        <div className="ps-panel" style={{ padding: 16 }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
            What each action does
          </span>
          <div className="mt-3 flex flex-col gap-2.5">
            {LEGEND.map((l) => (
              <div key={l.title} className="flex items-start gap-2.5">
                <span style={{ marginTop: 1 }}>{l.icon}</span>
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-semibold text-text">{l.title}</span>
                  <span className="text-[11.5px] leading-snug text-text-faint">{l.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Stat({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[26px] font-semibold leading-none text-text" style={color ? { color } : undefined}>
        {value}
      </span>
      <span className="mt-1 text-[11px] text-text-faint">{label}</span>
    </div>
  );
}

/** Header-right status chip for the Review route — re-skins the judge "scanning"
 * indicator. Exported so App composes it into the Shell `headerRight`. */
export function ReviewHeaderRight(): JSX.Element {
  const isJudging = useStore((s) => s.isJudging);
  const enabled = useStore((s) => s.judgeStatus?.config.enabled);
  // "Judge on · scanning" when actively judging; "Judge on" idle; "Judge off"
  // when disabled. Status is carried by word + icon (no color-alone).
  const on = enabled !== false;
  const text = !on ? 'Judge off' : isJudging ? 'Judge on · scanning' : 'Judge on';
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-text-dim"
      title={text}
      role="status"
    >
      <span
        aria-hidden="true"
        className={isJudging ? 'animate-pulse' : ''}
        style={{
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: on ? 'var(--acc)' : 'var(--text-faint)',
        }}
      />
      {text}
    </span>
  );
}
