/**
 * Flow screen 5 — Onboarding / first-run. Ported from
 * `design_handoff_flow_redesign/reference/onboarding.jsx`, wired to the REAL
 * store: the readiness checklist reflects `settings.claude_code.found/.version`,
 * the Re-check button calls the real `refreshSettings` + `refreshHealth`, and
 * Continue sets the first-run gate (`store.setOnboarded(true)` → persists
 * `localStorage('ps-onboarded')`).
 *
 * Gate (App.tsx): rendered as a full-screen overlay while `!onboarded`. Continue
 * dismisses it. Continue is only enabled once Claude Code is detected — the user
 * shouldn't proceed into the app before the CLI the server depends on is ready.
 *
 * Accessibility (README §Accessibility):
 *   - the 3-step header is a real ordered list; the checklist carries state by
 *     icon + WORD ("Ready" / "Action needed"), never color alone.
 *   - Continue is a real <button> with an explicit disabled+title when gated.
 *   - focus ring inherited from the global `*:focus-visible` rule.
 */
import { Shield, Check, Lock, AlertTriangle, RefreshCw, ArrowRight } from 'lucide-react';
import { useStore } from '../../store';
import * as Dialog from '@radix-ui/react-dialog';

/** One step in the 3-step header (Connect · Choose mode · Safety check). */
function Step({
  n,
  label,
  done,
  active,
}: {
  n: number;
  label: string;
  done?: boolean;
  active?: boolean;
}): JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <span
        className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[11px] font-bold"
        style={{
          background: done ? 'var(--acc)' : active ? 'var(--acc-tint)' : 'var(--surface-3)',
          color: done ? 'var(--acc-ink)' : active ? 'var(--acc)' : 'var(--text-faint)',
          border: active ? '1px solid var(--acc)' : '1px solid transparent',
        }}
        aria-hidden="true"
      >
        {done ? <Check size={13} color="var(--acc-ink)" strokeWidth={2.4} /> : n}
      </span>
      <span
        className="text-[12.5px]"
        style={{
          fontWeight: active ? 600 : 500,
          color: done || active ? 'var(--text)' : 'var(--text-faint)',
        }}
      >
        {label}
      </span>
    </li>
  );
}

