/**
 * Regression test for #139: "Add new category" dialog rendered its content
 * unpositioned (no `fixed`/z-index), so it sat beneath the blurred overlay
 * (Dialog.Overlay is `fixed z-[80] backdrop-blur-[2px]`) and the whole form
 * appeared through the 2px backdrop blur.
 *
 * Fully mounting this component's Radix Dialog (Portal + FocusScope) isn't
 * supported by this project's happy-dom test harness (no other test in this
 * repo renders a Radix Dialog; doing so needs Event/MutationObserver
 * cross-realm shims well beyond this component). Instead this asserts
 * directly on the source that Dialog.Content opts into `fixed` positioning
 * with a z-index above the overlay's — the two properties that determine
 * stacking order and were missing before the fix.
 */

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(
  join(import.meta.dir, '../web/src/components/CustomCategoryDialog.tsx'),
  'utf-8',
);

function classNameOf(tag: string): string {
  const match = source.match(new RegExp(`<${tag}\\b[\\s\\S]*?className="([^"]*)"`));
  if (!match) throw new Error(`could not find <${tag}> className in CustomCategoryDialog.tsx`);
  return match[1];
}

test('SCR-139 custom category dialog content is fixed and stacks above the blurred overlay', () => {
  const overlayClass = classNameOf('Dialog.Overlay');
  const contentClass = classNameOf('Dialog.Content');

  const overlayZ = Number(overlayClass.match(/z-\[(\d+)\]/)?.[1]);
  const contentZ = Number(contentClass.match(/z-\[(\d+)\]/)?.[1]);

  expect(Number.isNaN(overlayZ)).toBe(false);
  // Content must opt into fixed positioning — otherwise it's static/in-flow
  // and stacks beneath the fixed, blurred overlay regardless of z-index.
  expect(contentClass).toMatch(/\bfixed\b/);
  expect(Number.isNaN(contentZ)).toBe(false);
  expect(contentZ).toBeGreaterThan(overlayZ);
});
