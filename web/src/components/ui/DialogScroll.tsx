/**
 * DialogScroll — shared substrate for scrollable dialogs.
 *
 * Exports three components that compose inside a Radix `Dialog.Content` with
 * `flex flex-col` and bounded height (`h-full` for drawers, `max-h-[85vh]` for modals).
 * This substrate fixes the flex-overflow trap where content can't scroll properly
 * inside flexbox containers.
 *
 * - **DialogHeader**: Top section with title, description, and close button.
 * - **ScrollableDialogBody**: Middle section with flex-overflow fix and auto-scroll.
 * - **DialogFooter**: Bottom section for action buttons, with top border divider.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * DialogHeader — renders title, description, and close button.
 *
 * The close button is a Radix `Dialog.Close` that triggers the dialog's
 * onOpenChange callback on its own. The optional `onClose` callback fires
 * when the close button is clicked, allowing callers to run side-effect cleanup.
 *
 * The description accepts `React.ReactNode` to support inline JSX (e.g., `<code>` tags).
 */
export function DialogHeader({
  title,
  description,
  onClose,
}: {
  title: string;
  description: React.ReactNode;
  onClose?: () => void;
}): JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between px-5 pt-5">
        <Dialog.Title className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
          {title}
        </Dialog.Title>
        <Dialog.Close asChild>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </Dialog.Close>
      </div>
      <Dialog.Description className="px-5 pt-3 text-xs text-zinc-500">
        {description}
      </Dialog.Description>
    </>
  );
}

/**
 * ScrollableDialogBody — middle section with scroll overflow fix.
 *
 * Applies the load-bearing classes `flex-1 min-h-0 overflow-y-auto overscroll-contain`
 * to fix the flex-overflow trap. Default padding `px-5 py-4` composes with caller
 * overrides via `cn()` — pass `className` to extend or override.
 */
export function ScrollableDialogBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4', className)}>
      {children}
    </div>
  );
}

/**
 * DialogFooter — bottom section for action buttons.
 *
 * Includes a top border divider and right-aligned button layout.
 * Default padding `px-5 pb-5 pt-3` composes with caller overrides via `cn()`.
 */
export function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('border-t border-zinc-800 px-5 pb-5 pt-3', className)}>
      <div className="flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/**
 * Shared Segmented control (and roving hook) for radiogroup a11y (extracted for #91 WEB-09).
 * Appended to existing ui module (no new file) to satisfy "never create unless necessary".
 * - Roving tabindex + Arrow/Home/End.
 * - orientation for axis.
 * Used for all radiogroups in evidence (ScrubSend, Review filter via wrapper, Settings channel + mode).
 */
export function useRovingRadio<T extends string>(
  options: ReadonlyArray<{ value: T }>,
  value: T,
  onChange: (v: T) => void,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): {
  getTabIndex: (v: T) => 0 | -1;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  const currentIndex = options.findIndex((o) => o.value === value);

  const getTabIndex = (v: T): 0 | -1 => (v === value ? 0 : -1);

  const move = (delta: number) => {
    if (options.length === 0) return;
    let next = currentIndex + delta;
    if (next < 0) next = options.length - 1;
    if (next >= options.length) next = 0;
    onChange(options[next].value);
  };

  const goHome = () => {
    if (options.length > 0) onChange(options[0].value);
  };
  const goEnd = () => {
    if (options.length > 0) onChange(options[options.length - 1].value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const isVertical = orientation === 'vertical';
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown': {
        const forward = isVertical ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
        if (forward) {
          e.preventDefault();
          move(1);
        }
        break;
      }
      case 'ArrowLeft':
      case 'ArrowUp': {
        const backward = isVertical ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
        if (backward) {
          e.preventDefault();
          move(-1);
        }
        break;
      }
      case 'Home':
        e.preventDefault();
        goHome();
        break;
      case 'End':
        e.preventDefault();
        goEnd();
        break;
      default:
        break;
    }
  };

  return { getTabIndex, onKeyDown };
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  orientation = 'horizontal',
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: JSX.Element }>;
  onChange: (v: T) => void;
  orientation?: 'horizontal' | 'vertical';
}): JSX.Element {
  const { getTabIndex, onKeyDown } = useRovingRadio(options, value, onChange, orientation);

  const flex = orientation === 'vertical' ? 'flex-col items-stretch' : 'items-center';

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex ${flex} gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5`}
      onKeyDown={onKeyDown}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={getTabIndex(opt.value)}
            onClick={() => onChange(opt.value)}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--acc)]"
            style={
              active
                ? { background: 'var(--acc-tint)', color: 'var(--acc)' }
                : { color: 'var(--text-dim)' }
            }
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