export function Onboarding(): JSX.Element {
  const theme = useStore((s) => s.theme);
  const found = useStore((s) => s.settings?.claude_code.found);
  const version = useStore((s) => s.settings?.claude_code.version);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const refreshHealth = useStore((s) => s.refreshHealth);
  const setOnboarded = useStore((s) => s.setOnboarded);

  const onRecheck = (): void => {
    void refreshSettings();
    void refreshHealth();
  };

  // Subtle radial-tinted background, tuned per theme (matches the reference).
  const bg =
    theme === 'light'
      ? 'radial-gradient(120% 90% at 50% -10%, #e7f5ee 0%, var(--bg) 55%)'
      : 'radial-gradient(120% 90% at 50% -10%, #16241f 0%, var(--bg) 55%)';

  return (
    <Dialog.Root open={true}>
      <Dialog.Portal>
        {/* Radix Dialog.Content provides the focus trap + restore (for #91).
            The gate is full-viewport; we put the radial bg + grid here so the trap root
            contains all focusables. Escape is intentionally swallowed (no dismiss). */}
        <Dialog.Content
          className="fixed inset-0 z-50 grid place-items-center overflow-auto p-6"
          style={{ background: bg }}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-label="Welcome to Privacy Screen — first-run setup"
          aria-modal="true"
        >
          <div
            className="ps-panel w-[680px] max-w-full"
            style={{ boxShadow: 'var(--shadow)' }}
          >
            {/* steps header */}
            <ol
              className="flex items-center justify-center gap-5 px-[26px] py-4"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <Step n={1} label="Connect" active />
              <span className="text-text-faint" aria-hidden="true">
                ·
              </span>
              <Step n={2} label="Choose mode" />
              <span className="text-text-faint" aria-hidden="true">
                ·
              </span>
              <Step n={3} label="Safety check" />
            </ol>

            <div className="px-10 pb-[34px] pt-[30px]">
              {/* hero */}
              <div className="mb-6 flex flex-col items-center text-center">
                <div
                  className="mb-3.5 grid h-14 w-14 place-items-center rounded-2xl"
                  style={{ background: 'var(--acc)' }}
                >
                  <Shield size={30} color="var(--acc-ink)" strokeWidth={1.8} aria-hidden="true" />
                </div>
                <h1 className="m-0 mb-1.5 text-[23px] font-semibold tracking-[-0.01em] text-text">
                  Welcome to Privacy Screen
                </h1>
                <p className="m-0 max-w-[420px] text-[13.5px] leading-relaxed text-text-dim">
                  A local privacy gate between your prompts and the cloud. Let&apos;s make sure it&apos;s
                  ready — this stays entirely on your machine.
                </p>
              </div>

              {/* readiness checklist */}
              <div className="flex flex-col gap-2.5">
                {/* Claude Code detection — green ready OR not-found variant */}
                {found ? (
                  <div
                    className="flex items-center gap-3 rounded-[10px] p-3"
                    style={{ background: 'var(--ok-tint)' }}
                  >
                    <div className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface">
                      <Check size={17} color="var(--ok)" aria-hidden="true" />
                    </div>
                    <div className="flex flex-1 flex-col">
                      <span className="text-[13px] font-semibold text-text">Claude Code detected</span>
                      <span className="font-mono text-[11.5px] text-text-faint">
                        {version ? `${version} · ` : ''}logged in · inference runs through your local
                        session
                      </span>
                    </div>
                    <span
                      className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                      style={{ background: 'var(--ok-tint)', color: 'var(--ok)' }}
                    >
                      Ready
                    </span>
                  </div>
                ) : (
                  <div
                    className="flex flex-col gap-2.5 rounded-[10px] border p-3"
                    style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger-border)' }}
                    role="alert"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="grid h-8 w-8 flex-none place-items-center rounded-lg"
                        style={{ background: 'var(--surface)' }}
                      >
                        <AlertTriangle size={17} color="var(--danger)" aria-hidden="true" />
                      </div>
                      <div className="flex flex-1 flex-col">
                        <span className="text-[13px] font-semibold text-text">
                          Claude Code not found
                        </span>
                        <span className="text-[11.5px] text-text-dim">
                          Install the <span className="font-mono">claude</span> CLI and log in, then
                          re-check below.
                        </span>
                      </div>
                      <span
                        className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                        style={{ color: 'var(--danger)' }}
                      >
                        Action needed
                      </span>
                    </div>
                    <div
                      className="rounded-lg px-3 py-2 font-mono text-[11.5px] text-text-dim"
                      style={{ background: 'var(--surface)' }}
                    >
                      <div>$ claude --version</div>
                      <div>$ claude login</div>
                    </div>
                    <button
                      type="button"
                      onClick={onRecheck}
                      aria-label="Re-check for Claude Code"
                      className="flex h-[30px] w-fit items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-text hover:bg-surface-2"
                    >
                      <RefreshCw size={13} aria-hidden="true" /> Re-check
                    </button>
                  </div>
                )}

                {/* No API key needed / binds to 127.0.0.1 */}
                <div
                  className="flex items-center gap-3 rounded-[10px] border border-border p-3"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <div className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface">
                    <Lock size={17} className="text-text-dim" aria-hidden="true" />
                  </div>
                  <div className="flex flex-1 flex-col">
                    <span className="text-[13px] font-semibold text-text">No API key needed</span>
                    <span className="text-[11.5px] text-text-faint">
                      Uses the OAuth session you already have. The server binds to 127.0.0.1 only.
                    </span>
                  </div>
                  <span className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-text-dim">
                    <Check size={11} aria-hidden="true" /> Local
                  </span>
                </div>
              </div>

              {/* footer */}
              <div className="mt-[26px] flex items-center justify-between gap-3">
                <span className="text-[11.5px] text-text-faint">
                  You can change everything later in Settings.
                </span>
                <button
                  type="button"
                  onClick={() => setOnboarded(true)}
                  disabled={!found}
                  title={found ? 'Continue into Privacy Screen' : 'Detect Claude Code first to continue'}
                  className="flex items-center gap-1.5 rounded-lg px-5 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ height: 42, background: 'var(--acc)', color: 'var(--acc-ink)' }}
                >
                  Continue <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
