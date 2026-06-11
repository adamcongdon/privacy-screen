/**
 * PII pattern definitions for PrivacyScreen.
 * Ported from an internal C# reference implementation.
 * Extended to cover OpenAI Privacy Filter taxonomy (8 categories).
 */

// ── Regex Factories ──────────────────────────────────────────────────────────
// Each factory returns a fresh regex with the global flag so repeated use
// in scrubText() doesn't carry over lastIndex state between calls.

export const mkIpv4 = (): RegExp =>
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

export const mkIpv6 = (): RegExp =>
  /(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4})/g;

export const mkEmail = (): RegExp =>
  /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}/gu;

// UNC path. Path components disallow whitespace — eating spaces caused the
// regex to swallow the rest of a line (including any trailing credential).
// Trade-off: rare paths with literal spaces ("\\srv\My Backups") won't fully
// match; that's preferable to consuming a credential into the {PATH} span.
export const mkUncPath = (): RegExp =>
  /\\\\[a-zA-Z0-9._\-]+(?:\\[a-zA-Z0-9._\-]+)+/g;

// Capture group 1 = domain, group 2 = user
export const mkDomainUser = (): RegExp =>
  /\b([A-Z][A-Z0-9_\-]{1,15})\\([a-zA-Z0-9._\-]+)\b/g;

// FQDN — two flavors:
//   1. 3+ labels (host.domain.tld) — public-style domain
//   2. 2 labels where the last is a known internal suffix (host.local etc.)
// Combined into one alternation so the scrubber only does one pass.
const INTERNAL_DOMAIN_SUFFIX = '(?:local|lan|intranet|internal|corp|home|private|test|example|localdomain)';
export const mkFqdn = (): RegExp =>
  new RegExp(
    [
      // 3+ labels
      '\\b[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?){2,}\\b',
      // 2 labels with internal-suffix
      `\\b[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{1,61}[a-zA-Z0-9])\\.${INTERNAL_DOMAIN_SUFFIX}\\b`,
    ].join('|'),
    'g',
  );

// ── New categories (OpenAI taxonomy parity) ──────────────────────────────────

/**
 * North American phone numbers + E.164 international.
 * Anchored by required separators so 10-digit IDs and timestamps don't match.
 * Examples:  (555) 123-4567 | 555-123-4567 | +1 555 123 4567 | +44 20 7946 0958
 */
// Negative lookahead rejects only digits, not sentence-ending periods.
// The IPv4 regex runs before phone in the scrubber, so "192.168.1.1" is
// already minted as {IP} by the time phone is checked.
export const mkPhone = (): RegExp =>
  /(?:(?<!\d)\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)|\+\d{1,3}[\s.\-]\d{2,4}[\s.\-]\d{2,4}[\s.\-]\d{2,5}/g;

/**
 * US-format street address.
 * Heuristic: street number + 1–4 words + suffix (St/Ave/Rd/Blvd/etc).
 * Will miss apartment lines, PO Boxes, international formats — those go
 * through the review queue heuristic instead.
 */
export const mkStreetAddress = (): RegExp =>
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\.?\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Parkway|Pkwy|Court|Ct|Place|Pl|Circle|Cir|Terrace|Ter|Trail|Trl)\.?\b/g;

/**
 * Credit card numbers — Visa / Mastercard / Amex / Discover prefix patterns.
 * No Luhn check (cheap to add, but a 16-digit non-card false-positive rate
 * is already low because of the separator pattern requirement).
 */
export const mkCreditCard = (): RegExp =>
  /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g;

/**
 * URLs with paths (beyond bare FQDN).
 * `mkFqdn` already catches the host portion of a URL; this catches the path
 * + query portion so query-param tokens, paths with usernames, etc. don't
 * leak through.
 */
