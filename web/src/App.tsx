import { useEffect, useRef } from 'react';
import { Shield, CircleDot, AlertCircle, CheckCircle2, MessageSquareWarning } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Composer } from './components/Composer';
import { PreviewPane } from './components/PreviewPane';
import { TokenMapDrawer } from './components/TokenMapDrawer';
import { ReviewQueue } from './components/ReviewQueue';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ContextMenu } from './components/ContextMenu';
import { CustomCategoryDialog } from './components/CustomCategoryDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { XlsxColumnReview } from './components/XlsxColumnReview';
import UpdateAvailableBanner from './components/UpdateAvailableBanner';
import { useContextMenuShortcuts } from './lib/useContextMenu';
import { useStore, type ToastEntry } from './store';
import { getPayloadKind } from './lib/payloadKind';
import { cn } from './lib/cn';
import { useFeedbackJob } from './hooks/useFeedbackJob';
import { FeedbackJobPill } from './components/FeedbackJobPill';

/**
 * Sync-scroll plumbing — refs and handlers shared by the Composer textarea
 * and the Scrubbed Preview pane. Hoisted to App because both panes live in
 * separate sub-trees but should scroll together.
 */
function useAppSyncScroll() {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const isSyncing = useRef(false);

  const mirror = (dst: HTMLElement | null, srcTop: number) => {
    if (!dst || dst.scrollTop === srcTop) return;
    isSyncing.current = true;
    dst.scrollTop = srcTop;
    requestAnimationFrame(() => { isSyncing.current = false; });
  };
  const onComposerScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (isSyncing.current) return;
    mirror(previewRef.current, e.currentTarget.scrollTop);
  };
  const onPreviewScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isSyncing.current) return;
    mirror(composerRef.current, e.currentTarget.scrollTop);
  };

  return { composerRef, previewRef, onComposerScroll, onPreviewScroll };
}

