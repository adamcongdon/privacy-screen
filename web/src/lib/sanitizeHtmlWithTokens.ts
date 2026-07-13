/**
 * WEB-04 / #86 — allowlist HTML sanitizer for the rendered preview iframe.
 *
 * Previously used a blocklist (remove script/iframe + on* attrs + javascript:).
 * That misses tab/newline-obfuscated javascript:, data:/vbscript: URLs, svg
 * use/href, and any unknown future tag. We now:
 *   1. Keep only allowlisted tags (unwrap others, drop void dangerous ones)
 *   2. Keep only allowlisted attributes
 *   3. Allow only safe URL schemes on href/src (http/https/mailto/relative)
 *   4. Then inject token pills + baseline styles
 *
 * HtmlRenderedView still uses sandbox="" with no allow-scripts (defense in depth).
 */

import type { Token } from '../api';
import { getCategoryInlineStyles } from './colors';
import { TOKEN_RE } from './tokens';

const SKIP_ANCESTOR_TAGS = new Set(['script', 'style', 'title', 'noscript']);

/** Tags permitted in the scrubbed HTML preview (text/html content only). */
export const ALLOWED_TAGS = new Set([
  'html',
  'head',
  'body',
  'meta',
  'base',
  'style', // only our injected baseline; input style is re-stripped then re-added
  'p',
  'br',
  'div',
  'span',
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'blockquote',
  'pre',
  'code',
  'hr',
  'img',
]);

/** Global allowlisted attributes (others dropped). */
export const ALLOWED_ATTRS = new Set([
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'width',
  'height',
  'class',
  'data-cat',
  'style', // only for our token pills; non-token elements get style stripped later
  'charset',
  'target',
  'rel',
]);

/** Tags that must never keep children (drop entirely). */
const DROP_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'video',
  'audio',
  'source',
  'track',
  'frame',
  'frameset',
  'applet',
]);

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

/**
 * Normalize a URL attribute value and return it only if the scheme is safe.
 * Rejects javascript:/data:/vbscript: including tab/newline/null obfuscation.
 */
export function sanitizeUrlAttr(raw: string): string | null {
  // Strip C0 controls + whitespace that attackers use to break "startsWith"
  const cleaned = raw.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  // scheme-relative or absolute with scheme
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
      return cleaned;
    }
    return null; // javascript, data, vbscript, file, etc.
  }
  // relative / path / fragment / query — ok
  if (lower.startsWith('//')) {
    // protocol-relative — treat as https-capable, allow
    return cleaned;
  }
  return cleaned;
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

/**
 * Walk the tree once: drop/unwrap disallowed tags, strip attrs, sanitize URLs.
 */
function applyAllowlist(doc: Document): void {
  // Snapshot — we mutate the tree while walking.
  const elements = Array.from(doc.querySelectorAll('*'));
  for (const el of elements) {
    if (!el.isConnected) continue;
    const tag = el.tagName.toLowerCase();

    if (DROP_TAGS.has(tag) || !ALLOWED_TAGS.has(tag)) {
      if (DROP_TAGS.has(tag)) {
        el.remove();
      } else {
        // Unwrap: keep children, drop the element shell
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
        } else {
          el.remove();
        }
      }
      continue;
    }

    // Attribute allowlist
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        const safe = sanitizeUrlAttr(attr.value);
        if (safe === null) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, safe);
      }
      // Drop input style/class except we'll re-set on our tokens later
      if (name === 'style' || name === 'class' || name === 'data-cat') {
        el.removeAttribute(attr.name);
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

  // Drop any residual input <style> before re-injecting ours
  for (const s of Array.from(head.querySelectorAll('style'))) {
    s.remove();
  }

  if (!head.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.prepend(meta);
  }

  // Remove any input <base>, then set ours
  for (const b of Array.from(head.querySelectorAll('base'))) {
    b.remove();
  }
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  head.append(base);

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

  applyAllowlist(doc);
  replaceTokenTextNodes(doc, root, tokensByName);
  ensureBaseAndStyles(doc);

  if (!doc.documentElement) {
    return createWrappedFragmentDocument(root.outerHTML);
  }

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
