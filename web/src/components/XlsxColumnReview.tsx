/**
 * XlsxColumnReview — modal for the xlsx commit step (#23 Segment 3C3).
 *
 * Renders when `pendingXlsx !== null` in the store. Shows per-sheet tables
 * with one row per column: header text, sample value, the detected pattern
 * (editable via `<select>`), and a provenance badge. The user confirms or
 * overrides each pick, then "Scrub & download" POSTs the override map to
 * `/api/files/xlsx/commit`. The store handles the success path: triggers
 * a browser download of the scrubbed bytes, toasts, and clears the review.
 *
 * **Override payload policy.** We always send the FULL selections object to
 * the server, even for columns where the user accepted the auto-detect. The
 * server treats an explicit-matches-auto override as a no-op, and the wire
 * cost is trivial; this is far easier to reason about than diffing against
 * the inspection payload. (Documented at the SegmentSpec level — do not
 * "optimize" this without revisiting the spec.)
 *
 * Visual style mirrors `FeedbackDialog.tsx` — centered modal, zinc-950
 * surface, indigo primary, zinc secondaries, dark-mode throughout. Uses
 * the `DialogScroll` substrate so the body scrolls without trapping the
 * footer below the fold (the same flex-overflow trap that motivated #20).
 */

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import {
  DialogHeader,
  ScrollableDialogBody,
  DialogFooter,
} from './ui/DialogScroll';
import type {
  XlsxColumnInspection,
  XlsxColumnSource,
  XlsxCommitOverrides,
  XlsxPatternName,
  XlsxSheetInspection,
} from '../api';

/** The closed list of PatternName literals, mirroring src/xlsx-types.ts. */
const PATTERN_NAMES: readonly XlsxPatternName[] = [
  'Email', 'Phone', 'SSN', 'IPv4', 'IPv6',
  'PersonName', 'StreetAddress', 'FQDN', 'CreditCard',
  'UncPath', 'DomainUser', 'MAC', 'GUID',
];

/**
 * Override option value used in the column `<select>`.
 * Plain string union of pattern picks + 'custom' for user-defined labels (#39).
 */
type OverrideKind = XlsxPatternName | 'skip' | 'regex' | 'custom';

/**
 * One column's selection — pattern pick + (when kind === 'custom') the
 * user-supplied label they'll force-mint with. Carrying both fields in the
 * map keeps the editing UX trivial: the inline text input writes back via
 * the same setSelections call as the `<select>`.
 */
type Selection = { kind: OverrideKind; label: string };

/** Selections keyed `${sheetName}::${header}` so duplicates across sheets stay distinct. */
type SelectionMap = Record<string, Selection>;

/**
 * Same shape used by the server (`normalizeCustomLabel`): uppercase
 * alphanumerics + underscores, length 2-24, must start with a letter. We
 * preview the normalization in the input's hint so users see what their raw
 * input becomes before they commit.
 */
const CUSTOM_LABEL_PREVIEW_MAX = 24;
function previewCustomLabel(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, CUSTOM_LABEL_PREVIEW_MAX);
}
function isCustomLabelValid(raw: string): boolean {
  const norm = previewCustomLabel(raw);
  return norm.length >= 2 && /^[A-Z]/.test(norm);
}

function selectionKey(sheet: string, header: string): string {
  return `${sheet}::${header}`;
}

/**
 * Derive the initial selection for a column.
 *
 * - `rule` or `heuristic` with a resolved pattern → that pattern.
 * - `unresolved` → 'regex' (the whole-cell scrubText fallback, which is the
 *   server's default when no override and no auto-resolve hits).
 * - `rule`/`heuristic` with a null resolvedPattern (shouldn't happen given the
 *   server's invariants but we handle defensively) → 'regex'.
 */
function defaultSelection(col: XlsxColumnInspection): Selection {
  if (col.resolvedPattern !== null) return { kind: col.resolvedPattern, label: '' };
  return { kind: 'regex', label: '' };
}

function buildInitialSelections(sheets: XlsxSheetInspection[]): SelectionMap {
  const out: SelectionMap = {};
  for (const sheet of sheets) {
    for (const col of sheet.columns) {
      out[selectionKey(sheet.name, col.header)] = defaultSelection(col);
    }
  }
  return out;
}

/**
 * Convert the flat selection map into the nested CommitOverrides shape the
 * server expects. Empty header strings are skipped because the server's
 * override validator treats them as a footgun (header keys must be addressable).
 *
 * For `kind: 'custom'` selections we normalize the label client-side too —
 * keeps the wire payload consistent with what the server stores and lets the
 * Scrub button's enabled-check use the same shape the server will accept.
 */