export default function App(): JSX.Element {
  const refreshHealth = useStore((s) => s.refreshHealth);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshVocab = useStore((s) => s.refreshVocab);
  const refreshReview = useStore((s) => s.refreshReview);
  const refreshVersion = useStore((s) => s.refreshVersion);
  const refreshUpdateStatus = useStore((s) => s.refreshUpdateStatus);
  const health = useStore((s) => s.health);
  const settings = useStore((s) => s.settings);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const composerText = useStore((s) => s.composerText);
  const files = useStore((s) => s.files);
  const tokenMapOpen = useStore((s) => s.tokenMapOpen);
  const setTokenMapOpen = useStore((s) => s.setTokenMapOpen);
  const feedbackOpen = useStore((s) => s.feedbackOpen);
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen);
  const autoSetPreviewMode = useStore((s) => s.autoSetPreviewMode);
  const resetPreviewModeOverride = useStore((s) => s.resetPreviewModeOverride);
  const updateChannel = useStore((s) => s.settings?.update_channel);
  const startVersionPoller = useStore((s) => s.startVersionPoller);
  const stopVersionPoller = useStore((s) => s.stopVersionPoller);

  // Enable feedback job polling hook (no return value).
  useFeedbackJob();

  // Global keyboard shortcuts for the mint-selection workflow.
  useContextMenuShortcuts();

  // Sync-scroll plumbing for Compose ↔ Scrubbed Preview.
  const sync = useAppSyncScroll();

  // Boot — pull everything once.
  useEffect(() => {
    void refreshHealth();
    void refreshSettings();
    void refreshVocab();
    void refreshReview();
    void refreshVersion();
    void refreshUpdateStatus();
  }, [refreshHealth, refreshSettings, refreshVocab, refreshReview, refreshVersion, refreshUpdateStatus]);

  // Periodic version poller — lifecycle keyed on `settings.update_channel`.
  // First pass after mount has `updateChannel === undefined` (settings still
  // loading) and is a no-op; the second pass — once settings hydrate — picks
  // the right state. Channel changes (user flips in the drawer) tear down the
  // existing interval and reinstall a fresh one against the new channel.
  // Off-state cleanup stops the poller; the store's `startVersionPoller` is
  // also defensive and refuses to start when channel !== 'stable'|'beta'.
  useEffect(() => {
    if (updateChannel === 'stable' || updateChannel === 'beta') {
      startVersionPoller();
    }
    return () => stopVersionPoller();
  }, [updateChannel, startVersionPoller, stopVersionPoller]);

  // Auto-default preview mode from payload kind. Honors a user override until
  // the app returns to idle (empty composer + no files).
  useEffect(() => {
    const isIdle = composerText.trim().length === 0 && files.length === 0;
    if (isIdle) {
      resetPreviewModeOverride();
      autoSetPreviewMode('source');
      return;
    }
    const kind = getPayloadKind({ composerText, files });
    autoSetPreviewMode(kind === 'html-dominant' ? 'rendered' : 'source');
  }, [composerText, files, autoSetPreviewMode, resetPreviewModeOverride]);

  // ⌘K / Ctrl+K — toggle the Token Map drawer when no text field is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      e.preventDefault();
      setTokenMapOpen(!tokenMapOpen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tokenMapOpen, setTokenMapOpen]);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-indigo-400" />
          <h1 className="font-mono text-sm font-semibold tracking-tight">privacy-screen</h1>
          {health && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-500">
              v{health.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <KeyStatus />
          <HealthDot />
          <TokenMapDrawer />
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title="Send feedback — files a GitHub issue"
            aria-label="Send feedback"
          >
            <MessageSquareWarning className="h-3.5 w-3.5" /> send feedback
          </button>
          <SettingsDrawer />
        </div>
      </header>

      {/* Global update strip — slim, sits between header and main. Self-hides
          when no update is available or the current version has been dismissed. */}
      <UpdateAvailableBanner />

      {/* Two-column layout — horizontally resizable. */}
      <main className="flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="ps-columns-v3">
          <Panel defaultSize={45} minSize={30}>
            <div className="flex h-full min-h-0 flex-col">
              <Composer
                textareaRef={sync.composerRef}
                onScroll={sync.onComposerScroll}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-col-resize transition-colors" />

          <Panel defaultSize={55} minSize={40}>
            <div className="flex h-full min-h-0 flex-col">
              <PanelGroup direction="vertical" autoSaveId="ps-right-column-v3">
                <Panel defaultSize={65} minSize={30}>
                  <PreviewPane
                    scrollRef={sync.previewRef}
                    onScroll={sync.onPreviewScroll}
                  />
                </Panel>
                <PanelResizeHandle className="h-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-row-resize transition-colors" />
                <Panel defaultSize={35} minSize={18}>
                  <ReviewQueue />
                </Panel>
              </PanelGroup>
            </div>
          </Panel>
        </PanelGroup>
      </main>

      {/* Global overlays */}
      <ContextMenu />
      <CustomCategoryDialog />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      <XlsxColumnReview />

      {/* Feedback job pill (fixed top-right) */}
      <FeedbackJobPill />

      {/* Toast stack — z-[60] keeps toasts visible above modal dialogs (Radix Dialog content sits at z-50). */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>

      {/* Status note when claude code is missing */}
      {settings && !settings.claude_code.found && (
        <div className="fixed bottom-4 left-4 max-w-sm rounded-md border border-rose-800 bg-rose-950/70 px-3 py-2 text-xs text-rose-200 shadow-lg backdrop-blur">
          Claude Code not found on PATH. Install from
          <code className="mx-1 rounded bg-rose-900/50 px-1 font-mono">docs.claude.com/en/docs/claude-code</code>,
          run <code className="mx-1 rounded bg-rose-900/50 px-1 font-mono">claude login</code>, then restart.
        </div>
      )}
    </div>
  );
}

function KeyStatus(): JSX.Element {
  const settings = useStore((s) => s.settings);
  if (!settings) {
    return (
      <span className="text-[11px] uppercase tracking-wider text-zinc-500">loading…</span>
    );
  }
  const cc = settings.claude_code;
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px] uppercase tracking-wider',
        cc.found ? 'text-emerald-400' : 'text-rose-400',
      )}
      title={cc.found ? `Claude Code ${cc.version} on PATH` : 'Claude Code not found'}
    >
      {cc.found ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      claude: {cc.found ? cc.version ?? 'ok' : 'missing'}
    </span>
  );
}

function HealthDot(): JSX.Element {
  const health = useStore((s) => s.health);
  const ok = health?.ok === true;
  return (
    <span
      className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-500"
      title={ok ? 'server reachable' : 'server unreachable'}
    >
      <CircleDot className={cn('h-3 w-3', ok ? 'text-emerald-400' : 'text-red-400')} />
      {ok ? 'online' : 'offline'}
    </span>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: () => void;
}): JSX.Element {
  const tone =
    toast.kind === 'error'
      ? 'border-red-700 bg-red-950/90 text-red-100'
      : toast.kind === 'success'
        ? 'border-emerald-800 bg-emerald-950/90 text-emerald-100'
        : 'border-zinc-700 bg-zinc-900/90 text-zinc-100';
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-xs shadow-lg backdrop-blur animate-fade-in',
        tone,
      )}
      role="status"
    >
      <span className="flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded text-current/70 hover:text-current"
        aria-label="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
