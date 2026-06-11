/**
 * Flow screen 4 — Settings. Promotes components/SettingsDrawer.tsx to a full
 * page, wired to the REAL store/API. Mirrors the SettingsDrawer logic for every
 * section that has working API wiring.
 *
 * Reused logic / store surface (verified against store.ts + api.ts):
 *   - Screening mode  → store.mode / store.setMode  (persists to
 *       PRIVACY_CONFIG.yaml via saveSettings({ mode }) → POST /api/settings, then
 *       re-runs refreshScrub. GET /api/settings returns `mode`. See store.ts
 *       ScreenMode docs.)
 *   - Customer names  → store.addCustomerName(name)  (api.addVocab as 'customer')
 *                       + store.forgetVocab(realValue) for removal. The chip list
 *                       is derived from vocab rows whose category === 'customer'.
 *   - Local LLM judge → store.judgeStatus / refreshJudgeStatus / setJudgeEnabled /
 *                       installJudgeModel  (api.judge-control endpoints). Mirrors
 *                       SettingsDrawer.JudgePanel exactly (install CTA + progress,
 *                       enable toggle gated on runtime+model installed).
 *   - Updates         → store.settings.update_channel / saveSettings({update_channel})
 *                       + refreshVersion / versionInfo  (api.version). Mirrors
 *                       SettingsDrawer's channel radios (re-skinned as a segmented
 *                       control) + Check now.
 *   - Data & privacy  → store.forgetVocab over every vocab row (no dedicated
 *                       clear-vocab endpoint exists; we drive the real per-value
 *                       forget action). Path string is informational.
 *
 * WCAG: mode rows = role="radiogroup" + role="radio"/aria-checked; the judge
 * toggle uses .ps-toggle with role="switch" + aria-checked; the channel control
 * is role="radiogroup" + role="radio"/aria-checked; chip remove + icon buttons
 * have aria-label.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Zap,
  Users,
  Sparkles,
  RefreshCw,
  Lock,
  Check,
  X,
  Plus,
  Download,
  Trash2,
  AlertTriangle,
  Link,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from '../../store';
import type { ScreenMode } from '../../store';
import { UPDATE_CANONICAL_URLS } from '../../api';
import { Segmented, useRovingRadio } from '../ui/Segmented';

/** Section card — 30px rounded icon tile + title + optional description + body. */
function Card({
  icon: Icon,
  title,
  description,
  accent = false,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  accent?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="ps-panel" style={{ padding: 18 }}>
      <div className="flex items-center gap-2.5" style={{ marginBottom: description ? 4 : 14 }}>
        <span
          className="grid place-items-center rounded-[8px]"
          style={{
            width: 30,
            height: 30,
            flex: 'none',
            background: accent ? 'var(--acc-tint)' : 'var(--surface-2)',
          }}
          aria-hidden="true"
        >
          <Icon size={16} color={accent ? 'var(--acc)' : 'var(--text-dim)'} />
        </span>
        <span className="text-[14.5px] font-semibold text-text">{title}</span>
      </div>
      {description && (
        <p className="text-[12px] leading-[1.45] text-text-faint" style={{ margin: '0 0 14px 40px' }}>
          {description}
        </p>
      )}
      {children}
    </div>
  );
}

const MODE_ROWS: ReadonlyArray<{
  id: ScreenMode;
  title: string;
  desc: string;
  rec?: boolean;
}> = [
  { id: 'observe', title: 'Observe', desc: 'Detect and log only — nothing is blocked or mutated.' },
  {
    id: 'enforce',
    title: 'Enforce',
    desc: 'Block credentials and replace PII with tokens before send.',
    rec: true,
  },
  { id: 'disabled', title: 'Disabled', desc: 'Emergency bypass — text passes through untouched.' },
];

