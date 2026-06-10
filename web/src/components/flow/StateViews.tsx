/**
 * Flow screen 6 — Empty & error states. Ported from
 * `design_handoff_flow_redesign/reference/states.jsx`. These are small,
 * composable views the REAL screens render inline (not separate routes):
 *
 *   - EmptyTextPlaceholder / EmptySafePlaceholder — idle Scrub panels.
 *     (ScrubSend already renders its own empty branch — these are exported for
 *     reuse / future composition and to keep the empty copy in one place.)
 *   - ClaudeNotFound — full error replacing the old red corner note in App.tsx.
 *   - ServerOffline  — health.ok === false banner with a Retry re-check.
 *
 * Accessibility (hard requirement, README §Accessibility):
 *   - status carried by icon + WORD, never color alone.
 *   - icon-only / action buttons get aria-labels; focus ring is inherited from
 *     the global `*:focus-visible` rule (never removed here).
 *   - error containers use role="alert" / role="status" as appropriate.
 *
 * Tokens only — no `zinc-*` or hard-coded hex outside the CSS variables.
 */
import { FileText, Shield, AlertTriangle, X, RefreshCw, Zap, ExternalLink } from 'lucide-react';
import { useStore } from '../../store';

/** Docs URL for the Claude Code install guide. */
const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code';

/**
 * Idle placeholder for the LEFT (input) panel — "Paste, type, or drop a file".
 * Dashed inset, centered icon + label. Exported for reuse; ScrubSend currently
 * renders the live textarea instead (no duplication — this is the empty-canvas
 * variant for any screen that wants it).
 */
export function EmptyTextPlaceholder(): JSX.Element {
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center rounded-[10px] border border-dashed border-border"
      role="status"
    >
      <div className="flex flex-col items-center gap-2 text-text-faint">
        <FileText size={22} aria-hidden="true" />
        <span className="text-[12px]">Paste, type, or drop a file</span>
      </div>
    </div>
  );
}

/**
 * Idle placeholder for the RIGHT (safe-to-send) panel — "Nothing to scrub yet".
 * Centered shield tile + reassurance copy. Exported for reuse.
 */
export function EmptySafePlaceholder(): JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 place-items-center" role="status">
      <div className="flex max-w-[220px] flex-col items-center gap-2.5 text-center">
        <div
          className="grid h-11 w-11 place-items-center rounded-xl"
          style={{ background: 'var(--acc-tint)' }}
        >
          <Shield size={22} color="var(--acc)" aria-hidden="true" />
        </div>
        <span className="text-[13px] font-semibold text-text">Nothing to scrub yet</span>
        <span className="text-[11.5px] leading-relaxed text-text-faint">
          Tokens will appear here as soon as you add text. Real values never leave this machine.
        </span>
      </div>
    </div>
  );
}

/**
 * Claude-not-found full error. Replaces the old red corner note in App.tsx.
 * Renders the `claude --version` / `claude login` instructions and a Re-check
 * button wired to the real `refreshSettings` + `refreshHealth` so the user can
 * re-detect the CLI after installing/logging in. An Install-guide link opens the
 * docs. Gate on `!settings.claude_code.found` at the call site.
 */
export function ClaudeNotFound(): JSX.Element {
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshHealth = useStore((s) => s.refreshHealth);
  const version = useStore((s) => s.settings?.claude_code.version);

  const onRecheck = (): void => {
    void refreshSettings();
    void refreshHealth();
  };

  return (
    <div
      className="grid min-h-0 flex-1 place-items-center p-6"
      role="alert"
    >
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        <div
          className="grid h-[50px] w-[50px] place-items-center rounded-[14px] border"
          style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
        >
          <AlertTriangle size={26} color="var(--danger)" aria-hidden="true" />
        </div>
        <span className="text-[17px] font-semibold text-text">
          Claude Code not found on PATH
        </span>
        <p className="m-0 text-[12.5px] leading-relaxed text-text-dim">
          Inference runs through your local <span className="font-mono">claude</span> CLI — the
          server won&apos;t send anything until it&apos;s installed and logged in.
        </p>
        <div
          className="w-full rounded-[10px] px-3 py-2.5 text-left font-mono text-[11.5px] text-text-dim"
          style={{ background: 'var(--surface-2)' }}
        >
          <div>
            $ claude --version <span className="text-text-faint"># 2.x required</span>
          </div>
          <div>$ claude login</div>
          {version && <div className="text-text-faint">detected: {version}</div>}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={onRecheck}
            aria-label="Re-check for Claude Code"
            className="flex h-[30px] items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-[12px] font-medium text-text hover:bg-surface-3"
          >
            <RefreshCw size={13} aria-hidden="true" /> Re-check
          </button>
          <a
            href={CLAUDE_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold"
            style={{ background: 'var(--acc)', color: 'var(--acc-ink)' }}
          >
            <ExternalLink size={13} aria-hidden="true" /> Install guide
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Server-offline banner. Rendered when `health.ok === false` (local server
 * unreachable). Scrubbing still works on-device, so this is a non-blocking
 * banner with a Retry that re-checks health. Status carried by icon + the word
 * "Offline" (no color-alone).
 */
export function ServerOffline(): JSX.Element {
  const refreshHealth = useStore((s) => s.refreshHealth);

  return (
    <div
      role="status"
      className="mx-6 mb-1.5 flex items-center gap-2.5 rounded-[9px] border px-[13px] py-2 text-[12px]"
      style={{
        background: 'var(--warn-tint)',
        borderColor: 'var(--warn)',
        color: 'var(--warn)',
      }}
    >
      <Zap size={14} aria-hidden="true" />
      <span className="font-semibold">Offline</span>
      <span className="font-medium text-text-dim">
        Local server unreachable. Scrubbing still works on-device.
      </span>
      <button
        type="button"
        onClick={() => void refreshHealth()}
        aria-label="Retry connection to the local server"
        className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-text hover:bg-surface-2"
      >
        <RefreshCw size={13} aria-hidden="true" /> Retry
      </button>
    </div>
  );
}
