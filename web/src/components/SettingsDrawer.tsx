import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Settings as SettingsIcon,
  Terminal,
  Check,
  AlertTriangle,
  Download,
  Brain,
} from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { cn } from '../lib/cn';
import { DialogHeader, ScrollableDialogBody, DialogFooter } from './ui/DialogScroll';

// Common aliases accepted by `claude --model`.
const MODEL_CHOICES = [
  'sonnet',
  'opus',
  'haiku',
  'claude-sonnet-4-7',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
];

// Canonical manifest URLs.
// - Stable: committed to main on stable releases.
// - Beta: committed to the `beta` branch. PRs landing on `beta` (from ac-build) auto-deploy beta builds.
const STABLE_MANIFEST =
  'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json';
const BETA_MANIFEST =
  'https://raw.githubusercontent.com/adamcongdon/privacy-screen/beta/release-manifest-beta.json';


export function SettingsDrawer(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const saveSettings = useStore((s) => s.saveSettings);
  const pushToast = useStore((s) => s.pushToast);
  const versionInfo = useStore((s) => s.versionInfo);
  const updateStatus = useStore((s) => s.updateStatus);
  const refreshVersion = useStore((s) => s.refreshVersion);
  const refreshUpdateStatus = useStore((s) => s.refreshUpdateStatus);
  const downloadUpdate = useStore((s) => s.downloadUpdate);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const settingsDeepLink = useStore((s) => s.settingsDeepLink);
  const setSettingsDeepLink = useStore((s) => s.setSettingsDeepLink);

  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [updateChannel, setUpdateChannel] = useState<'off' | 'stable' | 'beta'>('off');
  const [updateManifestUrl, setUpdateManifestUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void refreshSettings();
    void refreshVersion();
    void refreshUpdateStatus();
  }, [open, refreshSettings, refreshVersion, refreshUpdateStatus]);

  // Deep-link handler: when the drawer opens with `settingsDeepLink === 'update'`,
  // scroll the #update-section anchor into view, then clear the deep link so
  // re-opening manually doesn't re-trigger. We defer to the next frame so the
  // Radix slide-in animation has mounted the content before we measure.
  useEffect(() => {
    if (!open || settingsDeepLink !== 'update') return;
    const tick = requestAnimationFrame(() => {
      const el = document.getElementById('update-section');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setSettingsDeepLink(null);
    });
    return () => cancelAnimationFrame(tick);
  }, [open, settingsDeepLink, setSettingsDeepLink]);

  useEffect(() => {
    if (!settings) return;
    setModel(settings.model);
    setSystemPrompt(settings.system_prompt);
    setUpdateChannel(settings.update_channel ?? 'off');
    setUpdateManifestUrl(settings.update_manifest_url ?? '');
  }, [settings]);

  const dirty = useMemo(() => {
    if (!settings) return false;
    if (model !== settings.model) return true;
    if (systemPrompt !== settings.system_prompt) return true;
    if (updateChannel !== settings.update_channel) return true;
    if (updateManifestUrl !== settings.update_manifest_url) return true;
    return false;
  }, [settings, model, systemPrompt, updateChannel, updateManifestUrl]);

  const onSave = async (): Promise<void> => {
    if (!dirty || saving) return;
    setSaving(true);
    const channelChanged = settings && updateChannel !== settings.update_channel;
    try {
      const patch: {
        model?: string;
        system_prompt?: string;
        update_channel?: 'off' | 'stable' | 'beta';
        update_manifest_url?: string;
      } = {};
      if (settings && model !== settings.model) patch.model = model;
      if (settings && systemPrompt !== settings.system_prompt) patch.system_prompt = systemPrompt;
      if (settings && updateChannel !== settings.update_channel) patch.update_channel = updateChannel;
      if (settings && updateManifestUrl !== settings.update_manifest_url) patch.update_manifest_url = updateManifestUrl;
      await saveSettings(patch);
      if (channelChanged) {
        // Give the server a beat to persist, then re-check so the UI reflects the new channel default.
        setTimeout(() => {
          void refreshVersion();
          void refreshUpdateStatus();
        }, 120);
      }
    } catch {
      // Toast already pushed by store. Keep drawer open so user can retry.
    } finally {
      setSaving(false);
    }
  };

  const doCheckForUpdates = async () => {
    try {
      await refreshVersion();
      const v = useStore.getState().versionInfo;
      if (v?.updateAvailable && v.updateInfo) {
        pushToast('success', `Update available: ${v.latestKnown} (${v.updateInfo.channel}).`);
      } else if (v?.error) {
        pushToast('error', 'Could not reach the update manifest (network or config).');
      } else if (v) {
        pushToast('info', `You are on ${v.version} — no newer ${v.channel} release found.`);
      }
      await refreshUpdateStatus();
    } catch (e) {
      pushToast('error', `Update check failed: ${e instanceof Error ? e.message : String(e)}`);
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
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl animate-slide-in-right">
          <DialogHeader
            title="Settings"
            description={
              <>
                Inference runs through the local <code className="font-mono">claude</code> CLI —
                no API key needed. Authentication piggybacks on your <code className="font-mono">claude login</code> session.
              </>
            }
          />

          <ScrollableDialogBody>
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

          <JudgePanel />

          {/* Update channel — first-class UX for the "how to use beta" flow + real download/apply */}
          <section
            id="update-section"
            className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3"
          >
            <header className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              Updates (opt-in)
            </header>
            <p className="text-[11px] text-zinc-500">
              Opt-in check against a static manifest. When a newer release exists for your channel you can
              download it here (verified by sha256) and apply with one click. Nothing phones home or installs
              without you clicking.
            </p>

            {/* Live status line */}
            <div className="flex items-center justify-between text-[11px]">
              <div>
                Running <span className="font-mono text-zinc-200">{versionInfo?.version ?? '…'}</span>
                {versionInfo?.channel && versionInfo.channel !== 'off' && (
                  <span className="ml-1 text-zinc-500">· {versionInfo.channel}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void doCheckForUpdates()}
                className="rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              >
                Check now
              </button>
            </div>

            {/* Update available banner + actions */}
            {(versionInfo?.updateAvailable || updateStatus?.readyToApply || updateStatus?.download?.active) && (
              <div className="mt-1 rounded-md border border-emerald-900/60 bg-emerald-950/20 p-2 text-xs">
                {updateStatus?.download?.active && (
                  <div className="mb-2">
                    <div className="flex items-center justify-between text-emerald-300">
                      <span>Downloading v{updateStatus.download.version}…</span>
                      <span className="font-mono text-[10px]">
                        {Math.round((updateStatus.download.bytesDownloaded / (updateStatus.download.totalBytes || 1)) * 100)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded bg-emerald-900/60">
                      <div
                        className="h-1 bg-emerald-400 transition-all"
                        style={{
                          width: `${Math.min(100, Math.round((updateStatus.download.bytesDownloaded / (updateStatus.download.totalBytes || 1)) * 100))}%`,
                        }}
                      />
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-emerald-400/80">
                      {Math.round(updateStatus.download.bytesDownloaded / 1024 / 1024)} MB
                      {updateStatus.download.totalBytes > 0 && ` / ${Math.round(updateStatus.download.totalBytes / 1024 / 1024)} MB`}
                    </div>
                  </div>
                )}

                {!updateStatus?.download?.active && versionInfo?.updateAvailable && versionInfo.updateInfo && (
                  <div className="flex flex-col gap-1">
                    <div className="font-medium text-emerald-200">
                      Update available: v{versionInfo.updateInfo.version} ({versionInfo.updateInfo.channel})
                    </div>
                    <div className="text-[10px] text-emerald-300/80">
                      Released {new Date(versionInfo.updateInfo.releasedAt || Date.now()).toLocaleDateString()}
                    </div>
                    {versionInfo.updateInfo.notesUrl && (
                      <a
                        href={versionInfo.updateInfo.notesUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-emerald-400 underline"
                      >
                        View release notes →
                      </a>
                    )}
                  </div>
                )}

                {updateStatus?.readyToApply && !updateStatus?.download?.active && (
                  <div className="mt-2 text-emerald-200">
                    Ready to install. The app will quit and relaunch from the new binary.
                  </div>
                )}

                <div className="mt-2 flex gap-2">
                  {!updateStatus?.download?.active && versionInfo?.updateAvailable && (
                    <button
                      type="button"
                      onClick={() => void downloadUpdate()}
                      className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                    >
                      Download update
                    </button>
                  )}
                  {(updateStatus?.readyToApply || (!updateStatus?.download?.active && updateStatus?.updateInfo)) && (
                    <button
                      type="button"
                      onClick={() => void applyUpdate()}
                      className="rounded-md border border-emerald-700 bg-emerald-900/40 px-2.5 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-800"
                      title="The running binary will be replaced and a new instance started. You will need to refresh the page."
                    >
                      Install & restart
                    </button>
                  )}
                  {updateStatus?.download?.error && (
                    <div className="text-rose-400 text-[10px]">Download error: {updateStatus.download.error}</div>
                  )}
                </div>
              </div>
            )}

            <div className="mt-1 flex flex-col gap-1.5">
              {(
                [
                  {
                    value: 'off' as const,
                    title: 'Off (default)',
                    desc: 'Zero network activity for updates. Recommended unless you want to be notified of new versions.',
                  },
                  {
                    value: 'stable' as const,
                    title: 'Stable',
                    desc: 'Check the official release manifest on the main branch. Full releases only (PRs from beta → main).',
                  },
                  {
                    value: 'beta' as const,
                    title: 'Beta',
                    desc: 'Track builds from the `beta` branch. Merging a PR into `beta` (usually from your primary ac-build branch) auto-deploys a beta (prerelease + manifest).',
                  },
                ] as const
              ).map((opt) => {
                const selected = updateChannel === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                      selected
                        ? 'border-indigo-500/60 bg-indigo-950/20 text-zinc-100'
                        : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800/60',
                    )}
                  >
                    <input
                      type="radio"
                      name="update-channel"
                      value={opt.value}
                      checked={selected}
                      onChange={() => {
                        const next = opt.value;
                        setUpdateChannel(next);
                        // Smart default: when picking beta, switch the manifest URL to the dev one
                        // if it still points at the stable default (or is empty).
                        if (next === 'beta') {
                          const looksStable =
                            !updateManifestUrl ||
                            updateManifestUrl === STABLE_MANIFEST ||
                            updateManifestUrl.includes('/main/release-manifest.json');
                          if (looksStable) {
                            setUpdateManifestUrl(BETA_MANIFEST);
                          }
                        } else if (next === 'stable') {
                          // Switching back to stable: if it was the beta url, flip to stable.
                          if (updateManifestUrl === BETA_MANIFEST) {
                            setUpdateManifestUrl(STABLE_MANIFEST);
                          }
                        }
                      }}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div className="min-w-0">
                      <div className="font-medium">{opt.title}</div>
                      <div className="text-[11px] text-zinc-500">{opt.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Manifest URL — only relevant when not off. Editable for power users / mirrors. */}
            {updateChannel !== 'off' && (
              <div className="mt-1">
                <Field label="Manifest URL">
                  <input
                    type="text"
                    value={updateManifestUrl}
                    onChange={(e) => setUpdateManifestUrl(e.target.value)}
                    spellCheck={false}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                    placeholder={updateChannel === 'beta' ? BETA_MANIFEST : STABLE_MANIFEST}
                  />
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {updateChannel === 'beta' ? (
                      <>
                        Beta manifest lives on the <code>beta</code> branch. Merging into <code>beta</code>
                        (from ac-build) auto-updates it. Point here (or your own mirror) to receive beta builds.
                      </>
                    ) : (
                      <>Points at the stable manifest committed on merges to main.</>
                    )}
                  </p>
                </Field>
              </div>
            )}

            <p className="text-[10px] text-zinc-500">
              Downloads are staged to ~/.privacy-screen/updates and verified before the Install button is enabled.
              See <code className="font-mono">Plans/INSTALLER.md</code>.
            </p>
          </section>

          </ScrollableDialogBody>

          <DialogFooter>
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
          </DialogFooter>
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

/**
 * LLM judge controls — install model, enable/disable, see runtime + process state.
 *
 * Polls /api/judge-control/status every 8 s while the drawer is mounted, and
 * every 2 s during an active install (so progress is responsive). All state
 * comes from `useStore.judgeStatus` so the React tree only re-renders on
 * actual delta.
 */
function JudgePanel(): JSX.Element {
  const judgeStatus = useStore((s) => s.judgeStatus);
  const refreshJudgeStatus = useStore((s) => s.refreshJudgeStatus);
  const setJudgeEnabled = useStore((s) => s.setJudgeEnabled);
  const installJudgeModel = useStore((s) => s.installJudgeModel);
  const open = useStore((s) => s.settingsOpen);

  useEffect(() => {
    if (!open) return;
    void refreshJudgeStatus();
    const fast = judgeStatus?.install.active ? 2000 : 8000;
    const id = setInterval(() => void refreshJudgeStatus(), fast);
    return () => clearInterval(id);
  }, [open, judgeStatus?.install.active, refreshJudgeStatus]);

  if (!judgeStatus) {
    return (
      <section className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3 text-xs text-zinc-500">
        <header className="mb-1 flex items-center gap-1.5 font-semibold uppercase tracking-wider text-zinc-400">
          <Brain className="h-3.5 w-3.5" /> LLM judge
        </header>
        Loading…
      </section>
    );
  }

  const { config, runtime, model, available_models, process: proc, install } = judgeStatus;
  const canEnable = model.installed && runtime.installed;
  const onToggle = async (next: boolean): Promise<void> => {
    try {
      await setJudgeEnabled(next);
    } catch {
      // toast already shown
    }
  };

  const defaultModel = available_models[0]?.name ?? 'qwen2.5-1.5b';
  const installPct =
    install.totalBytes > 0
      ? Math.min(100, Math.round((install.bytesDownloaded / install.totalBytes) * 100))
      : 0;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-3">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          <Brain className="h-3.5 w-3.5" /> LLM judge (opt-in)
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
            config.enabled
              ? 'bg-emerald-900/40 text-emerald-300'
              : 'bg-zinc-800 text-zinc-500',
          )}
        >
          {config.enabled ? 'on' : 'off'}
        </span>
      </header>
      <p className="text-[11px] text-zinc-500">
        Runs a small local LLM after the regex scrubber to flag PII the rules missed.
        Findings go to the review queue; the judge never mutates scrub output.
      </p>

      {/* Runtime status */}
      <StatusRow
        label="llama-server"
        ok={runtime.installed}
        okText={runtime.path ?? 'found'}
        failText="not on PATH — install llama.cpp (brew install llama.cpp on macOS)"
      />

      {/* Model status */}
      <StatusRow
        label="model"
        ok={model.installed}
        okText={
          model.path
            ? `${(model.bytes ?? 0) > 0 ? `${Math.round((model.bytes ?? 0) / 1_000_000)} MB · ` : ''}${shortPath(model.path)}`
            : 'installed'
        }
        failText={model.path ? `missing at ${shortPath(model.path)}` : 'not installed'}
      />

      {/* Process state */}
      {(proc.state === 'ready' || proc.state === 'starting' || proc.state === 'failed') && (
        <StatusRow
          label="process"
          ok={proc.state === 'ready'}
          okText="ready"
          failText={proc.state === 'starting' ? 'starting…' : `failed: ${proc.detail ?? 'unknown'}`}
        />
      )}

      {/* Install progress */}
      {install.active && (
        <div className="flex flex-col gap-1 rounded border border-sky-800 bg-sky-950/30 px-2 py-1.5 text-[11px] text-sky-200">
          <div className="flex items-center justify-between">
            <span>installing {install.modelName}…</span>
            <span className="font-mono">{installPct}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-sky-900/60">
            <div
              className="h-full rounded-full bg-sky-400 transition-all"
              style={{ width: `${installPct}%` }}
            />
          </div>
          <div className="font-mono text-[10px] text-sky-300/70">
            {Math.round(install.bytesDownloaded / 1_000_000)} /{' '}
            {Math.round(install.totalBytes / 1_000_000)} MB
          </div>
        </div>
      )}
      {install.error && !install.active && (
        <div className="rounded border border-rose-800 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200">
          last install failed: {install.error}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-1">
        {!model.installed && (
          <button
            type="button"
            disabled={install.active}
            onClick={() => void installJudgeModel(defaultModel)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold',
              install.active
                ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                : 'bg-indigo-600 text-white hover:bg-indigo-500',
            )}
            title={
              available_models[0]?.description ??
              'Download the pinned model (~1 GB, Apache 2.0)'
            }
          >
            <Download className="h-3.5 w-3.5" />
            {install.active ? 'installing…' : `Install ${defaultModel}`}
          </button>
        )}

        <div className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1.5">
          <span className="text-[11px] text-zinc-400">
            Enable judge
            {!canEnable && (
              <span className="ml-1 text-rose-400">
                — {(!runtime.installed && 'runtime missing') ||
                  (!model.installed && 'model missing')}
              </span>
            )}
          </span>
          <Switch
            checked={config.enabled}
            disabled={!canEnable && !config.enabled}
            onChange={(next) => void onToggle(next)}
          />
        </div>
      </div>

      <p className="text-[10px] text-zinc-500">
        Disabled by default. See{' '}
        <code className="font-mono">SAFETY_CHECKLIST.md</code> → "LLM secondary validation".
      </p>
    </section>
  );
}

function StatusRow({
  label,
  ok,
  okText,
  failText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  failText: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded border px-2 py-1.5 text-[11px]',
        ok
          ? 'border-emerald-800/60 bg-emerald-950/20 text-emerald-200'
          : 'border-zinc-800 bg-zinc-900/40 text-zinc-400',
      )}
    >
      {ok ? (
        <Check className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400" />
      )}
      <div className="flex flex-1 items-center gap-1.5 overflow-hidden">
        <span className="font-semibold uppercase tracking-wider">{label}</span>
        <span className="truncate font-mono text-[10px] opacity-80">
          {ok ? okText : failText}
        </span>
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 rounded-full transition-colors',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-indigo-500' : 'bg-zinc-700',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** Trim a long absolute path to its trailing 32 chars with a leading ellipsis. */
function shortPath(p: string): string {
  if (p.length <= 32) return p;
  return '…' + p.slice(p.length - 32);
}