function ScreeningModeCard(): JSX.Element {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  // Shared roving for vertical mode radiogroup (arrow up/down + Home/End to change mode).
  // This satisfies "keyboard-only users change mode with arrows".
  const modeRows = MODE_ROWS.map((r) => ({ value: r.id }));
  const { getTabIndex, onKeyDown } = useRovingRadio(modeRows, mode, setMode, 'vertical');
  return (
    <Card icon={Zap} title="Screening mode" accent>
      <div
        role="radiogroup"
        aria-label="Screening mode"
        className="flex flex-col gap-2"
        onKeyDown={onKeyDown}
      >
        {MODE_ROWS.map((row) => {
          const on = mode === row.id;
          return (
            <button
              key={row.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={getTabIndex(row.id)}
              onClick={() => setMode(row.id)}
              className="flex w-full items-start gap-2.5 text-left"
              style={{
                padding: '11px 13px',
                borderRadius: 10,
                border: `1px solid ${on ? 'var(--acc)' : 'var(--border)'}`,
                background: on ? 'var(--acc-tint)' : 'var(--surface-2)',
              }}
            >
              <span
                aria-hidden="true"
                className="grid place-items-center"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  flex: 'none',
                  marginTop: 1,
                  border: `2px solid ${on ? 'var(--acc)' : 'var(--border-2)'}`,
                }}
              >
                {on && (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--acc)' }} />
                )}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-text">{row.title}</span>
                  {row.rec && (
                    <span
                      className="inline-flex items-center rounded-md px-1.5 text-[10.5px] font-semibold"
                      style={{ height: 18, background: 'var(--acc-tint)', color: 'var(--acc)' }}
                    >
                      recommended
                    </span>
                  )}
                </span>
                <span className="text-[11.5px] leading-[1.4] text-text-faint">{row.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function CustomerNamesCard(): JSX.Element {
  const vocab = useStore((s) => s.vocab);
  const refreshVocab = useStore((s) => s.refreshVocab);
  const addCustomerName = useStore((s) => s.addCustomerName);
  const forgetVocab = useStore((s) => s.forgetVocab);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void refreshVocab();
  }, [refreshVocab]);

  // Customer chips are the persisted vocab rows whose category is 'customer'.
  const names = useMemo(
    () => vocab.filter((v) => v.category.toLowerCase() === 'customer').map((v) => v.real_value),
    [vocab],
  );

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    void addCustomerName(v); // → api.addVocab(v, 'customer') + re-scrub
    setDraft('');
  };

  return (
    <Card
      icon={Users}
      title="Customer names"
      description="Names added here are always tokenized as {CUSTOMER}. Try adding one, then revisit Scrub."
    >
      <div className="mb-3 flex flex-wrap gap-[7px]">
        {names.length === 0 && (
          <span className="text-[12px] text-text-faint">No names yet.</span>
        )}
        {names.map((n) => (
          <span
            key={n}
            className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-2 px-2.5 text-[12px] text-text"
            style={{ height: 28 }}
          >
            {n}
            <button
              type="button"
              onClick={() => void forgetVocab(n)}
              aria-label={`Remove ${n}`}
              className="flex items-center text-text-faint hover:text-danger"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a name…"
          aria-label="Add a customer name"
          className="min-w-0 flex-1 rounded-[10px] border border-border bg-surface-2 px-2.5 text-[13px] text-text placeholder:text-text-faint"
          style={{ height: 32 }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="flex items-center gap-1.5 rounded-[8px] border border-border bg-surface-2 px-2.5 text-[12px] font-medium text-text-dim hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          style={{ height: 32 }}
        >
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>
    </Card>
  );
}

/** Local LLM judge — mirrors SettingsDrawer.JudgePanel: install CTA + progress,
 * Installed badge, and the enable toggle gated on runtime + model installed. */
function JudgeCard(): JSX.Element {
  const judgeStatus = useStore((s) => s.judgeStatus);
  const refreshJudgeStatus = useStore((s) => s.refreshJudgeStatus);
  const setJudgeEnabled = useStore((s) => s.setJudgeEnabled);
  const installJudgeModel = useStore((s) => s.installJudgeModel);

  // Poll status while mounted — fast (2s) during an active install, else 8s.
  // Same cadence as SettingsDrawer.JudgePanel.
  useEffect(() => {
    void refreshJudgeStatus();
    const fast = judgeStatus?.install.active ? 2000 : 8000;
    const id = setInterval(() => void refreshJudgeStatus(), fast);
    return () => clearInterval(id);
  }, [judgeStatus?.install.active, refreshJudgeStatus]);

  const defaultModel = judgeStatus?.available_models[0]?.name ?? 'qwen2.5-1.5b';
  const modelInstalled = judgeStatus?.model.installed ?? false;
  const runtimeInstalled = judgeStatus?.runtime.installed ?? false;
  const enabled = judgeStatus?.config.enabled ?? false;
  const canEnable = modelInstalled && runtimeInstalled;
  const install = judgeStatus?.install;
  const installPct =
    install && install.totalBytes > 0
      ? Math.min(100, Math.round((install.bytesDownloaded / install.totalBytes) * 100))
      : 0;

  return (
    <Card icon={Sparkles} title="Local LLM judge" accent>
      {/* model card */}
      <div
        className="mb-3 rounded-[10px] border border-border bg-surface-2"
        style={{ padding: 13 }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="grid place-items-center rounded-[8px]"
              style={{ width: 34, height: 34, background: 'var(--surface-3)', flex: 'none' }}
              aria-hidden="true"
            >
              <Sparkles size={17} color="var(--acc)" />
            </span>
            <span className="flex flex-col">
              <span className="text-[13px] font-semibold text-text">{defaultModel}</span>
              <span className="text-[11px] text-text-faint">
                {judgeStatus?.available_models[0]?.description ?? '1.0 GB · Apache-2.0 · 29 languages'}
              </span>
            </span>
          </div>
          {modelInstalled ? (
            <span
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium"
              style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}
            >
              <Check size={11} color="var(--ok)" aria-hidden="true" /> Installed
            </span>
          ) : (
            <button
              type="button"
              disabled={install?.active}
              onClick={() => void installJudgeModel(defaultModel)}
              className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              style={{ background: 'var(--acc)', color: 'var(--acc-ink)' }}
            >
              <Download size={13} aria-hidden="true" />
              {install?.active ? 'installing…' : 'Install'}
            </button>
          )}
        </div>

        {/* install progress */}
        {install?.active && (
          <div className="mt-2.5 flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] text-text-dim">
              <span>installing {install.modelName}…</span>
              <span className="font-mono">{installPct}%</span>
            </div>
            <div
              className="h-1 overflow-hidden rounded-full"
              style={{ background: 'var(--surface-3)' }}
            >
              <div style={{ width: `${installPct}%`, height: '100%', background: 'var(--acc)' }} />
            </div>
          </div>
        )}
        {install && !install.active && install.error && (
          <p className="mt-2 text-[11px] text-danger">last install failed: {install.error}</p>
        )}
      </div>

      {/* enable toggle */}
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-[13px] font-semibold text-text">Enable judge</span>
          <span className="text-[11.5px] text-text-faint">
            {canEnable ? (
              'Second-pass review of already-scrubbed text. Runs fully local.'
            ) : (
              <span className="text-danger">
                {!runtimeInstalled
                  ? 'llama-server not on PATH — install llama.cpp.'
                  : 'Install the model to enable the judge.'}
              </span>
            )}
          </span>
        </span>
        <button
          type="button"
          className="ps-toggle"
          role="switch"
          aria-checked={enabled}
          aria-label="Enable judge"
          disabled={!canEnable && !enabled}
          onClick={() => void setJudgeEnabled(!enabled)}
          style={!canEnable && !enabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        />
      </div>
    </Card>
  );
}

const CHANNELS = ['off', 'stable', 'beta'] as const;
type Channel = (typeof CHANNELS)[number];

function relTime(ts: number | null): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 8) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function sourceLabel(url: string): string {
  const u = url.trim();
  if (u === UPDATE_CANONICAL_URLS.stable) return 'Official stable channel · main branch';
  if (u === UPDATE_CANONICAL_URLS.beta) return 'Official beta channel · beta branch';
  return 'Custom manifest source';
}

function UpdatesCard(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const versionInfo = useStore((s) => s.versionInfo);
  const refreshVersion = useStore((s) => s.refreshVersion);
  const refreshUpdateStatus = useStore((s) => s.refreshUpdateStatus);
  const pushToast = useStore((s) => s.pushToast);
  const downloadUpdate = useStore((s) => s.downloadUpdate);
  const applyUpdate = useStore((s) => s.applyUpdate);
  const updateStatus = useStore((s) => s.updateStatus);

  const channel: Channel = (settings?.update_channel ?? 'off') as Channel;
  const currentUrl = settings?.update_manifest_url ?? '';

  // Local draft for the editable URL field (self-service, no YAML).
  const [draft, setDraft] = useState(currentUrl);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  // Optional client-side probe result for rich mismatch/notfound diagnosis on custom URLs.
  const [probe, setProbe] = useState<{ manifestChannel?: string; httpOk?: boolean } | null>(null);

  // Sync draft when settings change externally (save from elsewhere, boot, etc).
  useEffect(() => {
    setDraft(currentUrl || '');
  }, [currentUrl]);

  // Reset transient check state when channel flips.
  useEffect(() => {
    if (channel === 'off') {
      setIsChecking(false);
      setProbe(null);
    }
  }, [channel]);

  // Pull the latest download/apply state on mount so a download that finished in
  // a previous session (or is still in flight) surfaces its progress / "ready to
  // install" state without the user re-checking. The store's download poller
  // keeps updateStatus fresh while a download is active.
  useEffect(() => {
    void refreshUpdateStatus();
  }, [refreshUpdateStatus]);

  const off = channel === 'off';
  const canon = channel === 'off' ? '' : UPDATE_CANONICAL_URLS[channel];
  const draftValid = /^https:\/\/\S+$/i.test(draft.trim());
  const dirty = draft.trim() !== (currentUrl || '').trim();
  const isCanon = draft.trim() === canon;

  const installed = versionInfo?.version ?? '…';

  // ── Download / apply lifecycle (server truth via store.updateStatus) ────────
  // The redesign shipped only a "Download" button and never rendered what
  // happens after: the staged-and-verified "ready to install" state. These
  // derive the three action states (download → downloading → ready) so the UI
  // reflects the backend's download.active / readyToApply / canAutoApply.
  const dl = updateStatus?.download;
  const downloading = dl?.active === true;
  const downloadedReady = updateStatus?.readyToApply === true;
  const canAutoApply = updateStatus?.canAutoApply === true;
  const dlPct =
    dl && dl.totalBytes > 0
      ? Math.min(100, Math.round((dl.bytesDownloaded / dl.totalBytes) * 100))
      : 0;
  const fmtMb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const stagedVersion = dl?.version ?? versionInfo?.updateInfo?.version ?? '';

  const onChannel = (c: Channel) => {
    if (c === channel) return;
    const nextCanon = c === 'off' ? '' : UPDATE_CANONICAL_URLS[c];
    const patch: { update_channel: Channel; update_manifest_url?: string } = { update_channel: c };
    if (nextCanon) patch.update_manifest_url = nextCanon;
    void saveSettings(patch).then(() => {
      // draft syncs via the settings effect above.
      setTimeout(() => {
        void refreshVersion();
        void refreshUpdateStatus();
      }, 120);
    });
  };

  const saveUrl = () => {
    if (!draftValid || !dirty) return;
    void saveSettings({ update_manifest_url: draft.trim() }).then(() => {
      void refreshVersion();
      void refreshUpdateStatus();
    });
  };

  const useRecommended = () => {
    if (!canon) return;
    setDraft(canon);
    void saveSettings({ update_manifest_url: canon }).then(() => {
      pushToast('success', `Using recommended ${channel} manifest`);
      void refreshVersion();
      void refreshUpdateStatus();
    });
  };

  const runClientProbe = async (url: string) => {
    setProbe(null);
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'error' });
      if (!res.ok) {
        setProbe({ httpOk: false });
        return;
      }
      const m = await res.json().catch(() => null);
      const mc = m && typeof m === 'object' && 'channel' in m ? String((m as any).channel) : undefined;
      setProbe({ httpOk: true, manifestChannel: mc });
    } catch {
      setProbe({ httpOk: false });
    }
  };

  const onCheck = async () => {
    if (off) return;
    const urlToCheck = draft.trim() || currentUrl;
    setIsChecking(true);
    setProbe(null);
    try {
      await refreshVersion();
      await refreshUpdateStatus();
      setLastCheckedAt(Date.now());
      // Probe for rich diagnostics (mismatch / notfound) without changing server check contract.
      if (urlToCheck) {
        void runClientProbe(urlToCheck);
      }
    } finally {
      setIsChecking(false);
    }
  };

  // Derive rich status for the panel (server truth for available/uptodate + probe for custom diagnostics).
  const v = versionInfo;
  let status: 'idle' | 'checking' | 'off' | 'uptodate' | 'available' | 'notfound' | 'mismatch' | 'error' = 'idle';
  if (off) status = 'off';
  else if (isChecking) status = 'checking';
  else if (v?.error) status = 'error';
  else if (v?.updateAvailable && v.updateInfo) {
    // Server says there is a newer matching-platform asset on the requested channel.
    if (v.updateInfo.channel && v.updateInfo.channel !== channel) status = 'mismatch';
    else status = 'available';
  } else if (probe && probe.httpOk === false) {
    status = 'notfound';
  } else if (probe && probe.manifestChannel && probe.manifestChannel !== channel) {
    status = 'mismatch';
  } else if (channel === 'stable') {
    // Stable has no published manifest yet (per design + current release state).
    status = 'notfound';
  } else {
    status = 'uptodate';
  }

  const triedUrl = (isChecking ? draft.trim() : currentUrl) || draft.trim();

  const cfg = {
    idle: {
      c: 'var(--text-faint)',
      bg: 'var(--surface-2)',
      ic: RefreshCw,
      t: 'Not checked yet',
      d: `Run a check to see what’s available on the ${channel} channel.`,
    },
    checking: {
      c: 'var(--acc)',
      bg: 'var(--acc-tint)',
      ic: RefreshCw,
      t: 'Checking…',
      d: triedUrl,
      showUrl: true,
    },
    off: {
      c: 'var(--text-faint)',
      bg: 'var(--surface-2)',
      ic: Lock,
      t: 'Updates are off',
      d: 'Privacy Screen will never reach out for updates.',
    },
    uptodate: {
      c: 'var(--ok)',
      bg: 'var(--ok-tint)',
      ic: Check,
      t: 'Up to date',
      d: `On ${v?.version ?? installed} — latest on the ${channel} channel.`,
      showUrl: true,
    },
    available: {
      c: 'var(--acc)',
      bg: 'var(--acc-tint)',
      ic: Download,
      t: `Update available · ${v?.updateInfo?.version ?? ''}`,
      d: `Found on the ${v?.updateInfo?.channel ?? channel} channel. Nothing installs until you apply it.`,
      showUrl: true,
      showActions: 'available',
    },
    notfound: {
      c: 'var(--warn)',
      bg: 'var(--warn-tint)',
      ic: AlertTriangle,
      t: 'No release found (404)',
      d: 'The stable channel has no published manifest yet — switch to Beta for current builds.',
      showUrl: true,
      showActions: 'notfound',
    },
    mismatch: {
      c: 'var(--warn)',
      bg: 'var(--warn-tint)',
      ic: AlertTriangle,
      t: 'Channel mismatch',
      d: (probe?.manifestChannel
        ? `Manifest is for the “${probe.manifestChannel}” channel, but “${channel}” is selected. `
        : '') + 'Point at the matching manifest or use the recommended URL.',
      showUrl: true,
    },
    error: {
      c: 'var(--danger)',
      bg: 'var(--danger-bg)',
      ic: AlertTriangle,
      t: 'Couldn’t check',
      d: 'Network error or invalid URL while fetching the manifest.',
      showUrl: true,
    },
  }[status];

  let displayDesc = cfg.d;
  if (status === 'notfound' && channel === 'beta') {
    displayDesc = 'No release manifest found at this URL — use the recommended beta URL or check your custom source.';
  }
  // Reflect download/apply progress in the panel copy so "available" doesn't read
  // as if nothing happened after the user already downloaded.
  if (status === 'available') {
    if (downloadedReady) {
      displayDesc = `Downloaded ${stagedVersion} — verified and ready to install. Nothing changes until you click Install.`;
    } else if (downloading) {
      displayDesc = `Downloading ${stagedVersion}… ${dlPct}%`;
    }
  }

  const StatusIcon = cfg.ic;

  return (
    <div className="ps-panel" style={{ padding: 18 }}>
      {/* Header row with icon tile + title + installed version chip (matches reference) */}
      <div className="flex items-center gap-2.5" style={{ marginBottom: 4 }}>
        <span
          className="grid place-items-center rounded-[8px]"
          style={{
            width: 30,
            height: 30,
            flex: 'none',
            background: 'var(--acc-tint)',
          }}
          aria-hidden="true"
        >
          <RefreshCw size={16} color="var(--acc)" />
        </span>
        <span className="text-[14.5px] font-semibold text-text">Updates</span>
        <span className="flex-1" />
        <span
          className="inline-flex items-center rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text"
          style={{ height: 22 }}
        >
          {installed}
        </span>
      </div>
      <p className="text-[12px] leading-[1.45] text-text-faint" style={{ margin: '0 0 14px 40px' }}>
        Opt-in. No telemetry; the manifest is fetched with a plain GET and SHA-256 verified before any swap.
      </p>

      {/* Channel segmented control + description */}
      <div className="mb-3 flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-text-faint">Channel</span>
        <Segmented<Channel>
          label="Update channel"
          value={channel}
          onChange={onChannel}
          options={CHANNELS.map((c) => ({ value: c, label: c }))}
        />
        <span className="text-[11.5px] leading-[1.45] text-text-faint">
          {channel === 'off' && 'No update checks. Privacy Screen never contacts the network for updates.'}
          {channel === 'stable' && 'Vetted releases from the main branch. Rare, well-tested builds.'}
          {channel === 'beta' && 'Release candidates from the beta branch. New betas land often — nothing installs automatically.'}
        </span>
      </div>

      {/* Update source editor (hidden entirely for Off — zero network) */}
      {!off && (
        <div
          className="mb-3 rounded-[10px] border border-border bg-surface-2"
          style={{ padding: 13 }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-text-faint">
              <Link size={13} color="var(--text-dim)" aria-hidden="true" /> Update source
            </span>
            {isCanon ? (
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-medium"
                style={{ height: 18, background: 'var(--acc-tint)', color: 'var(--acc)', border: '1px solid transparent' }}
              >
                <Check size={11} color="var(--acc)" aria-hidden="true" /> Recommended
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-border px-1.5 text-[10px] font-medium text-text-dim" style={{ height: 18 }}>
                Custom
              </span>
            )}
          </div>

          <span className="mb-1.5 block text-[12px] font-semibold text-text-dim">{sourceLabel(draft.trim() || currentUrl)}</span>

          <div className="flex items-stretch gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveUrl();
                }
              }}
              spellCheck={false}
              placeholder="https://…/release-manifest.json"
              className="min-w-0 flex-1 rounded-[10px] border bg-surface px-2.5 font-mono text-[11.5px] text-text placeholder:text-text-faint"
              style={{
                height: 32,
                borderColor: draft && !draftValid ? 'var(--danger-border)' : 'var(--border)',
              }}
            />
            <button
              type="button"
              disabled={!dirty || !draftValid}
              onClick={saveUrl}
              className="flex-none rounded-[8px] border border-border bg-surface-2 px-3 text-[12px] font-medium text-text-dim hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ height: 32 }}
            >
              Save
            </button>
          </div>

          <div className="mt-1.5 flex min-h-[18px] items-center justify-between gap-2 text-[11px]">
            <span style={{ color: draft && !draftValid ? 'var(--danger)' : 'var(--text-faint)' }}>
              {draft && !draftValid ? 'Must be an https:// URL.' : 'Power users can point at a fork, mirror, or internal copy.'}
            </span>
            {!isCanon && draftValid && (
              <button
                type="button"
                onClick={useRecommended}
                className="flex items-center gap-1 rounded px-1.5 text-[11px] text-text-dim hover:text-text"
              >
                <RefreshCw size={11} aria-hidden="true" /> Use recommended
              </button>
            )}
          </div>
        </div>
      )}

      {/* Check button + last checked */}
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--acc)] px-3 text-[12px] font-semibold text-[var(--acc-ink)] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={off || isChecking}
          onClick={() => void onCheck()}
        >
          <RefreshCw
            size={13}
            aria-hidden="true"
            className={isChecking ? 'animate-spin' : ''}
          />
          Check for updates now
        </button>
        {lastCheckedAt && !isChecking && (
          <span className="text-[11px] text-text-faint">Last checked {relTime(lastCheckedAt)}</span>
        )}
      </div>

      {/* Rich status panel */}
      <div
        className="flex items-start gap-2.5 rounded-[10px] px-3 py-2.5"
        style={{ background: cfg.bg, color: cfg.c }}
      >
        <StatusIcon
          size={16}
          aria-hidden="true"
          className={isChecking ? 'mt-0.5 animate-spin' : 'mt-0.5'}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">{cfg.t}</div>
          <div className="text-[11.5px] leading-[1.4] text-[color:var(--text-dim)]" style={{ wordBreak: 'break-word' }}>
            {displayDesc}
          </div>
          {cfg.showUrl && triedUrl && (
            <div className="mt-0.5 break-all font-mono text-[10px] text-text-faint">{triedUrl}</div>
          )}

          {/* Inline actions for terminal states. Primary action is download-state
              aware: Download → Downloading (progress) → Install & restart. */}
          {cfg.showActions === 'available' && v?.updateInfo && (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {downloadedReady ? (
                  canAutoApply ? (
                    <button
                      type="button"
                      onClick={() => void applyUpdate()}
                      className="flex items-center gap-1.5 rounded-[8px] bg-[var(--acc)] px-2.5 py-1 text-[12px] font-semibold text-[var(--acc-ink)]"
                    >
                      <RefreshCw size={13} aria-hidden="true" /> Install &amp; restart{' '}
                      {stagedVersion}
                    </button>
                  ) : (
                    <span className="text-[11.5px] text-text-dim">
                      Downloaded to{' '}
                      <span className="break-all font-mono">{dl?.stagedPath}</span> — replace
                      the app manually to finish installing.
                    </span>
                  )
                ) : downloading ? (
                  <button
                    type="button"
                    disabled
                    className="flex items-center gap-1.5 rounded-[8px] bg-[var(--acc)] px-2.5 py-1 text-[12px] font-semibold text-[var(--acc-ink)] opacity-70"
                  >
                    <RefreshCw size={13} aria-hidden="true" className="animate-spin" />
                    Downloading… {dlPct}%
                    {dl && dl.totalBytes > 0 ? ` (${fmtMb(dl.bytesDownloaded)} / ${fmtMb(dl.totalBytes)})` : ''}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void downloadUpdate()}
                    className="flex items-center gap-1.5 rounded-[8px] bg-[var(--acc)] px-2.5 py-1 text-[12px] font-semibold text-[var(--acc-ink)]"
                  >
                    <Download size={13} aria-hidden="true" /> Download {v.updateInfo.version}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      v.updateInfo?.notesUrl || 'https://github.com/adamcongdon/privacy-screen/releases',
                      '_blank',
                      'noopener',
                    )
                  }
                  className="flex items-center gap-1.5 rounded-[8px] border border-border bg-transparent px-2.5 py-1 text-[12px] font-medium text-text-dim hover:bg-surface-2"
                >
                  Release notes
                </button>
              </div>
              {downloadedReady && canAutoApply && (
                <span className="text-[11px] text-text-faint">
                  Verified (SHA-256). The app swaps the binary and relaunches.
                </span>
              )}
              {dl?.error && (
                <span className="text-[11px]" style={{ color: 'var(--danger)' }}>
                  Download failed: {dl.error}
                </span>
              )}
            </div>
          )}
          {cfg.showActions === 'notfound' && channel === 'stable' && (
            <button
              type="button"
              onClick={() => onChannel('beta')}
              className="mt-2 flex items-center gap-1.5 rounded-[8px] border border-border bg-transparent px-2.5 py-1 text-[12px] font-medium text-text-dim hover:bg-surface-2"
            >
              <ArrowRight size={13} aria-hidden="true" /> Switch to Beta
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DataPrivacyCard(): JSX.Element {
  const vocab = useStore((s) => s.vocab);
  const forgetVocab = useStore((s) => s.forgetVocab);
  const pushToast = useStore((s) => s.pushToast);
  const [clearing, setClearing] = useState(false);

  // No dedicated clear-vocab endpoint exists; we drive the REAL per-value forget
  // action over every persisted row. forgetVocab refreshes vocab + scrub itself,
  // so the chip lists / tables update as each row drops.
  const onClear = async () => {
    if (vocab.length === 0) {
      pushToast('info', 'Vocabulary is already empty.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Forget all ${vocab.length} stored value${vocab.length === 1 ? '' : 's'}? This cannot be undone.`)
    ) {
      return;
    }
    setClearing(true);
    try {
      // Snapshot the real values first — the list mutates under us as we forget.
      const values = vocab.map((v) => v.real_value);
      for (const value of values) {
        // eslint-disable-next-line no-await-in-loop -- sequential keeps the
        // server's per-value delete + re-scrub deterministic; the set is small.
        await forgetVocab(value);
      }
      pushToast('success', `Cleared ${values.length} value${values.length === 1 ? '' : 's'}.`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card icon={Lock} title="Data &amp; privacy">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] leading-[1.4] text-text-dim">
          Vocabulary database
          <br />
          <span className="font-mono text-[11px] text-text-faint">~/.privacy-screen/vocab.db</span>
        </span>
        <button
          type="button"
          onClick={() => void onClear()}
          disabled={clearing}
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            background: 'var(--danger-bg)',
            color: 'var(--danger)',
            borderColor: 'var(--danger-border)',
          }}
        >
          {clearing ? (
            <AlertTriangle size={13} aria-hidden="true" />
          ) : (
            <Trash2 size={13} aria-hidden="true" />
          )}
          {clearing ? 'Clearing…' : 'Clear vocab'}
        </button>
      </div>
    </Card>
  );
}

export function SettingsPage(): JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-[300px] flex-1 flex-col gap-4">
        <ScreeningModeCard />
        <CustomerNamesCard />
      </div>
      <div className="flex min-w-[300px] flex-1 flex-col gap-4">
        <JudgeCard />
        <UpdatesCard />
        <DataPrivacyCard />
      </div>
    </div>
  );
}