export const mkUrlPath = (): RegExp =>
  /\bhttps?:\/\/[^\s<>"']+/g;

/** Sensitive key=value / key: value pairs — covers config files, env dumps. */
export const mkSensitiveKV = (): RegExp =>
  /\b(password|passwd|access_token|refresh_token|auth_token|api[_\-]?key|apikey|secret|client_secret|private_key)\s*[=:]\s*['"]?([^\s'"&;]+)/gi;

// ── Credential BLOCK ALWAYS ──────────────────────────────────────────────────
//
// Strict — these strings are evidence of a leaked credential and must never
// be tokenized, never restored, never allowed through to the API. Extending
// OpenAI Privacy Filter's `secret` category with concrete production patterns.
export const mkCredential = (): RegExp =>
  new RegExp(
    [
      // OpenAI / Anthropic / Stripe / GitHub
      'sk-ant-[A-Za-z0-9\\-_]{20,}',
      'sk-proj-[A-Za-z0-9\\-_]{20,}',
      'sk_live_[A-Za-z0-9]+',
      'sk_test_[A-Za-z0-9]+',
      'ghp_[A-Za-z0-9]{32,}',
      'ghs_[A-Za-z0-9]{32,}',
      'gho_[A-Za-z0-9]{32,}',
      'ghu_[A-Za-z0-9]{32,}',
      'github_pat_[A-Za-z0-9_]{20,}',
      'whsec_[A-Za-z0-9]{32,}',
      // Private-key headers (every flavor)
      '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY',
      // JWT — three base64url segments separated by dots
      'eyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}',
      // AWS Access Key IDs
      '(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}',
      // Azure connection-string key components
      'AccountKey=[A-Za-z0-9+/=]{40,}',
      'SharedAccessSignature=[A-Za-z0-9%\\-_.~]{40,}',
      // Slack tokens
      'xox[abprs]-[A-Za-z0-9\\-]{10,}',
      // Bearer header with a sufficiently long token
      'Bearer\\s+[A-Za-z0-9._\\-+/=]{30,}',
    ].join('|'),
    'g',
  );

// MAC address
export const mkMac = (): RegExp =>
  /\b(?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}\b/g;

// GUID / UUID
export const mkGuid = (): RegExp =>
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi;

/**
 * Capitalized noun phrase + corporate suffix.
 * Heuristic — goes to the review queue, not the vocab map. Confidence 0.6.
 * Examples matched: "Acme Corp", "Contoso Inc", "Fabrikam LLC"
 */
export const mkCorpEntity = (): RegExp =>
  /\b(?:[A-Z][a-zA-Z]+\s+){1,3}(?:Corp|Corporation|Inc|Incorporated|LLC|Ltd|Limited|GmbH|Co|Bank|Hospital|University|College|Health|Healthcare|Holdings|Group|Industries|Systems|Solutions|Technologies)\b/g;

// ── Person name detection ────────────────────────────────────────────────────
//
// Three complementary regexes locate human names in three surface forms:
//   1. Email-header contact slot: "Name <email@host>" with optional
//      separators (`;`, `,`, `\n`, or start-of-string) before the name.
//   2. Free-text name immediately adjacent to an email address.
//   3. Sign-off block: "Best,\nName" pattern at the end of a message.
//
// Capture group 1 is always the candidate name. The scrubber runs every match
// through isValidPersonName() — which enforces token shape, denylist, length,
// and config allowlist — before minting.

/**
 * Email-header contact slot — "Name <email@host>".
 *
 * The anchor `(?:[;,:]|^|\n)` covers all the surface forms a name-with-email
 * shows up in:
 *   - `From: Vincent Tidwell <vt@…>` — colon after a header word
 *   - `Cc: A <a@…>; B <b@…>; C <c@…>` — semicolons between recipients
 *   - `\nTo: Alex Stone <as@…>` — newline-anchored continuation line
 *   - `^Bob Loblaw <bob@…>` — line-start (with `m` flag)
 */
export const mkPersonFromHeader = (): RegExp =>
  /(?:[;,:]|^|\n)\s*([\p{Lu}][\p{L}'.-]+(?:\s+[\p{Lu}][\p{L}'.-]+)+)\s*<[^>]+@/gmu;

/** Capitalized Name appearing within 60 chars to the left of an email. */
export const mkPersonAdjacentToEmail = (): RegExp =>
  /\b([\p{Lu}][\p{L}'.-]+(?:\s+[\p{Lu}][\p{L}'.-]+)+)(?=[^@\n]{0,60}[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,})/gu;

