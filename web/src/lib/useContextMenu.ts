/**
 * Context-menu state for the "mint this selection as ___" UX.
 *
 * Global singleton via Zustand so a context-menu opened on the Composer can be
 * dismissed by a click in the Preview pane and vice-versa. Also owns the
 * keyboard-shortcut listener that lets the user skip the right-click step:
 *   Cmd/Ctrl+Shift+P → person
 *   Cmd/Ctrl+Shift+C → customer
 *   Cmd/Ctrl+Shift+H → fqdn (Host)
 *   Cmd/Ctrl+Shift+K → custom category dialog
 *
 * A keyboard shortcut only fires when the current window selection has >=2
 * non-whitespace characters — otherwise it's a no-op (the user clearly didn't
 * mean to mint anything). We always preventDefault on a matching shortcut so
 * browser print/save bindings don't intercept.
 */

import { create } from 'zustand';
import { useEffect } from 'react';
import { useStore } from '../store';

type MenuState = {
  open: boolean;
  x: number;
  y: number;
  selectedText: string;
  customDialogOpen: boolean;
  openMenu: (x: number, y: number, text: string) => void;
  closeMenu: () => void;
  openCustomDialog: (text: string) => void;
  closeCustomDialog: () => void;
};

export const useContextMenu = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  selectedText: '',
  customDialogOpen: false,
  openMenu: (x, y, text) =>
    set({ open: true, x, y, selectedText: text, customDialogOpen: false }),
  closeMenu: () => set({ open: false }),
  openCustomDialog: (text) =>
    set({ customDialogOpen: true, open: false, selectedText: text }),
  closeCustomDialog: () => set({ customDialogOpen: false }),
}));

/**
 * Install the global keyboard shortcut listener once, at app boot.
 * Mounted inside <App/> so the listener tracks the app's lifecycle.
 */
export function useContextMenuShortcuts(): void {
  const openCustomDialog = useContextMenu((s) => s.openCustomDialog);
  const mintSelection = useStore((s) => s.mintSelection);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'p' && k !== 'c' && k !== 'h' && k !== 'k') return;

      const sel = window.getSelection()?.toString().trim() ?? '';
      if (sel.length < 2) return;

      e.preventDefault();
      if (k === 'p') void mintSelection(sel, 'person');
      else if (k === 'c') void mintSelection(sel, 'customer');
      else if (k === 'h') void mintSelection(sel, 'fqdn');
      else if (k === 'k') openCustomDialog(sel);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCustomDialog, mintSelection]);
}
