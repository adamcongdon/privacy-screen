import type { Token } from '../api';
import { getCategoryInlineStyles } from './colors';
import { TOKEN_RE } from './tokens';

const SKIP_ANCESTOR_TAGS = new Set(['script', 'style', 'title', 'noscript']);
const BASELINE_STYLES = [
  'body { color:#18181b; background:#ffffff; max-width:80ch; margin:1rem auto; padding:0 1rem; font-family:ui-sans-serif,system-ui,sans-serif; line-height:1.5; }',
  'a { color:#4f46e5; }',
  '.ps-token { display:inline-block; padding:1px 6px; border-radius:4px; font-family:ui-monospace,monospace; font-size:0.85em; line-height:1.4; vertical-align:baseline; cursor:help; }',
].join('\n');

type DomParserCtor = typeof DOMParser;
type ElementLike = Element & {
  outerHTML: string;
};

function getDomParserCtor(domParser?: DomParserCtor): DomParserCtor {
  const parserCtor = domParser ?? globalThis.DOMParser;
  if (typeof parserCtor !== 'function') {
    throw new Error('sanitizeHtmlWithTokens: no DOMParser available');
  }
  return parserCtor;
}

function createWrappedFragmentDocument(fragment: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<base target="_blank">',
    `<style>${BASELINE_STYLES}</style>`,
    '</head>',
    `<body>${fragment}</body>`,
    '</html>',
  ].join('');
}

function hasSkippedAncestor(node: Node | null): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tagName = (current as Element).tagName.toLowerCase();
      if (SKIP_ANCESTOR_TAGS.has(tagName)) return true;
    }
    current = current.parentNode;
  }
  return false;
}

function removeDangerousElements(doc: Document): void {
  for (const element of doc.querySelectorAll('script, iframe, object, embed')) {
    element.remove();
  }
  for (const link of doc.querySelectorAll('link')) {
    if (link.getAttribute('rel')?.toLowerCase() === 'import') {
      link.remove();
    }
  }
}

function removeDangerousAttributes(doc: Document): void {
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name !== 'href' && name !== 'src') continue;
      if (attr.value.trim().toLowerCase().startsWith('javascript:')) {
        element.removeAttribute(attr.name);
      }
    }
  }
}

function collectTextNodes(node: Node, out: Text[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!hasSkippedAncestor(node.parentNode)) {
      out.push(node as Text);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== 9 /* DOCUMENT_NODE */) {
    return;
  }
  // Snapshot childNodes — collectTextNodes mutates the tree via callers.
  const children = Array.from(node.childNodes);
  for (const child of children) collectTextNodes(child, out);
}

function replaceTokenTextNodes(doc: Document, root: Node, tokensByName: Map<string, Token>): void {
  const textNodes: Text[] = [];
  collectTextNodes(root, textNodes);

  for (const textNode of textNodes) {
    const text = textNode.data;
    const matches = Array.from(text.matchAll(TOKEN_RE));
    if (matches.length === 0) continue;

    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      const rawToken = match[0];
      if (index > lastIndex) {
        fragment.append(doc.createTextNode(text.slice(lastIndex, index)));
      }
      const token = tokensByName.get(rawToken);
      const category = (token?.category ?? 'unknown').trim().toLowerCase() || 'unknown';
      const inlineStyle = getCategoryInlineStyles(category);
      const span = doc.createElement('span');
      span.setAttribute('class', 'ps-token');
      span.setAttribute('data-cat', category);
      span.setAttribute(
        'title',
        `${category}: ${token?.realValue ?? 'unrecognized'}`,
      );
      span.setAttribute(
        'style',
        [
          `background:${inlineStyle.bg}`,
          `border:1px solid ${inlineStyle.border}`,
          `color:${inlineStyle.text}`,
          'display:inline-block',
          'padding:1px 6px',
          'border-radius:4px',
          'font-family:ui-monospace,monospace',
          'font-size:0.85em',
          'line-height:1.4',
          'vertical-align:baseline',
          'cursor:help',
        ].join(';'),
      );
      span.textContent = rawToken;
      fragment.append(span);
      lastIndex = index + rawToken.length;
    }
    if (lastIndex < text.length) {
      fragment.append(doc.createTextNode(text.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }
}

function ensureHead(doc: Document): HTMLHeadElement {
  if (doc.head) return doc.head;
  const head = doc.createElement('head');
  const html = doc.documentElement;
  if (!html) return head as HTMLHeadElement;
  html.insertBefore(head, html.firstChild);
  return head as HTMLHeadElement;
}

function ensureBaseAndStyles(doc: Document): void {
  const head = ensureHead(doc);

  if (!head.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.prepend(meta);
  }

  if (!head.querySelector('base')) {
    const base = doc.createElement('base');
    base.setAttribute('target', '_blank');
    head.append(base);
  }

  const style = doc.createElement('style');
  style.textContent = BASELINE_STYLES;
  head.append(style);
}

function getRootElement(doc: Document): ElementLike | null {
  const root = doc.documentElement;
  if (root && root.tagName.toLowerCase() === 'html') {
    return root as ElementLike;
  }
  if (doc.body) {
    return doc.body as ElementLike;
  }
  return null;
}

export function sanitizeHtmlWithTokens(
  html: string,
  tokensByName: Map<string, Token>,
  opts?: { domParser?: typeof DOMParser },
): string {
  const DomParser = getDomParserCtor(opts?.domParser);
  const parser = new DomParser();
  const doc = parser.parseFromString(html, 'text/html');
  if (!doc || typeof doc.createElement !== 'function') {
    return createWrappedFragmentDocument(html);
  }

  const root = getRootElement(doc);
  if (!root) {
    return createWrappedFragmentDocument(html);
  }

  removeDangerousElements(doc);
  removeDangerousAttributes(doc);
  replaceTokenTextNodes(doc, root, tokensByName);
  ensureBaseAndStyles(doc);

  if (!doc.documentElement) {
    return createWrappedFragmentDocument(root.outerHTML);
  }

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