/** Sign-off pattern — "Best,\nName" / "Thanks,\nName" / etc. */
export const mkSignOffName = (): RegExp =>
  /\n\s*(?:Best|Thanks|Thank you|Regards|Cheers|Sincerely|Warmly|Talk soon)[,!.]?\s*\n+([\p{Lu}][\p{L}'.-]+(?:\s+[\p{Lu}][\p{L}'.-]+)*)/gu;

/**
 * Tokens that look name-shaped but are never people — calendar words, email
 * headers, common sign-offs, vendor stems, and greetings. All lowercase so the
 * comparison can normalize.
 */
export const NAME_DENYLIST: ReadonlySet<string> = new Set<string>([
  // Weekdays
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Months (full)
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  // Months (abbreviated)
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // Email header words
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'reply-to', 're', 'fw', 'fwd', 'sent',
  // Sign-offs / greetings
  'best', 'thanks', 'regards', 'cheers', 'hi', 'hello',
  'sincerely', 'dear', 'good', 'morning', 'afternoon', 'hey',
  // Company stems
  'microsoft', 'amazon', 'google', 'anthropic', 'openai',
  'github', 'stripe', 'cloudflare', 'azure',
]);

const PERSON_TOKEN_RE = /^[\p{Lu}][\p{L}'.-]+$/u;

/**
 * True iff `name` looks like a valid human name and is not allowlisted.
 *
 * Rules:
 *   - At least 2 whitespace-separated tokens.
 *   - Total length < 60.
 *   - Every token must match /^[A-Z][a-zA-Z'.-]+$/.
 *   - No token (lowercased) may appear in NAME_DENYLIST.
 *   - Full name (case-insensitive) must not appear in `allowlist`.
 */
export function isValidPersonName(name: string, allowlist: readonly string[]): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length >= 60) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return false;
  for (const t of tokens) {
    if (!PERSON_TOKEN_RE.test(t)) return false;
    if (NAME_DENYLIST.has(t.toLowerCase())) return false;
  }
  const lower = trimmed.toLowerCase();
  if (allowlist.some((a) => a.toLowerCase() === lower)) return false;
  return true;
}

// ── Identifier filter (Feature 1B) ───────────────────────────────────────────
//
// The FQDN regex is hungry: any dotted lowercase chain looks like a host.
// JavaScript expressions like `content.classList.contains` and CSS selectors
// like `button.collapsible.classBtn` are dotted but they're code, not domains.
// `looksLikeIdentifier` returns true for those so the scrubber can skip them.

const JS_GLOBALS: ReadonlySet<string> = new Set<string>([
  'window', 'document', 'console', 'Math', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'JSON', 'Date', 'Promise', 'Map', 'Set', 'Symbol',
  'this', 'self', 'globalThis', 'process', 'module', 'exports', 'require',
  'el', 'e', 'event', 'target', 'me', 'my', 'cell',
]);

const DOM_TAILS: ReadonlySet<string> = new Set<string>([
  'classList', 'className', 'textContent', 'innerHTML', 'innerText',
  'style', 'dataset', 'children', 'parentElement', 'parentNode',
  'firstChild', 'lastChild', 'nextSibling', 'previousSibling',
  'contains', 'add', 'remove', 'toggle', 'replace', 'item',
  'length', 'forEach', 'map', 'filter', 'reduce', 'push', 'pop',
  'indexOf', 'includes', 'slice', 'splice', 'split', 'join',
  'trim', 'toLowerCase', 'toUpperCase', 'prototype', 'call', 'apply', 'bind',
  'display', 'visibility', 'color', 'background', 'opacity',
  'scrollTop', 'scrollLeft', 'offsetTop', 'offsetLeft',
  'clientWidth', 'clientHeight', 'getAttribute', 'setAttribute',
  'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll',
]);

