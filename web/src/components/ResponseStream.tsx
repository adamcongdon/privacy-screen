import { useEffect, useMemo, useRef } from 'react';
import { Eye, EyeOff, Trash2, AlertCircle } from 'lucide-react';
import { useStore } from '../store';
import { deanonymize, type TokenLike } from '../lib/deanon';
import { cn } from '../lib/cn';

function unionToList(map: Map<string, { token: string; realValue: string }>): TokenLike[] {
  const out: TokenLike[] = [];
  for (const [, v] of map) out.push({ token: v.token, realValue: v.realValue });
  return out;
}

export function ResponseStream(): JSX.Element {
  const messages = useStore((s) => s.messages);
  const assistantStreaming = useStore((s) => s.assistantStreaming);
  const isStreaming = useStore((s) => s.isStreaming);
  const streamError = useStore((s) => s.streamError);
  const showRawTokens = useStore((s) => s.showRawTokens);
  const setShowRawTokens = useStore((s) => s.setShowRawTokens);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const resetConversation = useStore((s) => s.resetConversation);

  const lookup = useMemo(() => unionToList(tokenUnion), [tokenUnion]);

  // Auto-scroll to bottom while streaming so the user always sees the freshest delta.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [assistantStreaming, messages]);

  const isEmpty = messages.length === 0 && !assistantStreaming && !streamError;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Response
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px] font-bold',
              showRawTokens
                ? 'border-emerald-700 bg-emerald-900/40 text-emerald-300'
                : 'border-amber-700 bg-amber-900/40 text-amber-200',
            )}
            title={
              showRawTokens
                ? 'Viewing the exact bytes sent over the wire to Anthropic'
                : 'Viewing tokens replaced with real values for readability — wire payload was tokenized'
            }
          >
            {showRawTokens ? 'WIRE PAYLOAD' : 'DEANONYMIZED VIEW'}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowRawTokens(!showRawTokens)}
            className={cn(
              'flex items-center gap-1 rounded border px-2 py-1 text-[11px] uppercase tracking-wider',
              showRawTokens
                ? 'border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800'
                : 'border-amber-700 bg-amber-900/30 text-amber-200',
            )}
            title={
              showRawTokens
                ? 'Showing wire payload — click to deanonymize for readability'
                : 'Showing deanonymized (real values shown) — click to view exact wire payload'
            }
          >
            {showRawTokens ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {showRawTokens ? 'show real values' : 'show wire'}
          </button>
          <button
            type="button"
            onClick={() => resetConversation()}
            disabled={isStreaming || (messages.length === 0 && !streamError)}
            className={cn(
              'flex items-center gap-1 rounded border px-2 py-1 text-[11px] uppercase tracking-wider',
              isStreaming || (messages.length === 0 && !streamError)
                ? 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
                : 'border-zinc-700 bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800 hover:text-red-300',
            )}
            title="clear conversation"
          >
            <Trash2 className="h-3 w-3" /> clear
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
      >
        {isEmpty ? (
          <p className="text-sm text-zinc-600">Response will appear here after Send.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => (
              <MessageBlock
                key={i}
                role={m.role}
                tokenized={m.content_tokens}
                tokens={lookup}
                showRaw={showRawTokens}
              />
            ))}

            {isStreaming && (
              <MessageBlock
                role="assistant"
                tokenized={assistantStreaming}
                tokens={lookup}
                showRaw={showRawTokens}
                streaming
              />
            )}

            {streamError && (
              <div className="flex items-start gap-2 rounded-md border border-red-800 bg-red-950/30 p-2 text-xs text-red-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{streamError}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function MessageBlock({
  role,
  tokenized,
  tokens,
  showRaw,
  streaming = false,
}: {
  role: 'user' | 'assistant';
  tokenized: string;
  tokens: TokenLike[];
  showRaw: boolean;
  streaming?: boolean;
}): JSX.Element {
  const display = showRaw ? tokenized : deanonymize(tokenized, tokens);
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-wider',
          role === 'user' ? 'text-indigo-400' : 'text-emerald-400',
        )}
      >
        {role}
        {streaming && <span className="ml-1 animate-pulse">▍</span>}
      </span>
      <pre
        className={cn(
          'whitespace-pre-wrap break-words rounded border p-2 font-mono text-sm leading-relaxed',
          role === 'user'
            ? 'border-indigo-900/40 bg-indigo-950/20 text-indigo-100'
            : 'border-emerald-900/40 bg-emerald-950/20 text-emerald-100',
        )}
      >
        {display || (streaming ? '…' : ' ')}
      </pre>
    </div>
  );
}
