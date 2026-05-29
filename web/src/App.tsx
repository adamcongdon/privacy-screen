import { useEffect, useRef } from 'react';
import { Shield, CircleDot, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Composer } from './components/Composer';
import { PreviewPane } from './components/PreviewPane';
import { TokenMap } from './components/TokenMap';
import { ReviewQueue } from './components/ReviewQueue';
import { ResponseStream } from './components/ResponseStream';
import { SettingsDrawer } from './components/SettingsDrawer';
import { ContextMenu } from './components/ContextMenu';
import { CustomCategoryDialog } from './components/CustomCategoryDialog';
import { useContextMenuShortcuts } from './lib/useContextMenu';
import { useStore, type ToastEntry } from './store';
import { cn } from './lib/cn';

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
  const health = useStore((s) => s.health);
  const settings = useStore((s) => s.settings);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

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
  }, [refreshHealth, refreshSettings, refreshVocab, refreshReview]);

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
        <div className="flex items-center gap-3">
          <KeyStatus />
          <HealthDot />
          <SettingsDrawer />
        </div>
      </header>

      {/* Three-column layout — horizontally resizable. */}
      <main className="flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="ps-columns">
          <Panel defaultSize={28} minSize={18}>
            <div className="flex h-full min-h-0 flex-col">
              <Composer
                textareaRef={sync.composerRef}
                onScroll={sync.onComposerScroll}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-col-resize transition-colors" />

          <Panel defaultSize={44} minSize={28}>
            <div className="flex h-full min-h-0 flex-col">
              <PanelGroup direction="vertical" autoSaveId="ps-middle-column">
                <Panel defaultSize={30} minSize={15}>
                  <PreviewPane
                    scrollRef={sync.previewRef}
                    onScroll={sync.onPreviewScroll}
                  />
                </Panel>
                <PanelResizeHandle className="h-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-row-resize transition-colors" />
                <Panel defaultSize={45} minSize={20}>
                  <TokenMap />
                </Panel>
                <PanelResizeHandle className="h-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-row-resize transition-colors" />
                <Panel defaultSize={25} minSize={15}>
                  <ReviewQueue />
                </Panel>
              </PanelGroup>
            </div>
          </Panel>

          <PanelResizeHandle className="w-[4px] bg-transparent hover:bg-zinc-700 data-[resize-handle-active]:bg-zinc-600 cursor-col-resize transition-colors" />

          <Panel defaultSize={28} minSize={18}>
            <div className="flex h-full min-h-0 flex-col">
              <ResponseStream />
            </div>
          </Panel>
        </PanelGroup>
      </main>

      {/* Global overlays */}
      <ContextMenu />
      <CustomCategoryDialog />

      {/* Toast stack */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
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
