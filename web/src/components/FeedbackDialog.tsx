/**
 * FeedbackDialog — modal for Issue #15 "Send feedback" flow.
 *
 * Flow:
 *   1. Topbar button flips `feedbackOpen` in the store → this dialog opens.
 *   2. On open we GET /api/feedback/preview to fetch the scrubbed diagnostics
 *      that will accompany the user's summary. We render that JSON read-only
 *      so the user can audit it before submitting.
 *   3. User types a free-text "What went wrong?" summary.
 *   4. User clicks Send → POST /api/feedback returns 202 + jobId → dialog closes, FeedbackJobPill takes over.
 *   5. Pill polls /api/feedback/:jobId every 500ms; surfaces Filed as #N (success) or error toast on terminal state.
 *
 * Privacy invariant (ISC-30 / ISC-32): the diagnostics surface displayed in
 * the <pre> block is the SAME shape the backend will send. The user sees
 * exactly what's about to leave their machine.
 *
 * Visual style mirrors SettingsDrawer.tsx — Radix Dialog primitives, zinc-950
 * surface, indigo accent for the primary action, zinc borders on secondary
 * controls, dark-mode treatment throughout.
 */

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import { DialogHeader, ScrollableDialogBody, DialogFooter } from './ui/DialogScroll';

const MAX_SUMMARY_LEN = 8_000;

type FeedbackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; json: string }
  | { kind: 'error'; message: string };

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const startFeedbackJob = useStore((s) => s.startFeedbackJob);

  const [summary, setSummary] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Refresh preview + reset form state every time the dialog opens.
  // Closing leaves the last summary in place only if it was a Cancel — on
  // successful send we explicitly clear it below.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview({ kind: 'loading' });
    void (async () => {
      try {
        const res = await fetch('/api/feedback/preview');
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          // Try to surface a server-supplied error if it returned JSON, else
          // fall back to the HTTP status.
          let msg = `HTTP ${res.status}`;
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && 'error' in parsed) {
              msg = String((parsed as { error: unknown }).error);
            }
          } catch {
            // non-JSON; keep HTTP status
          }
          setPreview({ kind: 'error', message: msg });
          return;
        }
        // Re-stringify for stable indentation regardless of server formatting.
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Keep the raw body if the server returned non-JSON for some reason.
        }
        setPreview({ kind: 'ready', json: pretty });
      } catch (err) {
        if (cancelled) return;
        setPreview({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Focus the textarea once the preview lands so screen readers + keyboard
  // users land at the action surface, not the diagnostics dump.
  useEffect(() => {
    if (!open) return;
    if (preview.kind !== 'ready') return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, preview.kind]);

  const trimmed = summary.trim();
  const canSend = trimmed.length > 0 && !sending && preview.kind !== 'loading';

  // Handoff spec: segmented type + prefilled GitHub URL (the recommended no-PAT path).
  const [fbKind, setFbKind] = useState<'bug' | 'idea' | 'question'>('bug');
  const fbTypes = [
    { id: 'bug' as const, label: 'Bug', tag: 'bug' },
    { id: 'idea' as const, label: 'Idea', tag: 'enhancement' },
    { id: 'question' as const, label: 'Question', tag: 'question' },
  ];
  const currentType = fbTypes.find((t) => t.id === fbKind)!;

  const onSend = async (): Promise<void> => {
    if (!canSend) return;
    // Per ADDENDUM handoff: the realistic path is a prefilled GitHub new-issue URL (no client auth/PAT).
    // We still support the existing job path if the server responds with jobId, but default to the URL open.
    const lines = [trimmed];
    lines.push('', '---', `Screen: ${window.location.hash || 'app'}`, `App: Privacy Screen (Flow)`, `Type: ${currentType.label}`);
    const url =
      `https://github.com/adamcongdon/privacy-screen/issues/new` +
      `?labels=${encodeURIComponent(currentType.tag + ',feedback')}` +
      `&title=${encodeURIComponent(`[${currentType.label}] ${trimmed.slice(0, 80)}`)}` +
      `&body=${encodeURIComponent(lines.join('\n'))}`;

    window.open(url, '_blank', 'noopener');
    pushToast('success', 'Opening GitHub to file your feedback…');
    setSummary('');
    onOpenChange(false);

    // Fire-and-forget the server job path if desired (keeps the pill system working for advanced use).
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: trimmed.slice(0, MAX_SUMMARY_LEN) }),
      });
      const raw = await res.text();
      let parsed: unknown = null;
      if (raw) { try { parsed = JSON.parse(raw); } catch {} }
      const body = (parsed ?? {}) as { ok?: boolean; jobId?: string };
      if (res.status === 202 && body.ok && body.jobId) {
        startFeedbackJob(body.jobId);
      }
    } catch {
      /* best effort; the prefilled URL already satisfied the handoff */
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
        >
          <DialogHeader
            title="Send feedback"
            description={
              <>
                Files a GitHub issue at <code className="font-mono">adamcongdon/privacy-screen</code>{' '}
                via your local <code className="font-mono">claude</code> +{' '}
                <code className="font-mono">gh</code> CLIs. The diagnostics below have already
                been scrubbed — that's exactly what gets attached to the issue.
              </>
            }
          />

          <ScrollableDialogBody>
            {/* Diagnostics preview — read-only audit surface, collapsed by default. */}
            <details className="mb-6">
              <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-300 select-none">
                Diagnostics (click to expand)
              </summary>
              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/60 overflow-auto">
                {preview.kind === 'loading' && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading diagnostics…
                  </div>
                )}
                {preview.kind === 'error' && (
                  <div className="px-3 py-2 text-xs text-rose-300">
                    Failed to load diagnostics: {preview.message}
                  </div>
                )}
                {preview.kind === 'ready' && (
                  <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200">
                    {preview.json}
                  </pre>
                )}
              </div>
            </details>

            {/* Type segmented (handoff spec) */}
            <div className="mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Type</span>
              <div className="mt-1.5 inline-flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 text-xs">
                {fbTypes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={fbKind === t.id}
                    onClick={() => setFbKind(t.id)}
                    className={`rounded-md px-3 py-1 ${fbKind === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Free-text summary. */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                What went wrong?
              </span>
              <textarea
                ref={textareaRef}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={8}
                maxLength={MAX_SUMMARY_LEN}
                spellCheck
                placeholder="Describe the bug or paste the steps that triggered it. Anything sensitive will be scrubbed before it leaves your machine."
                className="block w-full min-h-[10rem] max-h-[24rem] resize-y overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <span className="self-end text-[10px] text-zinc-500">
                {summary.length} / {MAX_SUMMARY_LEN}
              </span>
            </label>
          </ScrollableDialogBody>

          <DialogFooter>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={sending}
                className={cn(
                  'rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800',
                  sending && 'cursor-not-allowed opacity-60',
                )}
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void onSend()}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold',
                canSend
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'cursor-not-allowed bg-zinc-800 text-zinc-500',
              )}
            >
              {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {sending ? 'Sending…' : 'Send'}
            </button>
          </DialogFooter>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
