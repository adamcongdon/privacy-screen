/**
 * Flow screen shell — ported from `design_handoff_flow_redesign/reference/flow-chrome.jsx`
 * (`FlowShell`). Renders the per-screen header (title + subtitle + right-slot
 * controls), an optional local-first trust band, and a scrollable body region.
 *
 * The shell does NOT render the rail — App composes `<Rail/>` alongside the
 * routed `<Shell/>` so a single rail persists across route changes.
 *
 * Tokens only — no `zinc-*` or hard-coded hex.
 */
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';

/** Exact trust-band copy from the handoff spec. */
const TRUST_COPY =
  'Local-first — real values never leave this machine. Only stable tokens are sent to Claude.';

export function Shell({
  title,
  subtitle,
  headerRight,
  trust = false,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Per-screen controls rendered on the right of the header. */
  headerRight?: ReactNode;
  /** Show the local-first trust band under the header (Scrub / optionally Review). */
  trust?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-[15px]">
        <div className="flex flex-col gap-[3px]">
          <span className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-text">
            {title}
          </span>
          {subtitle && (
            <span className="text-[12.5px] text-text-dim">{subtitle}</span>
          )}
        </div>
        {headerRight && <div className="flex items-center gap-2.5">{headerRight}</div>}
      </header>

      {trust && (
        <div
          role="note"
          className="mx-6 mb-1.5 flex items-center gap-2 rounded-[9px] bg-acc-tint px-[13px] py-2 text-[12px] font-medium text-acc"
        >
          <Lock size={14} aria-hidden="true" />
          <span>{TRUST_COPY}</span>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
