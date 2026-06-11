/**
 * NewCategoryModal (handoff feature 3 + entry from TokenizeMenu).
 *
 * Name input + case-insensitive dup validation, curated color swatches (first unused default),
 * live preview pill {NAME_1}, Create disabled until valid+unique.
 * If opened with seedSelection (from "New category…" in tokenize menu), it pre-seeds
 * and will also tokenize that text under the new category on create.
 *
 * Persists via store.createCustomCategory → /api/settings + custom_categories in config.
 */

import { useEffect, useRef, useState } from 'react';
import { useContextMenu } from '../lib/useContextMenu';
import { useStore } from '../store';
import { cn } from '../lib/cn';
import { truncate } from '../lib/truncate';
import * as Dialog from '@radix-ui/react-dialog';

const CAT_SWATCHES = [
  '#e879f9', '#38bdf8', '#34d399', '#a3e635', '#fbbf24',
  '#fb7185', '#f472b6', '#c084fc', '#5eead4', '#fca5a5',
];

export function CustomCategoryDialog(): JSX.Element | null {
  const open = useContextMenu((s) => s.customDialogOpen);
  const selectedText = useContextMenu((s) => s.selectedText);
  const close = useContextMenu((s) => s.closeCustomDialog);
  const createCustomCategory = useStore((s) => s.createCustomCategory);
  const customCategories = useStore((s) => s.customCategories);

  const [label, setLabel] = useState('');
  const [color, setColor] = useState(CAT_SWATCHES[0]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + pick first unused color on open. Seed from selectedText if present.
  useEffect(() => {
    if (!open) return;
    setLabel('');
    const used = new Set(customCategories.map((c) => c.color));
    const firstFree = CAT_SWATCHES.find((s) => !used.has(s)) || CAT_SWATCHES[0];
    setColor(firstFree);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, customCategories]);

  const trimmed = label.trim();
  const exists = customCategories.some(
    (c) => c.label.toLowerCase() === trimmed.toLowerCase(),
  );
  const valid = trimmed.length > 0 && !exists;

  const previewToken = '{' + (trimmed || 'CATEGORY').toUpperCase().replace(/\s+/g, '') + '_1}';

  function submit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!valid) return;
    void createCustomCategory(trimmed, color, selectedText || undefined);
    close();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  // Render through Radix Dialog (provides focus trap + focus restore on close).
  // Replaces plain role=dialog; keyboard Tab now cannot escape the modal (per #91 acceptance).
  // Backdrop click + Escape still close via onOpenChange.
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[80] bg-black/55 backdrop-blur-[2px]"
          onClick={close}
        />
        <Dialog.Content
          className="ps-panel w-[min(440px,calc(100%-32px))]"
          style={{ background: 'var(--surface)', boxShadow: 'var(--shadow)' }}
          aria-label="New token category"
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-3">
              <div
                className="grid h-8 w-8 place-items-center rounded-lg"
                style={{ background: 'var(--acc-tint)' }}
              >
                <span style={{ color: 'var(--acc)' }}>🏷︎</span>
              </div>
              <div>
                <div className="text-[15px] font-semibold">New token category</div>
                <div className="text-[11.5px] text-text-faint">A named class for values you want scrubbed.</div>
              </div>
            </div>
            <button onClick={close} aria-label="Close" className="px-2 text-text-faint hover:text-text">✕</button>
          </div>

          <div className="space-y-4 p-4">
            {selectedText && (
              <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-[12px] text-text-faint">
                Will tokenize <span className="ps-mono text-text">“{truncate(selectedText, 48)}”</span> with this category.
              </div>
            )}

            {/* Name */}
            <div>
              <div className="ps-eyebrow mb-1.5">Name</div>
              <input
                ref={inputRef}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={onKey}
                placeholder="e.g. Project codename, Asset tag, Case ID"
                className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-[var(--acc)]"
              />
              {exists && <div className="mt-1 text-[11.5px] text-danger">A category with that name already exists.</div>}
            </div>

            {/* Colors */}
            <div>
              <div className="ps-eyebrow mb-1.5">Color</div>
              <div className="flex flex-wrap gap-2">
                {CAT_SWATCHES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-label={`Color ${s}`}
                    onClick={() => setColor(s)}
                    className="h-6 w-6 rounded-md border"
                    style={{
                      background: s,
                      borderColor: color === s ? 'var(--text)' : 'transparent',
                      outline: color === s ? '1px solid var(--text)' : 'none',
                      outlineOffset: 1,
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Live preview */}
            <div>
              <div className="ps-eyebrow mb-1.5">Preview</div>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-3">
                <span
                  className="ps-pill"
                  style={{ '--cat': color } as React.CSSProperties}
                >
                  <span className="ps-pilldot" />
                  {previewToken}
                </span>
                <span className="text-[11.5px] text-text-faint">
                  Tokens in this class render with this dot &amp; color.
                </span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border bg-transparent px-3 py-1.5 text-[12px] text-text-dim hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!valid}
              onClick={submit}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: valid ? 'var(--acc)' : 'var(--surface-2)', color: valid ? 'var(--acc-ink)' : 'var(--text-faint)' }}
            >
              + Create category
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

