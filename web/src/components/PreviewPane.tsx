import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type RefObject } from 'react';
import { ShieldAlert, Code2, Eye, Copy, Check } from 'lucide-react';
import { useStore } from '../store';
import { getCategoryStyle } from '../lib/colors';
import { useContextMenu } from '../lib/useContextMenu';
import { getPayloadKind, pickPrimaryHtmlFile } from '../lib/payloadKind';
import { HtmlRenderedView } from './HtmlRenderedView';
import type { Token } from '../api';
import { cn } from '../lib/cn';

type PreviewPaneProps = {
  /** Optional shared ref for the scrolling container (sync-scroll). */
  scrollRef?: RefObject<HTMLDivElement>;
  /** Optional scroll handler — owner manages sync. */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
};

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

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: 'source' | 'rendered';
  onChange: (m: 'source' | 'rendered') => void;
  disabled: boolean;
}): JSX.Element {
  const btn = (which: 'source' | 'rendered', label: string, Icon: typeof Code2) => {
    const isActive = mode === which;
    const isDisabled = disabled && which === 'rendered';
    return (
      <button
        type="button"
        role="radio"
        aria-checked={isActive}
        aria-disabled={isDisabled}
        disabled={isDisabled}
        onClick={() => !isDisabled && onChange(which)}
        title={isDisabled ? 'No HTML to render' : `${label} view`}
        className={cn(
          'flex items-center gap-1 rounded-sm px-2 py-0.5 uppercase tracking-wider transition-colors',
          isActive
            ? 'bg-zinc-800 text-zinc-100 shadow-inner'
            : 'text-zinc-500 hover:text-zinc-300',
          isDisabled && 'cursor-not-allowed opacity-50 hover:text-zinc-500',
        )}
      >
        <Icon className="h-3 w-3" />
        {label}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="Preview mode"
      className="inline-flex rounded-md border border-zinc-800 bg-zinc-900/60 p-0.5 text-[11px] font-medium"
    >
      {btn('source', 'source', Code2)}
      {btn('rendered', 'rendered', Eye)}
    </div>
  );
}

function CopyButton({ scrubbed }: { scrubbed: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const disabled = scrubbed.length === 0;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(() => {
    if (disabled) return;
    navigator.clipboard.writeText(scrubbed).then(
      () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      },
      (err) => {
        pushToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }, [scrubbed, pushToast]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      aria-label={copied ? 'Copied to clipboard' : 'Copy scrubbed text to clipboard'}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
        disabled
          ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
          : copied
            ? 'bg-emerald-700 text-white'
            : 'bg-indigo-600 text-white hover:bg-indigo-500',
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied!' : 'Copy Scrubbed Text'}
    </button>
  );
}

export function PreviewPane({ scrollRef, onScroll }: PreviewPaneProps = {}): JSX.Element {
  const scrubbed = useStore((s) => s.scrubbed);
  const tokens = useStore((s) => s.tokens);
  const composerText = useStore((s) => s.composerText);
  const files = useStore((s) => s.files);
  const hasCredentials = useStore((s) => s.hasCredentials);
  const credentialSnippets = useStore((s) => s.credentialSnippets);
  const scrubError = useStore((s) => s.scrubError);
  const previewMode = useStore((s) => s.previewMode);
  const setPreviewMode = useStore((s) => s.setPreviewMode);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const openMenu = useContextMenu((s) => s.openMenu);

  const runs = useMemo(() => tokenizeForRender(scrubbed, tokens), [scrubbed, tokens]);
  const isIdle = !composerText.trim() && files.length === 0;
  const payloadKind = useMemo(
    () => getPayloadKind({ composerText, files }),
    [composerText, files],
  );
  const primaryHtmlFile = useMemo(() => pickPrimaryHtmlFile(files), [files]);
  const toggleDisabled = payloadKind === 'text' || !primaryHtmlFile;
  const effectiveMode: 'source' | 'rendered' = toggleDisabled ? 'source' : previewMode;
  const otherCount = files.filter((f) => !f.error && f !== primaryHtmlFile).length;

  // Combine current-session tokens with the cross-session union so the iframe
  // can resolve realValues for tokens that were minted on prior turns.
  const renderedTokens: Token[] = useMemo(() => {
    const seen = new Set<string>();
    const merged: Token[] = [];
    for (const t of tokens) {
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      merged.push(t);
    }
    for (const [, t] of tokenUnion) {
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      merged.push(t);
    }
    return merged;
  }, [tokens, tokenUnion]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const sel = window.getSelection()?.toString().trim() ?? '';
      if (sel.length < 2) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, sel);
    },
    [openMenu],
  );

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Scrubbed Output
        </h2>
        <div className="flex items-center gap-3">
          <ModeToggle
            mode={effectiveMode}
            onChange={setPreviewMode}
            disabled={toggleDisabled}
          />
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {tokens.length > 0 ? `${tokens.length} token${tokens.length === 1 ? '' : 's'}` : '—'}
          </span>
          <CopyButton scrubbed={scrubbed} />
        </div>
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

      {effectiveMode === 'rendered' && primaryHtmlFile && primaryHtmlFile.scrubbed ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          {payloadKind === 'mixed' && (
            <p className="text-[10px] text-zinc-500">
              Rendering <span className="font-mono text-zinc-300">{primaryHtmlFile.name}</span>
              {otherCount > 0 && ` · ${otherCount} other file${otherCount === 1 ? '' : 's'} in source`}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <HtmlRenderedView
              html={primaryHtmlFile.scrubbed}
              tokens={renderedTokens}
            />
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          className={cn(
            'flex-1 min-h-0 overflow-auto rounded-md border bg-zinc-900/40 p-3 font-mono text-sm leading-relaxed',
            hasCredentials ? 'border-red-900/60' : 'border-zinc-800',
          )}
        >
          {isIdle ? (
            <p className="text-zinc-600">Type, paste, or drop a file to begin.</p>
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
      )}
    </section>
  );
}
