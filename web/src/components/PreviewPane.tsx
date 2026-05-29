import { useMemo, Fragment } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useStore } from '../store';
import { getCategoryStyle } from '../lib/colors';
import type { Token } from '../api';
import { cn } from '../lib/cn';

/**
 * Tokenize the scrubbed text into runs of (plain | token) for rendering.
 *
 * Tokens look like `{NAME}` or `{NAME_1}`. We DO NOT use a global regex from
 * the token list — that would force a re-scan per token and miss tokens whose
 * names overlap. Instead we scan once for any `{...}` matching the
 * upper-snake-case shape and look them up in a Map. Unknown bracketed words
 * fall back to a neutral "unknown" pill — they shouldn't happen in practice
 * but we never just drop them.
 */
type Run =
  | { type: 'text'; text: string }
  | { type: 'token'; raw: string; meta: Token | null };

const TOKEN_RE = /\{[A-Z][A-Z0-9_]*\}/g;

function tokenizeForRender(scrubbed: string, tokens: Token[]): Run[] {
  if (!scrubbed) return [];
  const byToken = new Map<string, Token>();
  for (const t of tokens) byToken.set(t.token, t);

  const out: Run[] = [];
  let lastIdx = 0;
  for (const m of scrubbed.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > lastIdx) out.push({ type: 'text', text: scrubbed.slice(lastIdx, i) });
    const raw = m[0];
    out.push({ type: 'token', raw, meta: byToken.get(raw) ?? null });
    lastIdx = i + raw.length;
  }
  if (lastIdx < scrubbed.length) out.push({ type: 'text', text: scrubbed.slice(lastIdx) });
  return out;
}

function TokenPill({ run }: { run: Extract<Run, { type: 'token' }> }) {
  const cat = run.meta?.category ?? 'unknown';
  const style = getCategoryStyle(cat);
  const real = run.meta?.realValue;
  // Title attribute gives a native tooltip with the real value. We intentionally
  // keep this simple — no Radix popover here because token previews need to be
  // dense and fast.
  return (
    <span
      title={real ? `${cat}: ${real}` : `${cat} (unrecognized token)`}
      className={cn(
        'token-pill border',
        style.bg,
        style.border,
        style.text,
        run.meta ? '' : 'opacity-70',
      )}
    >
      {run.raw}
    </span>
  );
}

export function PreviewPane(): JSX.Element {
  const scrubbed = useStore((s) => s.scrubbed);
  const tokens = useStore((s) => s.tokens);
  const composerText = useStore((s) => s.composerText);
  const files = useStore((s) => s.files);
  const hasCredentials = useStore((s) => s.hasCredentials);
  const credentialSnippets = useStore((s) => s.credentialSnippets);
  const scrubError = useStore((s) => s.scrubError);

  const runs = useMemo(() => tokenizeForRender(scrubbed, tokens), [scrubbed, tokens]);
  const isIdle = !composerText.trim() && files.length === 0;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Scrubbed preview
        </h2>
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {tokens.length > 0 ? `${tokens.length} token${tokens.length === 1 ? '' : 's'}` : '—'}
        </span>
      </header>

      {hasCredentials && (
        <div className="rounded-md border border-red-700 bg-red-950/60 p-3 text-sm">
          <div className="flex items-center gap-2 font-semibold text-red-200">
            <ShieldAlert className="h-4 w-4" /> CREDENTIAL DETECTED — Send disabled until
            removed.
          </div>
          {credentialSnippets.length > 0 && (
            <ul className="mt-2 list-inside list-disc font-mono text-xs text-red-300">
              {credentialSnippets.map((s, i) => (
                <li key={i} className="truncate">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {scrubError && (
        <div className="rounded-md border border-amber-700 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          scrub error: {scrubError}
        </div>
      )}

      <div
        className={cn(
          'flex-1 min-h-0 overflow-auto rounded-md border bg-zinc-900/40 p-3 font-mono text-sm leading-relaxed',
          hasCredentials ? 'border-red-900/60' : 'border-zinc-800',
        )}
      >
        {isIdle ? (
          <p className="text-zinc-600">Type or paste text to begin.</p>
        ) : runs.length === 0 ? (
          <p className="text-zinc-600">scrubbing…</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-zinc-200">
            {runs.map((r, i) =>
              r.type === 'text' ? (
                <Fragment key={i}>{r.text}</Fragment>
              ) : (
                <TokenPill key={i} run={r} />
              ),
            )}
          </p>
        )}
      </div>
    </section>
  );
}
