import { GlobalWindow } from 'happy-dom';

const win = new GlobalWindow();
const g = globalThis as Record<string, unknown>;

if (typeof g.window === 'undefined') g.window = win;
if (typeof g.document === 'undefined') g.document = win.document;
if (typeof g.Node === 'undefined') g.Node = win.Node;
if (typeof g.NodeFilter === 'undefined') g.NodeFilter = win.NodeFilter;
if (typeof g.Element === 'undefined') g.Element = win.Element;
if (typeof g.HTMLElement === 'undefined') g.HTMLElement = win.HTMLElement;
if (typeof g.Text === 'undefined') g.Text = win.Text;

// happy-dom v20: DOMParser instances must be created from the window instance,
// not from the extracted class, to keep the internal window context for querySelectorAll.
if (typeof g.DOMParser === 'undefined') {
  g.DOMParser = class {
    parseFromString(str: string, type: string) {
      return new win.DOMParser().parseFromString(str, type);
    }
  };
}