function selectionsToOverrides(
  sheets: XlsxSheetInspection[],
  selections: SelectionMap,
): XlsxCommitOverrides {
  const out: XlsxCommitOverrides = {};
  for (const sheet of sheets) {
    const perSheet: Record<string, XlsxCommitOverrides[string][string]> = {};
    for (const col of sheet.columns) {
      if (col.header === '') continue;
      const sel = selections[selectionKey(sheet.name, col.header)];
      if (sel === undefined) continue;
      if (sel.kind === 'custom') {
        const label = previewCustomLabel(sel.label);
        if (!label) continue; // skip invalid custom rows — server would reject anyway
        perSheet[col.header] = { pattern: 'custom', label };
      } else {
        perSheet[col.header] = { pattern: sel.kind };
      }
    }
    if (Object.keys(perSheet).length > 0) {
      out[sheet.name] = perSheet;
    }
  }
  return out;
}

/** Source badge — one rounded pill per provenance kind. */
function SourceBadge({ source }: { source: XlsxColumnSource }): JSX.Element {
  const cls =
    source === 'rule'
      ? 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300'
      : source === 'heuristic'
        ? 'border-blue-700/60 bg-blue-950/60 text-blue-300'
        : 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-[1px] font-mono text-[10px] uppercase tracking-wider',
        cls,
      )}
    >
      {source === 'rule' ? 'remembered' : source}
    </span>
  );
}

/**
 * Per-column row. Pulled out for readability and to keep the per-sheet
 * `<table>` body uncluttered. Pure function of props — no store reads.
 */
