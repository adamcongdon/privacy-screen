/**
 * Global "update available" strip.
 *
 * Rendered once at the top of the app shell (App.tsx — wired by engineer-B).
 * Visible iff:
 *   - store.versionInfo.updateAvailable === true
 *   - store.versionInfo.updateInfo.version is set
 *   - the user hasn't already dismissed THAT specific version
 *
 * Clicking the body opens the SettingsDrawer with a 'update' deep link so the
 * drawer can auto-scroll/highlight the update section. Clicking the dismiss
 * (X) button records the current version into dismissedUpdateVersion (which
 * persists to localStorage) so the banner stays hidden until a newer version
 * appears.
 *
 * Visual language matches the in-drawer update banner (emerald), but slimmer —
 * a single horizontal strip, no progress bar, no notes link. The drawer remains
 * the place where you actually install.
 */

import { X } from 'lucide-react';
import { useStore } from '../store';

export default function UpdateAvailableBanner(): JSX.Element | null {
  const versionInfo = useStore((s) => s.versionInfo);
  const dismissedUpdateVersion = useStore((s) => s.dismissedUpdateVersion);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setSettingsDeepLink = useStore((s) => s.setSettingsDeepLink);
  const dismissUpdate = useStore((s) => s.dismissUpdate);

  const updateInfo = versionInfo?.updateInfo;
  if (!versionInfo?.updateAvailable || !updateInfo?.version) return null;
  if (dismissedUpdateVersion === updateInfo.version) return null;

  const { version, channel } = updateInfo;

  const openSettingsAtUpdate = (): void => {
    setSettingsDeepLink('update');
    setSettingsOpen(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full items-center justify-between gap-3 bg-emerald-700 px-3 py-1.5 text-xs text-white"
    >
      <button
        type="button"
        onClick={openSettingsAtUpdate}
        className="flex-1 text-left font-medium hover:underline focus:underline focus:outline-none focus:ring-1 focus:ring-white"
      >
        Update available: v{version} ({channel}) — Open Settings to install
      </button>
      <button
        type="button"
        onClick={() => dismissUpdate(version)}
        aria-label="Dismiss update notification"
        className="rounded p-0.5 text-white/80 hover:bg-emerald-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
