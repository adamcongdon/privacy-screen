/**
 * Synchronized-scroll hook — keeps the Composer textarea and the Scrubbed
 * Preview pane visually aligned, like a git diff. Both panes render the same
 * logical text (one tokenized, one not) so identical scroll positions are the
 * correct UX.
 *
 * Implementation notes:
 *   - We use a single isSyncing ref to break the bounce: when A scrolls B, B's
 *     scroll handler sees isSyncing=true and returns early. The flag clears on
 *     the next animation frame so the next genuine user scroll is honored.
 *   - We mirror scrollTop AND scrollLeft because long lines wrap differently
 *     in the textarea vs. the preview's wrapped <p>, but horizontal sync still
 *     helps in unwrapped scenarios.
 *   - Refs are returned (one per pane) plus two handlers the caller wires up.
 */

import { useRef, useCallback, type RefObject } from 'react';

export type SyncScrollApi = {
  composerRef: RefObject<HTMLTextAreaElement>;
  previewRef: RefObject<HTMLElement>;
  onComposerScroll: (e: React.UIEvent<HTMLTextAreaElement>) => void;
  onPreviewScroll: (e: React.UIEvent<HTMLElement>) => void;
};

export function useSyncScroll(): SyncScrollApi {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const isSyncing = useRef(false);

  const onComposerScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    if (isSyncing.current) return;
    const src = e.currentTarget;
    const dst = previewRef.current;
    if (!dst) return;
    isSyncing.current = true;
    dst.scrollTop = src.scrollTop;
    dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  }, []);

  const onPreviewScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    if (isSyncing.current) return;
    const src = e.currentTarget;
    const dst = composerRef.current;
    if (!dst) return;
    isSyncing.current = true;
    dst.scrollTop = src.scrollTop;
    dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  }, []);

  return {
    composerRef: composerRef as RefObject<HTMLTextAreaElement>,
    previewRef: previewRef as RefObject<HTMLElement>,
    onComposerScroll,
    onPreviewScroll,
  };
}
