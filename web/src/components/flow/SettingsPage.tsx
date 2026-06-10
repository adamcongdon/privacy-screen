/**
 * Flow screen 4 — Settings. Promotes components/SettingsDrawer.tsx to a full
 * page, wired to the REAL store/API. Mirrors the SettingsDrawer logic for every
 * section that has working API wiring.
 *
 * Reused logic / store surface (verified against store.ts + api.ts):
 *   - Screening mode  → store.mode / store.setMode  (CLIENT-SIDE ONLY — there is
 *       no /api/settings mode field; setMode re-runs refreshScrub. See store.ts
 *       ScreenMode docs. We do NOT fabricate an API call.)
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
  type LucideIcon,
} from 'lucide-react';
import { useStore } from '../../store';
import type { ScreenMode } from '../../store';

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
  return (
    <Card icon={Zap} title="Screening mode" accent>
      <div role="radiogroup" aria-label="Screening mode" className="flex flex-col gap-2">
        {MODE_ROWS.map((row) => {
          const on = mode === row.id;
          return (
            <button
              key={row.id}
              type="button"
              role="radio"
              aria-checked={on}
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

function UpdatesCard(): JSX.Element {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const versionInfo = useStore((s) => s.versionInfo);
  const refreshVersion = useStore((s) => s.refreshVersion);
  const refreshUpdateStatus = useStore((s) => s.refreshUpdateStatus);
  const pushToast = useStore((s) => s.pushToast);

  const channel: Channel = (settings?.update_channel ?? 'off') as Channel;

  const onChannel = (c: Channel) => {
    if (c === channel) return;
    // Persist the channel through the real settings API (mirrors SettingsDrawer).
    void saveSettings({ update_channel: c }).then(() => {
      setTimeout(() => {
        void refreshVersion();
        void refreshUpdateStatus();
      }, 120);
    });
  };

  const onCheck = async () => {
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
  };

  const version = versionInfo?.version ?? '…';
  const upToDate = !versionInfo?.updateAvailable;

  return (
    <Card
      icon={RefreshCw}
      title="Updates"
      description="Opt-in. No telemetry; SHA-256 verified before any swap."
    >
      <div className="mb-3 flex items-center gap-2.5">
        <div
          role="radiogroup"
          aria-label="Update channel"
          className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
        >
          {CHANNELS.map((c) => {
            const active = channel === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChannel(c)}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors"
                style={active ? { background: 'var(--acc-tint)', color: 'var(--acc)' } : { color: 'var(--text-dim)' }}
              >
                {c}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void onCheck()}
          disabled={channel === 'off'}
          className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12px] font-medium text-text-dim hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          title={channel === 'off' ? 'Pick a channel to check for updates' : 'Check for updates now'}
        >
          <RefreshCw size={13} aria-hidden="true" /> Check now
        </button>
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-text-dim">
          On <span className="font-mono">{version}</span>
        </span>
        <span className="text-text-faint">·</span>
        {channel === 'off' ? (
          <span className="text-text-faint">Update checks off</span>
        ) : (
          <span style={{ color: upToDate ? 'var(--ok)' : 'var(--warn)' }}>
            {upToDate ? 'Up to date' : `Update available: ${versionInfo?.updateInfo?.version ?? ''}`}
          </span>
        )}
      </div>
    </Card>
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