/**
 * Heuristic — true if `s` looks like a JS expression / CSS selector chain
 * rather than a hostname. Used by the scrubber to skip FQDN minting for
 * camelCase chains, DOM property accesses, and PascalCase tails.
 */
export function looksLikeIdentifier(s: string): boolean {
  const parts = s.split('.');
  if (parts.length < 2) return false;
  // Any camelCase segment (lowercase letter directly followed by uppercase)
  // is the strongest JS-identifier signal.
  if (parts.some((p) => /[a-z][A-Z]/.test(p))) return true;
  // Reserved JS globals / DOM properties as the *first* segment.
  if (JS_GLOBALS.has(parts[0])) return true;
  // Common DOM property/method names as the *last* segment.
  const last = parts[parts.length - 1];
  if (DOM_TAILS.has(last)) return true;
  // True PascalCase last segment (uppercase followed by lowercase, e.g.
  // "System.Net.Http") signals a code/type chain. We deliberately do NOT
  // skip a uniformly UPPER-CASE tail: all-caps hostnames like
  // DC01.CORP.ACME.COM are the normal AD/Windows display form and must be
  // tokenized, not passed through as cleartext (issue #54 / SCR-01).
  if (/^[A-Z][a-z]/.test(last)) return true;
  return false;
}

/**
 * True when `s` looks like a purely numeric dotted value — i.e. every
 * segment between the dots is all-digits. This catches date formats like
 * "13.05.2026", "2026.05.13", version strings like "1.2.3", and other
 * numeric dotted sequences that are NOT hostnames. Requires at least two
 * segments (needs at least one dot) to be meaningful.
 */
export function looksLikeDate(s: string): boolean {
  if (!s) return false;
  const parts = s.split('.');
  if (parts.length < 2) return false;
  return parts.every((p) => /^\d+$/.test(p));
}

/**
 * Heuristic to suppress common LLM-judge false positives on code / resource
 * identifiers (the exact class of noise reported in issue #43: "Repository_2",
 * "Server_3", etc.). These match the internal token counter shape without the
 * braces, or general [A-Za-z_][A-Za-z0-9_]*_\d+  and are never real PII names,
 * orgs, or credentials that a human operator needs to triage.
 *
 * Used by the judge path (validateAndShape). Not a security boundary; defense
 * in depth against small-model overflagging when "prefer over-flagging".
 */
export function looksLikeCodeIdentifier(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*_\d+$/.test(t)) return true;
  return false;
}

// ── Allowlist ─────────────────────────────────────────────────────────────────
// FQDNs ending with these suffixes are considered vendor infrastructure
// and are NOT tokenized. Compared case-insensitively, suffix-match.
export const FQDN_ALLOWLIST: readonly string[] = [
  '.microsoft.com',
  '.amazonaws.com',
  '.azure.com',
  '.github.com',
  '.nuget.org',
  '.anthropic.com',
  '.cloudflare.com',
  '.openai.com',
  '.googleapis.com',
];

// Literal hostnames that are never tokenized
export const HOST_ALLOWLIST: readonly string[] = ['localhost'];

/**
 * Suffix-match check against the built-in FQDN_ALLOWLIST plus any extra
 * suffixes from PRIVACY_CONFIG.yaml. The extras are passed in by the
 * caller so this function stays pure.
 */
export function isFqdnAllowed(host: string, extraSuffixes: readonly string[] = []): boolean {
  const lower = host.toLowerCase();
  if (HOST_ALLOWLIST.includes(lower)) return true;
  if (FQDN_ALLOWLIST.some((suffix) => lower.endsWith(suffix))) return true;
  return extraSuffixes.some((suffix) => lower.endsWith(suffix.toLowerCase()));
}
