/**
 * Modal dialog for the "Custom…" menu item — user types a category name
 * (e.g. PRODUCT, REGION) and we mint the selected span under it.
 *
 * Validation matches the server: /^[A-Z][A-Z0-9_]{1,15}$/ (uppercase letters,
 * digits, underscores, must start with a letter, 2–16 chars). The category we
 * send to the API is lowercased so it matches the server's category regex
 * /^[a-z][a-z0-9_]{0,15}$/.
 */

import { useEffect, useRef, useState } from 'react';
import { useContextMenu } from '../lib/useContextMenu';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import { truncate } from '../lib/truncate';

const VALID = /^[A-Z][A-Z0-9_]{1,15}$/;

export function CustomCategoryDialog(): JSX.Element | null {
  const open = useContextMenu((s) => s.customDialogOpen);
  const selectedText = useContextMenu((s) => s.selectedText);
  const close = useContextMenu((s) => s.closeCustomDialog);
  const mintSelection = useStore((s) => s.mintSelection);

  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset value each time the dialog opens.
  useEffect(() => {
    if (open) {
      setValue('');
      // autoFocus prop sometimes loses to other components; do it explicitly.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const trimmed = value.trim();
  const valid = VALID.test(trimmed);

  function submit(e?: React.FormEvent): void {
    if (e) e.preventDefault();
    if (!valid) return;
    void mintSelection(selectedText, trimmed.toLowerCase());
    close();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mint as custom category"
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-32"
      onMouseDown={(e) => {
        // Click on backdrop closes; click in panel doesn't bubble here.
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        onSubmit={submit}
        className="w-[420px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
      >
        <h3 className="text-sm font-semibold text-zinc-100">Mint as custom category</h3>
        <p className="mt-1 text-xs text-zinc-400">
          Selected: <span className="font-mono text-zinc-200">{truncate(selectedText, 60)}</span>
        </p>
        <label className="mt-3 block text-[11px] uppercase tracking-wider text-zinc-500">
          Category (UPPER_SNAKE)
        </label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          onKeyDown={onKey}
          placeholder="e.g. PRODUCT, REGION"
          className={cn(
            'mt-1 w-full rounded-md border bg-zinc-950 px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2',
            trimmed.length === 0 || valid
              ? 'border-zinc-700 focus:ring-indigo-500/40'
              : 'border-red-700 focus:ring-red-500/40',
          )}
          spellCheck={false}
          autoComplete="off"
          maxLength={16}
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          2–16 chars · starts with a letter · A–Z, 0–9, _ only
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs font-semibold',
              valid
                ? 'border-indigo-700 bg-indigo-600 text-white hover:bg-indigo-500'
                : 'cursor-not-allowed border-zinc-800 bg-zinc-800 text-zinc-500',
            )}
          >
            Mint
          </button>
        </div>
      </form>
    </div>
  );
}

