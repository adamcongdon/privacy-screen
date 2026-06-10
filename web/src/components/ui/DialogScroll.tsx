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
