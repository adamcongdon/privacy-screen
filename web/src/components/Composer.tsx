import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Send, Loader2, Square } from 'lucide-react';
import { useStore } from '../store';
import { FileDropZone } from './FileDropZone';
import { cn } from '../lib/cn';

const DEBOUNCE_MS = 200;

export function Composer(): JSX.Element {
  const composerText = useStore((s) => s.composerText);
  const setComposerText = useStore((s) => s.setComposerText);
  const refreshScrub = useStore((s) => s.refreshScrub);
  const send = useStore((s) => s.send);
  const abortSend = useStore((s) => s.abortSend);
  const isStreaming = useStore((s) => s.isStreaming);
  const isScrubbing = useStore((s) => s.isScrubbing);
  const hasCredentials = useStore((s) => s.hasCredentials);
  const files = useStore((s) => s.files);

  // Debounced auto-scrub. We watch composerText only — files trigger their own
  // refreshScrub on add/remove from the store.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void refreshScrub();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [composerText, refreshScrub]);

  const blockedByCredential = hasCredentials;
  const isEmpty = !composerText.trim() && files.every((f) => !f.scrubbed && !f.error);
  const sendDisabled = blockedByCredential || isStreaming || isEmpty;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter sends.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!sendDisabled) void send();
      }
    },
    [send, sendDisabled],
  );

  const statusText = useMemo(() => {
    if (isStreaming) return 'streaming…';
    if (isScrubbing) return 'scrubbing…';
    if (blockedByCredential) return 'credential detected — send disabled';
    if (isEmpty) return 'idle';
    return 'ready';
  }, [isStreaming, isScrubbing, blockedByCredential, isEmpty]);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Compose
        </h2>
        <span
          className={cn(
            'flex items-center gap-1.5 text-[11px] uppercase tracking-wider',
            blockedByCredential
              ? 'text-red-400'
              : isStreaming || isScrubbing
                ? 'text-amber-400'
                : 'text-zinc-500',
          )}
        >
          {(isStreaming || isScrubbing) && <Loader2 className="h-3 w-3 animate-spin" />}
          {statusText}
        </span>
      </header>

      <textarea
        value={composerText}
        onChange={(e) => setComposerText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type or paste text. PII is detected and replaced with tokens before anything leaves this machine."
        className={cn(
          'flex-1 min-h-[180px] resize-none rounded-md border bg-zinc-900/60 p-3 font-mono text-sm leading-relaxed',
          'placeholder:text-zinc-600 focus:outline-none focus:ring-2',
          blockedByCredential
            ? 'border-red-900/60 focus:ring-red-500/30'
            : 'border-zinc-800 focus:ring-indigo-500/40',
        )}
        spellCheck={false}
        autoComplete="off"
      />

      <FileDropZone />

      <div className="flex items-center gap-2">
        {isStreaming ? (
          <button
            type="button"
            onClick={abortSend}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-amber-700 bg-amber-900/30 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-900/50"
          >
            <Square className="h-4 w-4" /> Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={sendDisabled}
            onClick={() => void send()}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors',
              sendDisabled
                ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                : 'bg-indigo-600 text-white hover:bg-indigo-500',
            )}
            title={
              blockedByCredential
                ? 'Cannot send — credential detected'
                : isEmpty
                  ? 'Nothing to send'
                  : 'Send (Cmd/Ctrl+Enter)'
            }
          >
            <Send className="h-4 w-4" /> Send to Anthropic
          </button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-zinc-500">
        Only tokens leave this machine. Real values are reconstructed locally for display.
      </p>
    </section>
  );
}
