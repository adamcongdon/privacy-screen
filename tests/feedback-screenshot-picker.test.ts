/**
 * #140 option A — feedback dialog accepts screenshots via a client file
 * picker and tells the user to attach them in the GitHub editor (no server
 * upload / unscrubbed binary path).
 *
 * Fully mounting FeedbackDialog's Radix Dialog portal isn't supported by the
 * happy-dom harness (see custom-category-dialog.test.ts). We assert the
 * shipped source contract + pure helpers that the dialog uses.
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  formatFeedbackAttachmentNames,
  FEEDBACK_SCREENSHOT_ATTACH_NOTE,
  FEEDBACK_SCREENSHOT_ACCEPT,
} from '../web/src/components/feedbackScreenshotPicker';

const source = readFileSync(
  join(import.meta.dir, '../web/src/components/FeedbackDialog.tsx'),
  'utf-8',
);

test('SCR-140 helper formats selected screenshot names for confirmation', () => {
  expect(formatFeedbackAttachmentNames([])).toBe('');
  expect(formatFeedbackAttachmentNames(['a.png'])).toBe('a.png');
  expect(formatFeedbackAttachmentNames(['a.png', 'b.jpg'])).toBe('a.png, b.jpg');
});

test('SCR-140 attach-in-GitHub note is explicit and non-upload', () => {
  expect(FEEDBACK_SCREENSHOT_ATTACH_NOTE.toLowerCase()).toContain('github');
  expect(FEEDBACK_SCREENSHOT_ATTACH_NOTE.toLowerCase()).toMatch(/attach/);
  // Must not claim automatic upload — option A is client-only.
  expect(FEEDBACK_SCREENSHOT_ATTACH_NOTE.toLowerCase()).not.toMatch(/upload(ed|ing)? automatically/);
});

test('SCR-140 FeedbackDialog wires image file input + attach note', () => {
  expect(source).toContain('feedbackScreenshotPicker');
  expect(source).toContain('FEEDBACK_SCREENSHOT_ATTACH_NOTE');
  expect(source).toContain('FEEDBACK_SCREENSHOT_ACCEPT');
  expect(source).toMatch(/type=["']file["']/);
  expect(source).toMatch(/accept=\{FEEDBACK_SCREENSHOT_ACCEPT\}|accept=["']image\/\*/);
  expect(source).toMatch(/multiple/);
  // Selected names surface so the user can confirm what to drag into GitHub.
  expect(source).toContain('formatFeedbackAttachmentNames');
});

test('SCR-140 screenshot accept list is images only (no server binary upload path)', () => {
  expect(FEEDBACK_SCREENSHOT_ACCEPT).toMatch(/image\//);
  // Option A: no server route for binary feedback assets.
  const feedbackRoute = readFileSync(
    join(import.meta.dir, '../server/routes/feedback.ts'),
    'utf-8',
  );
  expect(feedbackRoute).not.toMatch(/multipart|FormData|upload.*screenshot/i);
});
