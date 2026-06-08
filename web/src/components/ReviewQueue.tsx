import { useEffect } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import { PatternSuggestions } from './PatternSuggestions';

export function ReviewQueue(): JSX.Element | null {
  const items = useStore((s) => s.reviewItems);
  const refreshReview = useStore((s) => s.refreshReview);
  const reviewAction = useStore((s) => s.reviewAction);
  const isJudging = useStore((s) => s.isJudging);

  useEffect(() => {
    void refreshReview();
    const id = setInterval(() => void refreshReview(), 8000);
    return () => clearInterval(id);
  }, [refreshReview]);

  if (items.length === 0) return (
    <>
      {isJudging && <JudgeIndicator />}
      <PatternSuggestions />
    </>
  );

  return (
    <>
    {isJudging && <JudgeIndicator />}
    <PatternSuggestions />
    <section className="flex min-h-0 flex-col gap-2 border-t border-zinc-800 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
          Review queue
        </h2>
        <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-300">
          {items.length}
        </span>
      </header>

      <ul className="flex max-h-48 min-h-0 flex-col gap-1 overflow-auto pr-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-xs"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-amber-100">{item.span}</span>
              {item.suggested_cat && (
                <span className="text-[10px] uppercase tracking-wider text-amber-400">
                  {item.suggested_cat} · {(item.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {item.surrounding && (
              <p
                className="mb-2 line-clamp-2 font-mono text-[11px] text-zinc-400"
                title={item.surrounding}
              >
                {item.surrounding}
              </p>
            )}
            <div className="flex gap-1">
              <ActionButton
                kind="confirm"
                label="confirm"
                icon={<Check className="h-3 w-3" />}
                onClick={() => void reviewAction(item.id, 'confirm', 'CUSTOMER')}
              />
              <ActionButton
                kind="allowlist"
                label="allowlist"
                icon={<ShieldCheck className="h-3 w-3" />}
                onClick={() => void reviewAction(item.id, 'allowlist')}
              />
              <ActionButton
                kind="ignore"
                label="ignore"
                icon={<X className="h-3 w-3" />}
                onClick={() => void reviewAction(item.id, 'ignore')}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
    </>
  );
}

function JudgeIndicator(): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-400">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
      LLM analyzing...
    </div>
  );
}

function ActionButton({
  kind,
  label,
  icon,
  onClick,
}: {
  kind: 'confirm' | 'allowlist' | 'ignore';
  label: string;
  icon: JSX.Element;
  onClick: () => void;
}): JSX.Element {
  const styles =
    kind === 'confirm'
      ? 'border-emerald-700 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50'
      : kind === 'allowlist'
        ? 'border-sky-700 bg-sky-900/30 text-sky-200 hover:bg-sky-900/50'
        : 'border-zinc-700 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[11px] font-medium',
        styles,
      )}
      title={label}
    >
      {icon}
      {label}
    </button>
  );
}
