import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, Sparkles, X } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import type { InducedPatternDto } from '../api';

export function PatternSuggestions(): JSX.Element | null {
  const patterns = useStore((s) => s.patterns);
  const refreshPatterns = useStore((s) => s.refreshPatterns);
  const suggestPatterns = useStore((s) => s.suggestPatterns);
  const patternAction = useStore((s) => s.patternAction);
  const composerText = useStore((s) => s.composerText);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);

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
    <section aria-label="Pattern suggestions" className="flex min-h-0 flex-col gap-2 border-t border-zinc-800 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-violet-300">
          Pattern suggestions
        </h2>
        <div className="flex items-center gap-1.5">
          {!loading && (
            <button
              type="button"
              onClick={() => void handleSuggest()}
              disabled={suggesting}
              title="Analyze minted values and suggest regex patterns"
              className={cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                suggesting
                  ? 'cursor-wait border-violet-800 bg-violet-900/20 text-violet-500'
                  : 'border-violet-700 bg-violet-900/30 text-violet-300 hover:bg-violet-900/50',
              )}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {suggesting ? 'analyzing…' : 'suggest'}
            </button>
          )}
          {pending.length > 0 && (
            <span className="rounded-full bg-violet-500/20 px-1.5 text-[10px] font-semibold text-violet-300">
              {pending.length}
            </span>
          )}
        </div>
      </header>

      {loading ? (
        <ul aria-label="Pending induced patterns">
          {[0, 1, 2].map((i) => (
            <li key={i} className="animate-pulse rounded-md h-16 bg-zinc-800/40" />
          ))}
        </ul>
      ) : pending.length === 0 ? (
        <p className="text-[11px] text-zinc-500">
          Mint ≥3 values under the same category, then click suggest.
        </p>
      ) : (
        <ul aria-label="Pending induced patterns" className="flex max-h-64 min-h-0 flex-col gap-1 overflow-auto pr-1">
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

  function validateDraft(value: string): { valid: boolean; message: string } {
    if (value.length > 200) return { valid: false, message: 'Pattern too long (max 200 chars)' };
    if (/\(\?:.*?\)[*+]|\(\..*?\)[*+]/.test(value))
      return { valid: false, message: 'Pattern too complex (nested quantifiers)' };
    try {
      const rx = new RegExp(value);
      const matchCount = latestScrubInput
        ? (latestScrubInput.match(rx) ?? []).length
        : 0;
      const msg = latestScrubInput
        ? `${matchCount} match${matchCount !== 1 ? 'es' : ''} in composer`
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

  const examples = Array.isArray(pattern.source_examples)
    ? pattern.source_examples
    : (JSON.parse(pattern.source_examples as unknown as string) as string[]);

  return (
    <li
      aria-label={`Pattern ${pattern.skeleton}, ${(pattern.confidence * 100).toFixed(0)}% confidence`}
      className="rounded-md border border-violet-900/50 bg-violet-950/20 p-2 text-xs"
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
            aria-describedby={`feedback-${pattern.id}`}
            className="mb-1 w-full resize-none rounded border border-indigo-700 bg-zinc-900/80 px-2 py-1 font-mono text-xs text-violet-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          />
          <span
            id={`feedback-${pattern.id}`}
            role="status"
            aria-live="polite"
            className={cn(
              'mb-1 block text-[11px]',
              feedback === null
                ? 'text-zinc-500'
                : feedback.valid
                  ? 'text-emerald-400'
                  : 'text-red-400',
            )}
          >
            {feedback?.message ?? ''}
          </span>
          <div className="flex gap-1">
            <PatternButton
              kind="save"
              label="save"
              disabled={feedback !== null && !feedback.valid}
              onClick={() => void handleSave()}
            />
            <PatternButton
              kind="cancel"
              label="cancel"
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
            <span className="font-mono font-semibold text-violet-100">{pattern.skeleton}</span>
            <span className="text-[10px] uppercase tracking-wider text-violet-400">
              {(pattern.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <p
            className="mb-2 line-clamp-1 font-mono text-[11px] text-zinc-400"
            title={examples.join(' · ')}
          >
            {examples.join(' · ')}
          </p>
          <div className="flex gap-1">
            <PatternButton
              kind="activate"
              label="activate"
              icon={<Check className="h-3 w-3" />}
              onClick={() => void onAction(pattern.id, 'activate')}
            />
            <PatternButton
              ref={editBtnRef}
              kind="edit"
              label="edit"
              icon={<Pencil className="h-3 w-3" />}
              onClick={() => setEditing(true)}
            />
            <PatternButton
              kind="reject"
              label="reject"
              icon={<X className="h-3 w-3" />}
              onClick={() => void onAction(pattern.id, 'reject')}
            />
          </div>
        </>
      )}
    </li>
  );
}

const PatternButton = ({
  kind,
  label,
  icon,
  disabled,
  onClick,
  ref,
}: {
  kind: 'activate' | 'edit' | 'reject' | 'save' | 'cancel';
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}): JSX.Element => {
  const styles =
    kind === 'activate' || kind === 'save'
      ? 'border-emerald-700 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50'
      : kind === 'edit'
        ? 'border-indigo-700 bg-indigo-900/30 text-indigo-200 hover:bg-indigo-900/50'
        : 'border-zinc-700 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800';
  const disabledStyles = 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600';

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={cn(
        'flex flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[11px] font-medium',
        disabled ? disabledStyles : styles,
      )}
      title={label}
    >
      {icon}
      {label}
    </button>
  );
};
