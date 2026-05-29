/**
 * Right-click context menu for the "mint this selection" UX.
 *
 * Rendered once at the App level. Visible only when useContextMenu.open is true.
 * Items: Person / Customer / Host / Custom… — each with its platform-aware
 * keyboard shortcut hint. Dismisses on outside click or Escape.
 */

import { useEffect, useRef } from 'react';
import { useContextMenu } from '../lib/useContextMenu';
import { useStore } from '../store';

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
const mod = isMac ? '⌘' : 'Ctrl'; // ⌘ on mac, "Ctrl" elsewhere
const shift = isMac ? '⇧' : 'Shift';
const sep = isMac ? '' : '+';

function shortcutLabel(letter: string): string {
  return isMac ? `${shift}${mod}${letter}` : `${mod}+${shift}+${letter}`;
}

type ItemDef =
  | { kind: 'mint'; label: string; letter: string; category: string }
  | { kind: 'custom'; label: string; letter: string };

const ITEMS: ItemDef[] = [
  { kind: 'mint', label: 'Person', letter: 'P', category: 'person' },
  { kind: 'mint', label: 'Customer', letter: 'C', category: 'customer' },
  { kind: 'mint', label: 'Host', letter: 'H', category: 'fqdn' },
  { kind: 'custom', label: 'Custom…', letter: 'K' },
];

export function ContextMenu(): JSX.Element | null {
  const open = useContextMenu((s) => s.open);
  const x = useContextMenu((s) => s.x);
  const y = useContextMenu((s) => s.y);
  const selectedText = useContextMenu((s) => s.selectedText);
  const closeMenu = useContextMenu((s) => s.closeMenu);
  const openCustomDialog = useContextMenu((s) => s.openCustomDialog);
  const mintSelection = useStore((s) => s.mintSelection);

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
    // mousedown so we fire before the click event reaches the textarea.
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeMenu]);

  if (!open) return null;

  function handleClick(item: ItemDef): void {
    if (item.kind === 'mint') {
      void mintSelection(selectedText, item.category);
      closeMenu();
    } else {
      openCustomDialog(selectedText);
    }
  }

  // Clamp position so the menu doesn't render off-screen.
  const WIDTH = 220;
  const HEIGHT = 170;
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - WIDTH - 8);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - HEIGHT - 8);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Mint selected text"
      style={{ left, top, width: WIDTH }}
      className="fixed z-[60] rounded-md border border-zinc-700 bg-zinc-900/95 py-1 text-xs text-zinc-100 shadow-lg backdrop-blur-sm"
    >
      <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        Mint &quot;{truncate(selectedText, 24)}&quot; as…
      </div>
      {ITEMS.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          type="button"
          onClick={() => handleClick(item)}
          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none"
        >
          <span>{item.label}</span>
          <span className="font-mono text-[10px] text-zinc-500">
            {shortcutLabel(item.letter)}
          </span>
        </button>
      ))}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
