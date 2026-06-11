/**
 * Right-click TokenizeMenu (handoff feature 1).
 *
 * Full rich menu per ADDENDUM + flow-extras.jsx: ps-panel, clamped, header with
 * "TOKENIZE SELECTION AS" + selection preview, scrollable list of all categories
 * (built-in + custom) with color dot + label + {TOKEN} example, "custom" badge,
 * divider, green "+ New category…" that pre-seeds the custom dialog.
 *
 * Triggered from ScrubSend textarea onContextMenu (selection-aware).
 * Also supports the keyboard shortcuts via useContextMenuShortcuts.
 */

import { useEffect, useRef } from 'react';
import { useContextMenu } from '../lib/useContextMenu';
import { truncate } from '../lib/truncate';
import { useStore } from '../store';
import { CATS, categoryLabel } from '../lib/categories';
import { getCategoryHue } from '../lib/colors';

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
const mod = isMac ? '⌘' : 'Ctrl';
const shift = isMac ? '⇧' : 'Shift';

function shortcutLabel(letter: string): string {
  return isMac ? `${shift}${mod}${letter}` : `${mod}+${shift}+${letter}`;
}

export function ContextMenu(): JSX.Element | null {
  const open = useContextMenu((s) => s.open);
  const x = useContextMenu((s) => s.x);
  const y = useContextMenu((s) => s.y);
  const selectedText = useContextMenu((s) => s.selectedText);
  const closeMenu = useContextMenu((s) => s.closeMenu);
  const openCustomDialog = useContextMenu((s) => s.openCustomDialog);
  const addUserPattern = useStore((s) => s.addUserPattern);
  const customCategories = useStore((s) => s.customCategories);

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      closeMenu();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeMenu]);

  if (!open) return null;

  const preview = selectedText.length > 28 ? selectedText.slice(0, 27) + '…' : selectedText;

  // Build dynamic list: built-ins (except credential) + customs.
  const catEntries: Array<{ cat: string; label: string; color: string; isCustom: boolean }> = [];
  for (const [key, meta] of Object.entries(CATS)) {
    if (key === 'credential') continue;
    catEntries.push({ cat: key, label: meta.label, color: meta.hue, isCustom: false });
  }
  for (const c of customCategories) {
    catEntries.push({ cat: c.id, label: c.label, color: c.color, isCustom: true });
  }

  function pick(cat: string) {
    void addUserPattern(selectedText, cat);
    closeMenu();
  }

  function newCat() {
    closeMenu();
    openCustomDialog(selectedText);
  }

  // Clamp to viewport (8-10px margin per spec).
  const WIDTH = 248;
  const MAX_HEIGHT = 248;
  const MARGIN = 10;
  const left = Math.max(MARGIN, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 2000) - WIDTH - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 2000) - 120 - MARGIN));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Tokenize selection as"
      style={{ left, top, width: WIDTH, background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}
      className="fixed z-[70] rounded-xl p-1.5 text-[13px] text-text"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-text-faint">
          <span>✦</span>
          <span>TOKENIZE SELECTION AS</span>
        </div>
        <div className="ps-mono mt-0.5 truncate text-[12px] text-text" title={selectedText}>
          “{preview}”
        </div>
      </div>

      <div className="my-1 h-px bg-[var(--hairline)]" />

      {/* Scrollable category list */}
      <div className="max-h-[248px] overflow-auto py-1">
        {catEntries.map((entry) => {
          const tokenExample = '{' + entry.label.toUpperCase().replace(/\s+/g, '') + '_1}';
          return (
            <button
              key={entry.cat}
              role="menuitem"
              type="button"
              onClick={() => pick(entry.cat)}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
            >
              <span
                className="inline-block h-2 w-2 flex-none rounded-sm"
                style={{ background: entry.color }}
              />
              <span className="flex-1 truncate text-[13px]">{entry.label}</span>
              {entry.isCustom && (
                <span className="rounded px-1 text-[9.5px] font-medium" style={{ background: 'var(--acc-tint)', color: 'var(--acc)' }}>
                  custom
                </span>
              )}
              <span className="ps-mono text-[10.5px] text-text-faint">{tokenExample}</span>
            </button>
          );
        })}
      </div>

      <div className="my-1 h-px bg-[var(--hairline)]" />

      {/* New category entry (green accent per spec) */}
      <button
        role="menuitem"
        type="button"
        onClick={newCat}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[var(--acc)] hover:bg-acc-tint/40 focus:bg-acc-tint/40 focus:outline-none"
      >
        <span className="text-lg leading-none">+</span>
        <span className="font-semibold">New category…</span>
      </button>
    </div>
  );
}

