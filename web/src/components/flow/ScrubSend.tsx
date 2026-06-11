/**
 * Flow screen 1 — Scrub & Send. Ported from
 * `design_handoff_flow_redesign/reference/flow-app.jsx` (`ScrubScreen`), wired to
 * the REAL store/API rather than the prototype's local regex engine + seed data.
 *
 * Reused logic (do not reinvent):
 *   - debounced live-scrub trigger     → from components/Composer.tsx (200ms)
 *   - scrubbed-run splitting (token RE) → from components/PreviewPane.tsx
 *   - real/wire deanonymize view        → from components/ResponseStream.tsx + lib/deanon.ts
 *
 * Store surface this binds to (verified against store.ts):
 *   composerText / setComposerText, refreshScrub, scrubbed, tokens,
 *   hasCredentials, credentialSnippets, isStreaming, assistantStreaming,
 *   messages, streamError, send, abortSend, showRawTokens / setShowRawTokens,
 *   resetConversation, tokenUnion.
 *
 * Screening mode (Observe / Enforce / Disabled): the canonical `mode` lives in
 * PRIVACY_CONFIG.yaml and IS surfaced + persisted through /api/settings (GET
 * returns it; POST writes it via patchScreeningMode). It is mirrored into the
 * Zustand store (store.mode / store.setMode) so this screen and the Settings
 * radio group share ONE source of truth; store.setMode persists via
 * api.saveSettings({ mode }) and re-runs refreshScrub. The segmented control
 * here writes store.setMode. NOTE: credentials block the send in EVERY mode —
 * store.send() re-scrubs server-side and aborts on hasCredentials regardless of
 * mode — so the credential-block UX here is keyed on hasCredentials, not on
 * Enforce. Tokenization + the credential guard are always on.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from 'react';
import { useContextMenu } from '../../lib/useContextMenu';
import { Segmented } from '../ui/Segmented';
import { FileDropZone } from '../FileDropZone';
import {
  FileText,
  Shield,
  ShieldAlert,
  ArrowRight,
  AlertTriangle,
  Copy,
  Check,
  X,
  Send,
  Eye,
  ScanLine,
  Sparkles,
  Plus,
  Lock,
  CheckCircle2,
} from 'lucide-react';
import { useStore } from '../../store';
import { getCategoryInlineStyles, getCategoryHue } from '../../lib/colors';
import { categoryLabel } from '../../lib/categories';
import { deanonymize, type TokenLike } from '../../lib/deanon';
import type { Token } from '../../api';
import type { ScreenMode } from '../../store';
import { tokenizeForRender, mergeTokenSources, type Run } from '../../lib/tokens';

const DEBOUNCE_MS = 200; // matches Composer.tsx

/** A `.ps-pill` token chip. Category is carried by the token TEXT (WCAG 1.4.1);
 * color is redundant reinforcement only. */
function Pill({ run }: { run: Extract<Run, { type: 'token' }> }): JSX.Element {
  const cat = run.meta?.category ?? 'unknown';
  const hue = getCategoryHue(cat);
  const real = run.meta?.realValue;
  return (
    <span
      className="ps-pill"
      style={{ ['--cat' as string]: hue }}
      title={real ? `${categoryLabel(cat)}: ${real}` : `${categoryLabel(cat)} (unrecognized token)`}
    >
      {run.raw}
    </span>
  );
}

/** A footer category summary pill (with the dot variant). */
function CatPill({ cat }: { cat: string }): JSX.Element {
  const hue = getCategoryHue(cat);
  return (
    <span className="ps-pill" style={{ ['--cat' as string]: hue }}>
      <span className="ps-pilldot" aria-hidden="true" />
      {categoryLabel(cat)}
    </span>
  );
}

/** Inline red "blocked" credential chip — rendered in the scrubbed body when a
 * credential is present (the real value is never shown). */
function BlockedChip(): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px align-baseline text-[0.86em] font-semibold"
      style={{
        background: 'var(--danger-bg)',
        color: 'var(--danger)',
        borderColor: 'var(--danger-border)',
      }}
    >
      <AlertTriangle size={12} aria-hidden="true" /> blocked
    </span>
  );
}

function unionToList(map: Map<string, Token>): TokenLike[] {
  const out: TokenLike[] = [];
  for (const [, v] of map) out.push({ token: v.token, realValue: v.realValue });
  return out;
}

