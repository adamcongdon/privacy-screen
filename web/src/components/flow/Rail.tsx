/**
 * Flow navigation rail — ported from `design_handoff_flow_redesign/reference/flow-chrome.jsx`
 * (`FlowRail`). Fixed 80px left rail: brand tile, vertical icon+label nav items,
 * and a bottom cluster (theme toggle, Settings, AC avatar).
 *
 * State comes from the Zustand store (Engineer-A): `route`/`setRoute`,
 * `theme`/`setTheme`, and `reviewItems` (Review badge = pending count).
 *
 * Accessibility:
 *   - active nav item carries `aria-current="page"`
 *   - icon-only / icon+label buttons get an explicit `aria-label`
 *   - disabled (roadmap) items are real `<button disabled>` so they are
 *     keyboard-skippable and never invoke `setRoute`
 *
 * Tokens only — no `zinc-*` or hard-coded hex. Active styling uses the
 * `--acc` / `--acc-tint` custom properties surfaced through Tailwind by A.
 */
import type { ComponentType, ReactNode } from 'react';
import {
  Shield,
  ScanLine,
  Flag,
  BookOpen,
  History,
  MessageSquare,
  Settings as SettingsIcon,
  Sun,
  Moon,
  MessageCircle,
  type LucideProps,
} from 'lucide-react';
import { useStore, type Route } from '../../store';

type NavItem = {
  id: Route;
  label: string;
  Icon: ComponentType<LucideProps>;
  /** Roadmap items render disabled with a "SOON" caption. */
  soon?: boolean;
  /** When true, show the pending-review numeric badge on the icon. */
  badge?: boolean;
};

/** Primary nav order — matches the reference rail exactly. */
const NAV_ITEMS: NavItem[] = [
  { id: 'scrub', label: 'Scrub', Icon: ScanLine },
  { id: 'review', label: 'Review', Icon: Flag, badge: true },
  { id: 'vocab', label: 'Vocab', Icon: BookOpen },
  { id: 'history', label: 'History', Icon: History, soon: true },
  { id: 'chat', label: 'Chat', Icon: MessageSquare, soon: true },
];

export function Rail(): JSX.Element {
  const route = useStore((s) => s.route);
  const setRoute = useStore((s) => s.setRoute);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const reviewCount = useStore((s) => s.reviewItems.length);
  const setFeedbackOpen = useStore((s) => s.setFeedbackOpen);

  return (
    <nav
      aria-label="Primary"
      className="flex w-20 flex-none flex-col gap-1 border-r border-border bg-surface px-[9px] py-3"
    >
      {/* Brand tile — 42×42, accent bg, shield, radius 12. */}
      <div
        className="mx-auto mb-3 mt-0.5 grid h-[42px] w-[42px] place-items-center rounded-xl bg-acc"
        aria-hidden="true"
      >
        <Shield size={23} strokeWidth={1.9} color="var(--acc-ink)" />
      </div>

      {NAV_ITEMS.map((it) => (
        <RailItem
          key={it.id}
          item={it}
          active={route === it.id}
          badgeCount={it.badge ? reviewCount : 0}
          onSelect={it.soon ? undefined : () => setRoute(it.id)}
        />
      ))}

      {/* Pushes the bottom cluster to the foot of the rail. */}
      <div className="flex-1" />

      {/* Feedback — matches handoff spec (bottom group above theme). */}
      <RailButton
        label="Send feedback"
        caption="Feedback"
        onClick={() => setFeedbackOpen(true)}
      >
        <MessageCircle size={20} />
      </RailButton>

      {/* Theme toggle — sun when light, moon when dark. */}
      <RailButton
        label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        caption={theme === 'dark' ? 'Light' : 'Dark'}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </RailButton>

      {/* Settings nav item — full-width route, like the primary items. */}
      <RailItem
        item={{ id: 'settings', label: 'Settings', Icon: SettingsIcon }}
        active={route === 'settings'}
        badgeCount={0}
        onSelect={() => setRoute('settings')}
      />

      {/* User avatar — non-interactive placeholder. */}
      <div
        className="mx-auto mt-1.5 grid h-[34px] w-[34px] place-items-center rounded-full border border-border bg-surface-3 text-xs font-semibold text-text-dim"
        aria-hidden="true"
      >
        AC
      </div>
    </nav>
  );
}

/** Base styling shared by every rail control. */
const RAIL_ITEM_BASE =
  'relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-semibold transition-colors';

function railItemClasses(active: boolean, disabled: boolean): string {
  if (disabled) return `${RAIL_ITEM_BASE} cursor-default text-text-faint opacity-50`;
  if (active) return `${RAIL_ITEM_BASE} bg-acc-tint text-acc`;
  return `${RAIL_ITEM_BASE} text-text-dim hover:bg-surface-2 hover:text-text`;
}

function RailItem({
  item,
  active,
  badgeCount,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  badgeCount: number;
  onSelect?: () => void;
}): JSX.Element {
  const { Icon, label, soon } = item;
  return (
    <button
      type="button"
      disabled={soon}
      aria-current={active ? 'page' : undefined}
      aria-label={soon ? `${label} — coming soon` : label}
      onClick={onSelect}
      className={railItemClasses(active, !!soon)}
    >
      {/* 3px accent indicator bar on the active item's left edge. */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-acc"
        />
      )}
      <span className="relative">
        <Icon size={21} />
        {badgeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-1.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg bg-warn px-[3px] text-[9.5px] font-bold text-bg"
          >
            {badgeCount}
          </span>
        )}
      </span>
      <span>{label}</span>
      {soon && (
        <span className="text-[8px] tracking-[0.06em] text-text-faint">SOON</span>
      )}
    </button>
  );
}

/** Icon+caption action button (theme toggle) — not a route, so no aria-current. */
function RailButton({
  label,
  caption,
  onClick,
  children,
}: {
  label: string;
  caption: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={railItemClasses(false, false)}
    >
      <span className="relative">{children}</span>
      <span>{caption}</span>
    </button>
  );
}
