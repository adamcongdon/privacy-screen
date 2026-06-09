import { useEffect, useRef } from 'react';
import { useStore, type FeedbackJobState } from '../store';
import { Loader2, X, ExternalLink } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Fixed-position feedback job pill that reflects the activeFeedbackJob state.
 */
export function FeedbackJobPill(): JSX.Element | null {
  const active = useStore((s) => s.activeFeedbackJob);
  const clearFeedbackJob = useStore((s) => s.clearFeedbackJob);

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (active.status === 'done') {
      // Auto-dismiss after 8s
      timerRef.current = window.setTimeout(() => {
        clearFeedbackJob();
      }, 8000);
    }
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [active?.status, clearFeedbackJob]);

  if (!active) return null;

  const tone =
    active.status === 'done'
      ? 'border-emerald-800 bg-emerald-950/90 text-emerald-100'
      : active.status === 'error'
        ? 'border-rose-800 bg-rose-950/70 text-rose-200'
        : 'border-zinc-800 bg-zinc-900/60 text-zinc-100';

  const content = (() => {
    if (active.status === 'queued' || active.status === 'drafting') {
      return (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Drafting feedback…</span>
        </>
      );
    }
    if (active.status === 'filing') {
      return (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Filing on GitHub…</span>
        </>
      );
    }
    if (active.status === 'done') {
      return (
        <>
          <span className="text-xs">Filed as </span>
          {typeof active.issueNumber === 'number' && active.issueUrl ? (
            <a href={active.issueUrl} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-1 text-xs underline decoration-emerald-500">
              #{active.issueNumber}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : typeof active.issueNumber === 'number' ? (
            <span className="ml-1 text-xs">#{active.issueNumber}</span>
          ) : (
            <span className="ml-1 text-xs">#</span>
          )}
        </>
      );
    }
    // error
    const msg = active.error ?? 'unknown';
    const truncated = msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
    return (
      <>
        <span className="text-xs">Feedback failed: {truncated}</span>
      </>
    );
  })();

  return (
    <div className={cn('fixed top-4 right-4 z-40 flex items-center gap-3 rounded-md border p-3 shadow-lg', tone)}>
      <div className="flex items-center gap-3">
        {content}
      </div>
      <button
        type="button"
        onClick={() => clearFeedbackJob()}
        aria-label="dismiss"
        className="ml-2 rounded text-current/60 hover:text-current"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