/** The deanonymized / wire reply view. Splits the (tokenized) assistant text into
 * runs; in WIRE view renders `{TOKEN}` pills, in REAL view renders each real value
 * underlined dotted in its category color with `title="sent as {TOKEN}"`. */
function ReplyView({
  text,
  tokens,
  showWire,
  streaming,
}: {
  text: string;
  tokens: Token[];
  showWire: boolean;
  streaming: boolean;
}): JSX.Element {
  const runs = useMemo(() => tokenizeForRender(text, tokens), [text, tokens]);
  return (
    <>
      {runs.map((r, i) => {
        if (r.type === 'text') return <Fragment key={i}>{r.text}</Fragment>;
        if (showWire) return <Pill key={i} run={r} />;
        const cat = r.meta?.category ?? 'unknown';
        const real = r.meta?.realValue ?? r.raw;
        return (
          <span
            key={i}
            title={`sent as ${r.raw}`}
            style={{
              borderBottom: `1.5px dotted ${getCategoryHue(cat)}`,
              paddingBottom: 1,
            }}
          >
            {real}
          </span>
        );
      })}
      {streaming && <span style={{ color: 'var(--acc)' }}>▍</span>}
    </>
  );
}

export function ScrubSend({ mode }: { mode: ScreenMode }): JSX.Element {
  const composerText = useStore((s) => s.composerText);
  const setComposerText = useStore((s) => s.setComposerText);
  const files = useStore((s) => s.files);
  const refreshScrub = useStore((s) => s.refreshScrub);
  const scrubbed = useStore((s) => s.scrubbed);
  const tokens = useStore((s) => s.tokens);
  const hasCredentials = useStore((s) => s.hasCredentials);
  const credentialSnippets = useStore((s) => s.credentialSnippets);
  const send = useStore((s) => s.send);
  const abortSend = useStore((s) => s.abortSend);
  const isStreaming = useStore((s) => s.isStreaming);
  const assistantStreaming = useStore((s) => s.assistantStreaming);
  const messages = useStore((s) => s.messages);
  const streamError = useStore((s) => s.streamError);
  const showRawTokens = useStore((s) => s.showRawTokens);
  const setShowRawTokens = useStore((s) => s.setShowRawTokens);
  const resetConversation = useStore((s) => s.resetConversation);
  const tokenUnion = useStore((s) => s.tokenUnion);
  const pushToast = useStore((s) => s.pushToast);

  // For right-click TokenizeMenu (handoff addendum feature 1 + 3 "New category").
  const openCtxMenu = useContextMenu((s) => s.openMenu);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Local phase machine: compose → streaming → done. Derived from store
  // streaming + whether a reply exists; editing input returns to compose.
  const lastAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'assistant') return messages[i]!.content_tokens;
    }
    return '';
  }, [messages]);

  const phase: 'compose' | 'streaming' | 'done' = isStreaming
    ? 'streaming'
    : lastAssistant || streamError
      ? 'done'
      : 'compose';

  // Editing the input while a reply is shown returns to compose (clears the
  // conversation so the right panel swaps back to the scrub view).
  const prevTextRef = useRef(composerText);
  useEffect(() => {
    if (prevTextRef.current !== composerText) {
      prevTextRef.current = composerText;
      if (!isStreaming && (lastAssistant || streamError)) {
        resetConversation();
      }
    }
  }, [composerText, isStreaming, lastAssistant, streamError, resetConversation]);

  // Credentials ALWAYS block the send — store.send() re-scrubs server-side and
  // aborts on hasCredentials regardless of mode (Observe/Enforce/Disabled). So
  // the blocked UX (red seam, "Cannot send", banner, blocked chips, footer
  // count, disabled Send) is keyed on hasCredentials in EVERY mode, not just
  // Enforce — the UI must match the always-protective store.
  const disabled = mode === 'disabled';
  const blocked = hasCredentials;
  // "Empty" must mirror store.buildPayload: a file contributes content only when
  // it has `scrubbed` text and no `error` (errored files are skipped). So the
  // payload is empty iff the composer is blank AND every attached file is either
  // errored or has no scrubbed content. This lets a files-only payload enable
  // Send + show the preview, while an errored-only attachment stays disabled.
  const empty =
    !composerText.trim() && files.every((f) => f.error || !f.scrubbed);

  // ── Live scrub (debounced, ported from Composer.tsx) ───────────────────────
  // Runs in EVERY mode (incl. Disabled) — send() always tokenizes server-side,
  // so the preview + credential detection must reflect that too. Skipped only
  // while streaming. The store's refreshScrub short-circuits on empty payload.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (isStreaming) return;
    timerRef.current = setTimeout(() => {
      void refreshScrub();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [composerText, refreshScrub, isStreaming]);

  const runs = useMemo(() => {
    // Always show the tokenized preview — even in Disabled mode the send path
    // tokenizes, so the preview must never imply raw PII goes on the wire.
    return tokenizeForRender(scrubbed, tokens);
  }, [scrubbed, tokens]);

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const t of tokens) {
      if (!seen.includes(t.category)) seen.push(t.category);
    }
    return seen;
  }, [tokens]);

  const credCount = credentialSnippets.length;
  const protectedCount = tokens.length;

  const replyTokens = useMemo(() => {
    // Merge via shared utility (current + cross-session union) so deanon resolves
    // tokens minted on prior turns. Single impl for #92.
    return mergeTokenSources(tokens, tokenUnion);
  }, [tokens, tokenUnion]);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const onCopy = useCallback(() => {
    if (!scrubbed) return;
    navigator.clipboard?.writeText(scrubbed).then(
      () => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 2000);
        pushToast('success', 'Scrubbed text copied');
      },
      (err) => pushToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, [scrubbed, pushToast]);

  const onSend = useCallback(() => {
    if (blocked || empty || isStreaming) return;
    void send();
  }, [blocked, empty, isStreaming, send]);

  const onNewMessage = useCallback(() => {
    resetConversation();
    setComposerText('');
  }, [resetConversation, setComposerText]);

  const replyDisplay = phase === 'streaming' ? assistantStreaming : lastAssistant;

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ padding: '8px 0 0' }}>
      {/* two-panel + seam row */}
      <div className="flex min-h-0 flex-1 items-stretch">
        {/* ── LEFT: input ─────────────────────────────────────────────────── */}
        <section className="ps-panel flex min-w-0 flex-1 flex-col">
          <div
            className="flex items-center justify-between gap-2 px-4 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="flex items-center gap-2">
              <FileText size={15} className="text-text-faint" aria-hidden="true" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
                Your text — stays on device
              </span>
            </span>
            {!empty && (
              <button
                type="button"
                onClick={() => setComposerText('')}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-text-dim hover:bg-surface-2 hover:text-text"
              >
                <X size={13} aria-hidden="true" /> Clear
              </button>
            )}
          </div>
          <textarea
            ref={taRef}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onContextMenu={(e) => {
              const ta = taRef.current;
              if (!ta) return;
              const sel = composerText.slice(ta.selectionStart, ta.selectionEnd).trim();
              if (!sel) return; // empty selection → let native menu
              e.preventDefault();
              openCtxMenu(e.clientX, e.clientY, sel);
            }}
            spellCheck={false}
            autoComplete="off"
            aria-label="Text to scrub"
            placeholder="Paste or type text containing sensitive data…"
            className="ps-mono min-h-0 flex-1"
            style={{
              padding: 16,
              fontSize: 12.5,
              lineHeight: 1.7,
              border: 0,
              background: 'transparent',
              color: 'var(--text-dim)',
              resize: 'none',
            }}
          />
          {/* Drag-and-drop / browse file scrubbing — restored after the Flow
              redesign dropped the old Composer's FileDropZone. Reads/writes the
              same store surface (files / addFiles / removeFile); the scrubbed
              file content is folded into buildPayload so the preview + Send pick
              it up. xlsx/csv drops route through the XlsxColumnReview modal
              (mounted in App.tsx). */}
          <div className="px-4 pb-3 pt-1">
            <FileDropZone />
          </div>
        </section>

        {/* ── SEAM ─────────────────────────────────────────────────────────── */}
        <div className="flex w-[56px] flex-none items-center justify-center" aria-hidden="true">
          <div
            className="grid h-[38px] w-[38px] place-items-center rounded-full"
            style={{
              background: blocked ? 'var(--danger)' : 'var(--acc)',
              boxShadow: '0 4px 14px var(--acc-tint)',
            }}
          >
            {blocked ? (
              <AlertTriangle size={20} color="#fff" strokeWidth={2} />
            ) : (
              <ArrowRight size={20} color="var(--acc-ink)" strokeWidth={2} />
            )}
          </div>
        </div>

        {/* ── RIGHT: scrubbed output / reply ───────────────────────────────── */}
        <section
          className="ps-panel flex min-w-0 flex-1 flex-col"
          style={{ borderColor: blocked ? 'var(--danger-border)' : 'var(--acc-line)' }}
        >
          {phase === 'compose' ? (
            <>
              <div
                className="flex items-center justify-between gap-2 px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="flex items-center gap-2">
                  {blocked ? (
                    <ShieldAlert size={15} color="var(--danger)" aria-hidden="true" />
                  ) : (
                    <Shield size={15} color="var(--acc)" aria-hidden="true" />
                  )}
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: blocked ? 'var(--danger)' : 'var(--acc)' }}
                  >
                    {blocked ? 'Cannot send' : 'Safe to send'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={onCopy}
                  disabled={!scrubbed}
                  aria-label="Copy scrubbed text"
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-text-dim enabled:hover:bg-surface-2 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              {blocked && (
                <div
                  className="flex items-center gap-2"
                  style={{
                    margin: 12,
                    marginBottom: 0,
                    padding: '9px 12px',
                    borderRadius: 9,
                    background: 'var(--danger-bg)',
                    border: '1px solid var(--danger-border)',
                  }}
                  role="alert"
                >
                  <ShieldAlert size={15} color="var(--danger)" aria-hidden="true" />
                  <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>
                    Credential detected — remove it to send. Credentials are never tokenized.
                  </span>
                </div>
              )}

              <div
                className="ps-mono min-h-0 flex-1 overflow-auto"
                style={{
                  padding: 16,
                  fontSize: 12.5,
                  lineHeight: 2,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text)',
                }}
              >
                {empty ? (
                  <span className="text-text-faint">Tokens will appear here as you type.</span>
                ) : (
                  <>
                    {runs.map((r, i) =>
                      r.type === 'text' ? (
                        <Fragment key={i}>{r.text}</Fragment>
                      ) : (
                        <Pill key={i} run={r} />
                      ),
                    )}
                    {/* Inline credential "blocked" chips appended so the user sees
                        each detected credential without exposing its real value. */}
                    {blocked &&
                      credentialSnippets.map((_, i) => (
                        <Fragment key={`cred-${i}`}>
                          {' '}
                          <BlockedChip />
                        </Fragment>
                      ))}
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div
                className="flex items-center justify-between gap-2 px-4 py-3"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span className="flex items-center gap-2">
                  <Sparkles size={15} color="var(--acc)" aria-hidden="true" />
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: 'var(--acc)' }}
                  >
                    {phase === 'streaming' ? 'Claude · replying…' : 'Claude'}
                  </span>
                </span>
                <Segmented<'real' | 'wire'>
                  label="Reply view"
                  value={showRawTokens ? 'wire' : 'real'}
                  onChange={(v) => setShowRawTokens(v === 'wire')}
                  options={[
                    { value: 'real', label: 'Real', icon: <Eye size={12} aria-hidden="true" /> },
                    { value: 'wire', label: 'Wire', icon: <ScanLine size={12} aria-hidden="true" /> },
                  ]}
                />
              </div>
              <div
                className="ps-mono min-h-0 flex-1 overflow-auto"
                style={{
                  padding: 16,
                  fontSize: 12.5,
                  lineHeight: 1.9,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text)',
                }}
              >
                <ReplyView
                  text={replyDisplay}
                  tokens={replyTokens}
                  showWire={showRawTokens}
                  streaming={phase === 'streaming'}
                />
                {streamError && (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-md p-2 text-xs"
                    style={{
                      border: '1px solid var(--danger-border)',
                      background: 'var(--danger-bg)',
                      color: 'var(--danger)',
                    }}
                    role="alert"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="font-mono">{streamError}</span>
                  </div>
                )}
              </div>
              <div
                className="flex items-center gap-2 px-4 py-2.5 text-[11px] text-text-faint"
                style={{ borderTop: '1px solid var(--border)' }}
              >
                <Lock size={12} aria-hidden="true" />
                {showRawTokens
                  ? 'Wire view — exact bytes sent to Claude — only tokens.'
                  : 'Real view — deanonymized for you. Claude only ever saw the tokens.'}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── FOOTER ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4" style={{ padding: '14px 2px 4px' }}>
        <div className="flex min-h-[30px] flex-wrap items-center gap-2.5">
          {protectedCount > 0 ? (
            <>
              <span className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold text-text">
                <CheckCircle2 size={15} color="var(--ok)" aria-hidden="true" />
                {protectedCount} item{protectedCount === 1 ? '' : 's'} protected
              </span>
              <span
                aria-hidden="true"
                className="self-center"
                style={{ width: 1, height: 16, background: 'var(--border-2)' }}
              />
              {categories.slice(0, 5).map((c) => (
                <CatPill key={c} cat={c} />
              ))}
              {credCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    background: 'var(--danger-bg)',
                    color: 'var(--danger)',
                    borderColor: 'var(--danger-border)',
                  }}
                >
                  <AlertTriangle size={11} aria-hidden="true" /> {credCount} credential
                  {credCount === 1 ? '' : 's'}
                </span>
              )}
            </>
          ) : (
            <span className="text-[12px] text-text-faint">
              {disabled
                ? 'Screening disabled — values are still tokenized before sending.'
                : 'No sensitive values detected yet.'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {phase === 'done' ? (
            <button
              type="button"
              onClick={onNewMessage}
              className="flex items-center gap-1.5 rounded-lg px-[18px] font-medium text-acc"
              style={{ height: 42, background: 'var(--acc-tint)' }}
            >
              <Plus size={15} aria-hidden="true" /> New message
            </button>
          ) : phase === 'streaming' ? (
            <button
              type="button"
              onClick={abortSend}
              aria-label="Stop streaming"
              className="flex items-center gap-1.5 rounded-lg border border-border px-[18px] font-medium text-text-dim hover:bg-surface-2 hover:text-text"
              style={{ height: 42 }}
            >
              <X size={15} aria-hidden="true" /> Stop
            </button>
          ) : (
            <>
              <span
                className="max-w-[150px] text-right text-[11.5px] leading-tight text-text-faint"
              >
                {blocked
                  ? 'Send disabled while a credential is present.'
                  : 'Tokens stay on this device.'}
              </span>
              <button
                type="button"
                disabled={blocked || empty}
                onClick={onSend}
                className="flex items-center gap-1.5 rounded-lg px-5 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                style={{ height: 42, background: 'var(--acc)', color: 'var(--acc-ink)' }}
                title={
                  blocked
                    ? 'Send disabled — credential present'
                    : empty
                      ? 'Nothing to send'
                      : 'Send scrubbed text to Claude'
                }
              >
                <Send size={16} aria-hidden="true" /> Send to Claude
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Header-right controls for the Scrub route: a claude-ready status chip + the
 * Observe/Enforce screening-mode segmented control. Exported so App composes it
 * into the route's Shell `headerRight`. */
export function ScrubHeaderRight({
  mode,
  setMode,
}: {
  mode: ScreenMode;
  setMode: (m: ScreenMode) => void;
}): JSX.Element {
  const found = useStore((s) => s.settings?.claude_code.found);
  const version = useStore((s) => s.settings?.claude_code.version);
  return (
    <>
      <span
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[12px] font-medium"
        style={{ color: found ? 'var(--ok)' : 'var(--danger)' }}
        title={found ? `Claude Code ${version ?? ''} ready` : 'Claude Code not found'}
      >
        {found ? (
          <Check size={14} color="var(--ok)" aria-hidden="true" />
        ) : (
          <AlertTriangle size={14} color="var(--danger)" aria-hidden="true" />
        )}
        {found ? 'claude ready' : 'claude missing'}
      </span>
      <Segmented<ScreenMode>
        label="Screening mode"
        value={mode === 'disabled' ? 'observe' : mode}
        onChange={setMode}
        options={[
          { value: 'observe', label: 'Observe' },
          { value: 'enforce', label: 'Enforce' },
        ]}
      />
    </>
  );
}

export type { ScreenMode };