function ColumnRow({
  sheetName,
  column,
  value,
  onChange,
}: {
  sheetName: string;
  column: XlsxColumnInspection;
  value: Selection;
  onChange: (next: Selection) => void;
}): JSX.Element {
  const showCustom = value.kind === 'custom';
  const labelPreview = showCustom ? previewCustomLabel(value.label) : '';
  const customValid = showCustom ? isCustomLabelValid(value.label) : true;
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="px-3 py-2 align-top">
        <span className="font-mono text-xs text-zinc-200">
          {column.header || <span className="text-zinc-600">(empty)</span>}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className="block max-w-[20rem] truncate font-mono text-[11px] text-zinc-400"
          title={column.sampleValue ?? ''}
        >
          {column.sampleValue ?? <span className="text-zinc-600">—</span>}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col gap-1">
          <select
            value={value.kind}
            onChange={(e) =>
              onChange({
                kind: e.target.value as OverrideKind,
                label: value.label,
              })
            }
            aria-label={`Pattern for column ${column.header || '(empty)'} in sheet ${sheetName}`}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            disabled={column.header === ''}
          >
            {PATTERN_NAMES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
            <option value="regex">Regex fallback — scan each cell</option>
            <option value="skip">Skip — leave column untouched</option>
            <option value="custom">Custom label…</option>
          </select>
          {showCustom && (
            <div className="flex flex-col gap-0.5">
              <input
                type="text"
                value={value.label}
                onChange={(e) => onChange({ kind: 'custom', label: e.target.value })}
                placeholder="e.g. ServerName, JobName"
                maxLength={32}
                aria-label={`Custom label for ${column.header || '(empty)'}`}
                className={cn(
                  'w-full rounded-md border bg-zinc-900/60 px-2 py-1 font-mono text-[11px] text-zinc-100 focus:outline-none focus:ring-2',
                  customValid
                    ? 'border-zinc-800 focus:ring-indigo-500/40'
                    : 'border-rose-800 focus:ring-rose-500/40',
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-mono',
                  customValid ? 'text-zinc-500' : 'text-rose-400',
                )}
              >
                {value.label.length === 0
                  ? 'token type required'
                  : customValid
                    ? `→ {${labelPreview}}`
                    : 'must start with a letter, 2-24 chars'}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <SourceBadge source={column.source} />
      </td>
    </tr>
  );
}

export function XlsxColumnReview(): JSX.Element | null {
  const pending = useStore((s) => s.pendingXlsx);
  const clearXlsxReview = useStore((s) => s.clearXlsxReview);
  const commitXlsxReview = useStore((s) => s.commitXlsxReview);

  // Re-key all local state on uploadId so a fresh review of a different file
  // doesn't inherit prior selections. We render only when pending !== null, so
  // a null check below short-circuits the whole tree before any hook reads.
  if (pending === null) return null;
  return <XlsxColumnReviewInner
    key={pending.uploadId}
    pending={pending}
    onCancel={clearXlsxReview}
    onCommit={commitXlsxReview}
  />;
}

/**
 * Inner — same component, but split so we can guarantee initial-selection
 * derivation runs exactly once per pending review (via the `key` on the outer
 * dispatch). Keeps the hook ordering trivially sound.
 */
function XlsxColumnReviewInner({
  pending,
  onCancel,
  onCommit,
}: {
  pending: NonNullable<ReturnType<typeof useStore.getState>['pendingXlsx']>;
  onCancel: () => void;
  onCommit: (overrides: XlsxCommitOverrides) => Promise<void>;
}): JSX.Element {
  const initial = useMemo(
    () => buildInitialSelections(pending.sheets),
    [pending.sheets],
  );
  const [selections, setSelections] = useState<SelectionMap>(initial);
  const [committing, setCommitting] = useState(false);

  // Per-column header (sheet-scoped). Stable per (sheet, header) pair.
  const onChangeSelection = (sheet: string, header: string, next: Selection): void => {
    setSelections((prev) => ({ ...prev, [selectionKey(sheet, header)]: next }));
  };

  const totalColumns = useMemo(
    () => pending.sheets.reduce((acc, s) => acc + s.columns.length, 0),
    [pending.sheets],
  );

  // Issue #39: block the Scrub button if any custom-labeled column has an
  // invalid label. Submitting would 400 server-side — better to gray out the
  // action and let the inline hint walk the user to a fix.
  const customInvalid = useMemo(() => {
    for (const sel of Object.values(selections)) {
      if (sel.kind === 'custom' && !isCustomLabelValid(sel.label)) return true;
    }
    return false;
  }, [selections]);

  const onSubmit = async (): Promise<void> => {
    if (committing || customInvalid) return;
    setCommitting(true);
    try {
      const overrides = selectionsToOverrides(pending.sheets, selections);
      await onCommit(overrides);
      // Successful commit clears pendingXlsx in the store, which unmounts us.
      // No setCommitting(false) needed in the happy path.
    } catch {
      // Store toasted; let the user adjust and retry.
      setCommitting(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !committing) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(900px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
          onOpenAutoFocus={(e) => { e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (committing) e.preventDefault(); }}
          onInteractOutside={(e) => { if (committing) e.preventDefault(); }}
        >
          <DialogHeader
            title="Review xlsx column scrubbing"
            onClose={committing ? undefined : onCancel}
            description={
              <>
                <span className="font-mono text-zinc-300">{pending.fileName}</span> —{' '}
                {pending.sheets.length} sheet{pending.sheets.length === 1 ? '' : 's'},{' '}
                {totalColumns} column{totalColumns === 1 ? '' : 's'}. Confirm or override
                the detected pattern for each column, then scrub. Nothing leaves your
                machine until you click <span className="font-semibold text-zinc-300">Scrub &amp; download</span>.
              </>
            }
          />

          <ScrollableDialogBody>
            <div className="flex flex-col gap-6">
              {pending.sheets.map((sheet) => (
                <section key={sheet.name} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">
                      {sheet.name}
                    </h3>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                      {sheet.rowCount} data row{sheet.rowCount === 1 ? '' : 's'} ·{' '}
                      {sheet.columns.length} column{sheet.columns.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {sheet.columns.length === 0 ? (
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-500">
                      No header row detected on this sheet — nothing to configure.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-md border border-zinc-800">
                      <table className="w-full table-fixed text-left">
                        <thead className="bg-zinc-900/60">
                          <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                            <th className="w-[22%] px-3 py-2 font-semibold">Column header</th>
                            <th className="w-[28%] px-3 py-2 font-semibold">Sample value</th>
                            <th className="w-[34%] px-3 py-2 font-semibold">Detected pattern</th>
                            <th className="w-[16%] px-3 py-2 font-semibold">Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sheet.columns.map((col) => (
                            <ColumnRow
                              key={`${sheet.name}::${col.header}`}
                              sheetName={sheet.name}
                              column={col}
                              value={selections[selectionKey(sheet.name, col.header)] ?? defaultSelection(col)}
                              onChange={(next: Selection) => onChangeSelection(sheet.name, col.header, next)}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ))}
            </div>
          </ScrollableDialogBody>

          <DialogFooter>
            <button
              type="button"
              onClick={onCancel}
              disabled={committing}
              className={cn(
                'rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800',
                committing && 'cursor-not-allowed opacity-60',
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={committing || customInvalid}
              title={customInvalid ? 'Fix the invalid custom label first' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold',
                committing || customInvalid
                  ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                  : 'bg-indigo-600 text-white hover:bg-indigo-500',
              )}
            >
              {committing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {committing ? 'Scrubbing…' : 'Scrub & download'}
            </button>
          </DialogFooter>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
