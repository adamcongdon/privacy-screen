/**
 * Flow — Pattern Suggestions. Restores components/PatternSuggestions.tsx (deleted
 * in 3a15e30 during the Flow redesign) into the new Flow shell, re-skinned from
 * the old zinc/indigo palette to the Flow design tokens (--surface, --acc,
 * --border, --ok, --warn, --danger, ps-panel, text-text*).
 *
 * The pattern-induction backend (server/routes/patterns.ts) and the store wiring
 * (patterns + refreshPatterns/suggestPatterns/patternAction) were never removed —
 * only this UI was. It is the natural companion to the judge review queue: both
 * surface "things the system wants you to confirm", so it lives as a section on
 * the Review page.
 *
 * Store surface (verified against store.ts — used exactly as-is, no store edits):
 *   patterns (InducedPatternDto[]), refreshPatterns(), suggestPatterns(category?),
 *   patternAction(id, 'activate'|'reject'|'edit', regex?), composerText.
 *
 * WCAG: matches the flow/ ARIA conventions — section has aria-label, every icon
 * button carries a text label + aria-label, the edit field has aria-describedby
 * pointing at a role=status live region, decorative icons are aria-hidden.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import { Check, Pencil, Sparkles, X } from 'lucide-react';
import { useStore } from '../../store';
import { cn } from '../../lib/cn';
import type { InducedPatternDto } from '../../api';

export function PatternSuggestions(): JSX.Element {
  const patterns = useStore((s) => s.patterns);
  const refreshPatterns = useStore((s) => s.refreshPatterns);
  const suggestPatterns = useStore((s) => s.suggestPatterns);
  const patternAction = useStore((s) => s.patternAction);
  const composerText = useStore((s) => s.composerText);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);

  // Mount fetch + poll, matching the old component's 8s cadence (and the Review
  // queue's POLL_MS). Idempotent and cheap.
  useEffect(() => {
    void refreshPatterns().finally(() => setLoading(false));
    const id = setInterval(() => void refreshPatterns(), 8000);
    return () => clearInterval(id);
  }, [refreshPatterns]);

  const pending = patterns.filter((p) => p.status === 'pending');

  async function handleSuggest(): Promise<void> {
    setSuggesting(true);
    try {
      await suggestPatterns();
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <section aria-label="Pattern suggestions" className="ps-panel" style={{ padding: 16 }}>
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
            Pattern suggestions
          </span>
          {pending.length > 0 && (
            <span
              className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold"
              style={{ background: 'var(--acc-tint)', color: 'var(--acc)' }}
            >
              {pending.length}
            </span>
          )}
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void handleSuggest()}
            disabled={suggesting}
            aria-label="Analyze minted values and suggest regex patterns"
            title="Analyze minted values and suggest regex patterns"
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
              suggesting ? 'cursor-wait' : 'hover:opacity-90',
            )}
            style={{ background: 'var(--acc-tint)', color: 'var(--acc)' }}
          >
            <Sparkles size={13} aria-hidden="true" />
            {suggesting ? 'Analyzing…' : 'Suggest'}
          </button>
        )}
      </header>

      {loading ? (
        <ul aria-label="Pending induced patterns" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-16 animate-pulse rounded-md"
              style={{ background: 'var(--surface-3)' }}
            />
          ))}
        </ul>
      ) : pending.length === 0 ? (
        <p className="text-[12px] text-text-faint">
          Mint ≥3 values under the same category, then choose Suggest to induce a
          reusable regex pattern.
        </p>
      ) : (
        <ul aria-label="Pending induced patterns" className="flex flex-col gap-2">
          {pending.map((p) => (
            <PatternCard
              key={p.id}
              pattern={p}
              latestScrubInput={composerText}
              onAction={patternAction}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PatternCard({
  pattern,
  latestScrubInput,
  onAction,
}: {
  pattern: InducedPatternDto;
  latestScrubInput: string;
  onAction: (id: number, action: 'activate' | 'reject' | 'edit', regex?: string) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draftRegex, setDraftRegex] = useState(pattern.skeleton);
  const [feedback, setFeedback] = useState<{ valid: boolean; message: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) {
      setDraftRegex(pattern.skeleton);
      setFeedback(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing, pattern.skeleton]);

  // Validate the edited regex and (if there's composer text) test it against the
  // current input so the user sees how many matches it would catch.
  function validateDraft(value: string): { valid: boolean; message: string } {
    if (value.length > 200) return { valid: false, message: 'Pattern too long (max 200 chars)' };
    if (/\(\?:.*?\)[*+]|\(\..*?\)[*+]/.test(value))
      return { valid: false, message: 'Pattern too complex (nested quantifiers)' };
    try {
      const rx = new RegExp(value, 'g');
      const matchCount = latestScrubInput ? (latestScrubInput.match(rx) ?? []).length : 0;
      const msg = latestScrubInput
        ? `${matchCount} match${matchCount !== 1 ? 'es' : ''} in current input`
        : 'Valid regex';
      return { valid: true, message: msg };
    } catch {
      return { valid: false, message: 'Invalid regex' };
    }
  }

  function handleDraftChange(value: string): void {
    setDraftRegex(value);
    setFeedback(validateDraft(value));
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      setEditing(false);
      setTimeout(() => editBtnRef.current?.focus(), 0);
    }
  }

  async function handleSave(): Promise<void> {
    const result = validateDraft(draftRegex);
    if (!result.valid) return;
    await onAction(pattern.id, 'edit', draftRegex);
    setEditing(false);
  }

  const examples = pattern.source_examples;
  const confidencePct = (pattern.confidence * 100).toFixed(0);

  return (
    <li
      aria-label={`Pattern ${pattern.skeleton}, ${confidencePct}% confidence`}
      className="rounded-md border border-border p-2.5 text-[12px]"
      style={{ background: 'var(--surface-2)' }}
    >
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draftRegex}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Edit regex pattern"
            aria-describedby={`pattern-feedback-${pattern.id}`}
            className="mb-1.5 w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text focus:outline-none focus:ring-2"
            style={{ ['--tw-ring-color' as string]: 'var(--acc)' }}
          />
          <span
            id={`pattern-feedback-${pattern.id}`}
            role="status"
            aria-live="polite"
            className="mb-1.5 block text-[11px]"
            style={{
              color:
                feedback === null
                  ? 'var(--text-faint)'
                  : feedback.valid
                    ? 'var(--ok)'
                    : 'var(--danger)',
            }}
          >
            {feedback?.message ?? ''}
          </span>
          <div className="flex gap-1.5">
            <PatternButton
              kind="save"
              label="Save"
              disabled={feedback !== null && !feedback.valid}
              onClick={() => void handleSave()}
            />
            <PatternButton
              kind="cancel"
              label="Cancel"
              onClick={() => {
                setEditing(false);
                setTimeout(() => editBtnRef.current?.focus(), 0);
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono font-semibold text-text">{pattern.skeleton}</span>
            <span className="text-[10.5px] uppercase tracking-[0.06em] text-text-faint">
              {confidencePct}%
            </span>
          </div>
          <p
            className="mb-2 truncate font-mono text-[11px] text-text-faint"
            title={examples.join(' · ')}
          >
            {examples.join(' · ')}
          </p>
          <div className="flex gap-1.5">
            <PatternButton
              kind="activate"
              label="Activate"
              icon={<Check size={13} aria-hidden="true" />}
              onClick={() => void onAction(pattern.id, 'activate')}
            />
            <PatternButton
              ref={editBtnRef}
              kind="edit"
              label="Edit"
              icon={<Pencil size={13} aria-hidden="true" />}
              onClick={() => setEditing(true)}
            />
            <PatternButton
              kind="reject"
              label="Reject"
              icon={<X size={13} aria-hidden="true" />}
              onClick={() => void onAction(pattern.id, 'reject')}
            />
          </div>
        </>
      )}
    </li>
  );
}

type PatternButtonProps = {
  kind: 'activate' | 'edit' | 'reject' | 'save' | 'cancel';
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
  onClick: () => void;
};

// forwardRef so the parent can restore focus to the Edit button after cancel /
// Escape (WCAG 2.4.3 focus order) — a plain function component can't receive a ref.
const PatternButton = forwardRef<HTMLButtonElement, PatternButtonProps>(function PatternButton(
  { kind, label, icon, disabled, onClick },
  ref,
): JSX.Element {
  // Flow-token styling: activate/save use --ok, reject uses --danger, edit/cancel
  // are neutral. Color is always paired with a text label (1.4.1).
  const style: React.CSSProperties =
    disabled
      ? { background: 'var(--surface-3)', color: 'var(--text-faint)' }
      : kind === 'activate' || kind === 'save'
        ? { background: 'var(--ok-tint)', color: 'var(--ok)' }
        : kind === 'reject'
          ? { background: 'var(--danger-bg)', color: 'var(--danger)' }
          : { background: 'var(--surface-3)', color: 'var(--text-dim)' };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] font-medium',
        disabled ? 'cursor-not-allowed' : 'hover:opacity-90',
      )}
      style={style}
    >
      {icon}
      {label}
    </button>
  );
});
