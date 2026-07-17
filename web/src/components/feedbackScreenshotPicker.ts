/**
 * #140 option A — client-only screenshot picker helpers for FeedbackDialog.
 *
 * No server upload: the user picks local image files for confirmation, then
 * attaches them manually in the GitHub issue editor after it opens.
 */

/** `accept` attribute for the feedback screenshot file input. */
export const FEEDBACK_SCREENSHOT_ACCEPT = 'image/*';

/**
 * Shown next to the file picker so users know screenshots are not uploaded
 * by Privacy Screen — they drag them into GitHub after the editor opens.
 */
export const FEEDBACK_SCREENSHOT_ATTACH_NOTE =
  'Attach screenshots after the GitHub editor opens — drag the files into the issue. Screenshots are not scrubbed or uploaded by Privacy Screen.';

/** Comma-separated confirmation list of selected local filenames. */
export function formatFeedbackAttachmentNames(names: readonly string[]): string {
  return names.filter((n) => n.trim().length > 0).join(', ');
}
