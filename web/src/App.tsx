import { useEffect } from 'react';
import { Shield, CircleDot, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Composer } from './components/Composer';
import { PreviewPane } from './components/PreviewPane';
import { TokenMap } from './components/TokenMap';
import { ReviewQueue } from './components/ReviewQueue';
import { ResponseStream } from './components/ResponseStream';
import { SettingsDrawer } from './components/SettingsDrawer';
import { useStore, type ToastEntry } from './store';
import { cn } from './lib/cn';

export default function App(): JSX.Element {
  const refreshHealth = useStore((s) => s.refreshHealth);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshVocab = useStore((s) => s.refreshVocab);
  const refreshReview = useStore((s) => s.refreshReview);
  const health = useStore((s) => s.health);
  const settings = useStore((s) => s.settings);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

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

      {/* Three-pane grid */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,1fr)_minmax(360px,1.2fr)_minmax(320px,1fr)] divide-x divide-zinc-800">
        <div className="flex min-h-0 flex-col">
          <Composer />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <PreviewPane />
            <TokenMap />
            <ReviewQueue />
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <ResponseStream />
        </div>
      </main>

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
