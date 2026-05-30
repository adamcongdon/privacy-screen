import { Window } from 'happy-dom';

const win = new Window();
const globals = globalThis as Record<string, unknown>;

if (typeof globals.window === 'undefined') {
  globals.window = win;
}
if (typeof globals.document === 'undefined') {
  globals.document = win.document;
}
if (typeof globals.DOMParser === 'undefined') {
  globals.DOMParser = win.DOMParser;
}
if (typeof globals.Node === 'undefined') {
  globals.Node = win.Node;
}
if (typeof globals.NodeFilter === 'undefined') {
  globals.NodeFilter = win.NodeFilter;
}
if (typeof globals.Element === 'undefined') {
  globals.Element = win.Element;
}
if (typeof globals.HTMLElement === 'undefined') {
  globals.HTMLElement = win.HTMLElement;
}
if (typeof globals.Text === 'undefined') {
  globals.Text = win.Text;
}
