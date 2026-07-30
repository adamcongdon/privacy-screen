/**
 * Regression guard for #142: pasting long text expanded the whole window and
 * pushed the footer (Send button + protected-item count) below the fold,
 * instead of the text box being height-capped with the rest of the page fixed.
 *
 * Root cause (confirmed live with Interceptor): the flex height chain from the
 * viewport-pinned root down to the scrollable panes lost `min-h-0` on two
 * mid-chain columns, so `overflow-auto` on <main> never got a bounded height to
 * scroll within — every ancestor grew with the content. Measured before/after:
 *   stale build → document 7848px tall, Send button at y=7778 (off-screen)
 *   fixed       → document 914px, textarea capped 536px (scrolls internally),
 *                 Send button visible at y=844.
 *
 * happy-dom has no layout engine, so (exactly like
 * tests/custom-category-dialog.test.ts for #139) this asserts on the source:
 * the load-bearing classes whose removal reintroduces the overflow. A true CSS
 * layout regression still needs a real browser to catch; this locks the classes.
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string): string =>
  readFileSync(join(import.meta.dir, '..', p), 'utf-8');

/** Every className string literal in a source file. */
function classNames(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
}
const tokens = (c: string): string[] => c.trim().split(/\s+/);

/** The first className literal whose tokens include every one of `must`. */
function classWith(src: string, ...must: string[]): string | undefined {
  return classNames(src).find((c) => {
    const t = tokens(c);
    return must.every((m) => t.includes(m));
  });
}

describe('SCR-142 ScrubSend footer stays on-screen — flex height chain keeps min-h-0', () => {
  const app = read('web/src/App.tsx');
  const shell = read('web/src/components/flow/Shell.tsx');
  const scrub = read('web/src/components/flow/ScrubSend.tsx');

  test('App root is viewport-pinned (h-screen) AND min-h-0', () => {
    const root = classWith(app, 'h-screen');
    expect(root).toBeDefined();
    expect(tokens(root!)).toContain('min-h-0');
  });

  test('App inner column carries min-h-0', () => {
    // One of the two mid-chain divs that lost min-h-0 and caused the overflow.
    const col = classWith(app, 'flex-1', 'flex-col', 'min-w-0');
    expect(col).toBeDefined();
    expect(tokens(col!)).toContain('min-h-0');
  });

  test('Shell root column carries min-h-0', () => {
    const col = classWith(shell, 'flex-1', 'flex-col');
    expect(col).toBeDefined();
    expect(tokens(col!)).toContain('min-h-0');
  });

  test('Shell <main> is the bounded scroll container (min-h-0 + flex-1 + overflow-auto)', () => {
    const main = shell.match(/<main\b[\s\S]*?className="([^"]*)"/)?.[1];
    expect(main).toBeDefined();
    const t = tokens(main!);
    expect(t).toContain('min-h-0');
    expect(t).toContain('flex-1');
    expect(t).toContain('overflow-auto');
  });

  test('ScrubSend has scroll panes that cap height + scroll internally', () => {
    // The scrubbed-output / extracted-file-text / reply panes must own their
    // overflow (min-h-0 + flex-1 + overflow-auto) so a long paste never grows
    // the page instead of scrolling the pane.
    const panes = classNames(scrub).filter((c) => {
      const t = tokens(c);
      return (
        t.includes('min-h-0') &&
        t.includes('flex-1') &&
        t.includes('overflow-auto')
      );
    });
    expect(panes.length).toBeGreaterThan(0);
  });
});
