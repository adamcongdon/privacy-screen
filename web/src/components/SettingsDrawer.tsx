import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings as SettingsIcon, X, Terminal, Check, AlertTriangle } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/cn';

// Common aliases accepted by `claude --model`.
const MODEL_CHOICES = [
  'sonnet',
  'opus',
  'haiku',
  'claude-sonnet-4-7',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
];

export function SettingsDrawer(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const saveSettings = useStore((s) => s.saveSettings);

  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void refreshSettings();
  }, [open, refreshSettings]);

  useEffect(() => {
    if (!settings) return;
    setModel(settings.model);
    setSystemPrompt(settings.system_prompt);
  }, [settings]);

  const dirty = useMemo(() => {
    if (!settings) return false;
    if (model !== settings.model) return true;
    if (systemPrompt !== settings.system_prompt) return true;
    return false;
  }, [settings, model, systemPrompt]);

  const onSave = async (): Promise<void> => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const patch: { model?: string; system_prompt?: string } = {};
      if (settings && model !== settings.model) patch.model = model;
      if (settings && systemPrompt !== settings.system_prompt) patch.system_prompt = systemPrompt;
      await saveSettings(patch);
    } catch {
      // Toast already pushed by store. Keep drawer open so user can retry.
    } finally {
      setSaving(false);
    }
  };

  const cc = settings?.claude_code;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          title="settings"
        >
          <SettingsIcon className="h-3.5 w-3.5" /> settings
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col gap-4 border-l border-zinc-800 bg-zinc-950 p-5 shadow-2xl animate-slide-in-right">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-xs text-zinc-500">
            Inference runs through the local <code className="font-mono">claude</code> CLI —
            no API key needed. Authentication piggybacks on your <code className="font-mono">claude login</code> session.
          </Dialog.Description>

          {/* Claude Code status */}
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
              cc?.found
                ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200'
                : 'border-rose-800 bg-rose-950/30 text-rose-200',
            )}
          >
            {cc?.found ? <Terminal className="mt-0.5 h-3.5 w-3.5" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5" />}
            <div className="flex-1">
              {cc?.found ? (
                <>
                  <div className="flex items-center gap-1">
                    Claude Code <Check className="h-3.5 w-3.5" />
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-emerald-300/80">{cc.version}</div>
                </>
              ) : (
                <>
                  <div className="font-semibold">Claude Code not found</div>
                  <div className="mt-0.5 text-[11px]">
                    Install from <code className="font-mono">docs.claude.com/en/docs/claude-code</code> and run{' '}
                    <code className="font-mono">claude login</code>. The server refuses to start without it.
                  </div>
                  {cc?.error && <div className="mt-1 font-mono text-[10px] opacity-60">{cc.error}</div>}
                </>
              )}
            </div>
          </div>

          <Field label="Model">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            >
              {model && !MODEL_CHOICES.includes(model) && <option value={model}>{model}</option>}
              {MODEL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-zinc-500">
              Passed verbatim to <code className="font-mono">claude --model</code>. Aliases (sonnet, opus, haiku) or full IDs both work.
            </p>
          </Field>

          <Field label="System prompt (optional)">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              spellCheck={false}
              placeholder="Appended to the default system prompt via --append-system-prompt."
            />
          </Field>

          <div className="mt-auto flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void onSave()}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold',
                dirty && !saving
                  ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                  : 'cursor-not-allowed bg-zinc-800 text-zinc-500',
              )}
            >
              {saving ? 'saving…' : 'Save'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}
