import * as Dialog from '@radix-ui/react-dialog';
import { Network, X } from 'lucide-react';
import { useStore } from '../store';
import { TokenMapBody } from './TokenMap';
import { cn } from '../lib/cn';

/**
 * Right-side slide-in drawer hosting the token map.
 *
 * Mirrors the SettingsDrawer pattern (Radix Dialog + animate-slide-in-right) so
 * the two drawers feel identical. Trigger is a count-badged pill in the top
 * header — opens via click, ⌘K (registered globally in App.tsx), or
 * `setTokenMapOpen(true)` from the store.
 */
export function TokenMapDrawer(): JSX.Element {
  const open = useStore((s) => s.tokenMapOpen);
  const setOpen = useStore((s) => s.setTokenMapOpen);
  const tokens = useStore((s) => s.tokens);
  const tokenUnion = useStore((s) => s.tokenUnion);

  const count = Math.max(tokens.length, tokenUnion.size);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          title="Token map (⌘K)"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="token-map-drawer"
        >
          <Network className="h-3.5 w-3.5" />
          tokens
          <span
            className={cn(
              'rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[10px]',
              count > 0 ? 'text-indigo-300' : 'text-zinc-500',
            )}
          >
            {count}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content
          id="token-map-drawer"
          className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col gap-3 border-l border-zinc-800 bg-zinc-950 p-5 shadow-2xl animate-slide-in-right"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
              Token map
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="close token map"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-xs text-zinc-500">
            Search, add a customer name, or forget a value. Tokens are reconstructed locally;
            real values never leave this machine.
          </Dialog.Description>

          <TokenMapBody />

          <div className="mt-auto border-t border-zinc-800 pt-2 text-[10px] text-zinc-500">
            Esc to close · ⌘K toggles this drawer
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
