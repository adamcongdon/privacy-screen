import { useEffect, useState } from 'react';
import {
  CircleDot,
  AlertCircle,
  CheckCircle2,
  MessageSquareWarning,
} from 'lucide-react';
import { Rail } from './components/flow/Rail';
import { Shell } from './components/flow/Shell';
import { ScrubSend, ScrubHeaderRight, type ScreenMode } from './components/flow/ScrubSend';
import { ReviewPage, ReviewHeaderRight } from './components/flow/ReviewPage';
import { ContextMenu } from './components/ContextMenu';
import { CustomCategoryDialog } from './components/CustomCategoryDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { XlsxColumnReview } from './components/XlsxColumnReview';
import UpdateAvailableBanner from './components/UpdateAvailableBanner';
import { useContextMenuShortcuts } from './lib/useContextMenu';
import { useStore, applyTheme, type ToastEntry, type Route } from './store';
import { getPayloadKind } from './lib/payloadKind';
import { cn } from './lib/cn';
import { useFeedbackJob } from './hooks/useFeedbackJob';
import { FeedbackJobPill } from './components/FeedbackJobPill';

export default function App(): JSX.Element {
  const refreshHealth = useStore((s) => s.refreshHealth);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshVocab = useStore((s) => s.refreshVocab);
  const refreshReview = useStore((s) => s.refreshReview);
  const refreshVersion = useStore((s) => s.refreshVersion);
  const refreshUpdateStatus = useStore((s) => s.refreshUpdateStatus);
  const settings = useStore((s) => s.settings);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const composerText = useStore((s) => s.composerText);
  const files = useStore((s) => s.files);
  const route = useStore((s) => s.route);
  const setRoute = useStore((s) => s.setRoute);
  const feedbackOpen = useStore((s) => s.feedbackOpen);
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen);
  const autoSetPreviewMode = useStore((s) => s.autoSetPreviewMode);
  const resetPreviewModeOverride = useStore((s) => s.resetPreviewModeOverride);
  const updateChannel = useStore((s) => s.settings?.update_channel);
  const startVersionPoller = useStore((s) => s.startVersionPoller);
  const stopVersionPoller = useStore((s) => s.stopVersionPoller);

  // Screening mode for the Scrub screen. Session-local: the web settings API does
  // not expose a screening mode (see ScrubSend.tsx header). Held here so it
  // survives route changes; Enforce is the recommended default. When the settings
  // API later surfaces a real mode, lift this into the store.
  const [mode, setMode] = useState<ScreenMode>('enforce');

  // Enable feedback job polling hook (no return value).
  useFeedbackJob();

  // Global keyboard shortcuts for the mint-selection workflow.
  useContextMenuShortcuts();

  // Apply the persisted/system theme to the document root once on mount so the
  // `theme-*` class matches the store's hydrated `theme` value.
  useEffect(() => {
    applyTheme();
  }, []);

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

  // ⌘K / Ctrl+K — jump to the Vocabulary route when no text field is focused.
  // (Was the Token Map drawer toggle pre-Flow; the drawer is now a route.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      e.preventDefault();
      setRoute('vocab');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setRoute]);

  return (
    <div className="flex h-screen min-h-0 bg-bg text-text">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Global update strip — slim, sits above the routed screen. Self-hides
            when no update is available or the current version was dismissed. */}
        <UpdateAvailableBanner />
        <RoutedScreen route={route} mode={mode} setMode={setMode} />
      </div>

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
        <div className="fixed bottom-4 left-4 max-w-sm rounded-md border border-danger bg-surface px-3 py-2 text-xs text-danger shadow-lg backdrop-blur">
          Claude Code not found on PATH. Install from
          <code className="mx-1 rounded bg-surface-2 px-1 font-mono">docs.claude.com/en/docs/claude-code</code>,
          run <code className="mx-1 rounded bg-surface-2 px-1 font-mono">claude login</code>, then restart.
        </div>
      )}
    </div>
  );
}

/**
 * Shared header-right cluster — Claude status, server health, and send-feedback.
 * Still used by the routes whose real screens land in Engineer-C2 (Vocabulary,
 * Settings). The Scrub and Review routes now supply their own per-screen header
 * controls instead.
 */
function GlobalHeaderControls(): JSX.Element {
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen);
  return (
    <>
      <KeyStatus />
      <HealthDot />
      <button
        type="button"
        onClick={() => setFeedbackOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-dim hover:bg-surface-3 hover:text-text"
        title="Send feedback — files a GitHub issue"
        aria-label="Send feedback"
      >
        <MessageSquareWarning className="h-3.5 w-3.5" /> send feedback
      </button>
    </>
  );
}

/**
 * Screen router. Scrub & Review render their real bodies (Engineer-C1) with
 * per-screen controls moved into the Shell `headerRight`. Vocabulary & Settings
 * keep placeholder bodies + the shared global controls until Engineer-C2.
 */
function RoutedScreen({
  route,
  mode,
  setMode,
}: {
  route: Route;
  mode: ScreenMode;
  setMode: (m: ScreenMode) => void;
}): JSX.Element {
  switch (route) {
    case 'review':
      return (
        <Shell
          title="Review queue"
          subtitle="Confirm, allow, or ignore spans the detectors weren't sure about."
          headerRight={<ReviewHeaderRight />}
          trust
        >
          <ReviewPage />
        </Shell>
      );
    case 'vocab':
      return (
        <Shell
          title="Vocabulary"
          subtitle="Every value you've tokenized — stored locally in SQLite, never synced."
          headerRight={<GlobalHeaderControls />}
        >
          <ScreenPlaceholder name="Vocabulary" />
        </Shell>
      );
    case 'settings':
      return (
        <Shell
          title="Settings"
          subtitle="Modes, LLM judge, updates, customer names, and data."
          headerRight={<GlobalHeaderControls />}
        >
          <ScreenPlaceholder name="Settings" />
        </Shell>
      );
    case 'scrub':
    default:
      return (
        <Shell
          title="Scrub & Send"
          subtitle="Paste sensitive text — it's tokenized before anything is sent."
          headerRight={<ScrubHeaderRight mode={mode} setMode={setMode} />}
          trust
        >
          <ScrubSend mode={mode} />
        </Shell>
      );
  }
}

/** Temporary body for routes whose screens land in Engineer-C2. */
function ScreenPlaceholder({ name }: { name: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="ps-panel max-w-md p-6 text-center">
        <p className="text-sm font-semibold text-text">{name}</p>
        <p className="mt-1.5 text-xs text-text-dim">Coming in Engineer-C2.</p>
      </div>
    </div>
  );
}

function KeyStatus(): JSX.Element {
  const settings = useStore((s) => s.settings);
  if (!settings) {
    return (
      <span className="text-[11px] uppercase tracking-wider text-text-faint">loading…</span>
    );
  }
  const cc = settings.claude_code;
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px] uppercase tracking-wider',
        cc.found ? 'text-ok' : 'text-danger',
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
      className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-text-faint"
      title={ok ? 'server reachable' : 'server unreachable'}
    >
      <CircleDot className={cn('h-3 w-3', ok ? 'text-ok' : 'text-danger')} />
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
      ? 'border-danger bg-surface text-danger'
      : toast.kind === 'success'
        ? 'border-ok bg-surface text-ok'
        : 'border-border bg-surface text-text';
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
