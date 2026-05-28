/**
 * PII pattern definitions for PrivacyScreen.
 * Port of se-lz/src/SECC.Infrastructure/Services/PiiPatterns.cs
 */

// ── Regex Factories ──────────────────────────────────────────────────────────
// Each factory returns a fresh regex with the global flag so repeated use
// in scrubText() doesn't carry over lastIndex state between calls.

export const mkIpv4 = (): RegExp =>
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

export const mkIpv6 = (): RegExp =>
  /(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4})/g;

export const mkEmail = (): RegExp =>
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

export const mkUncPath = (): RegExp =>
  /\\\\[a-zA-Z0-9._\-]+(?:\\[a-zA-Z0-9._\-\s]+)+/g;

// Capture group 1 = domain, group 2 = user
export const mkDomainUser = (): RegExp =>
  /\b([A-Z][A-Z0-9_\-]{1,15})\\([a-zA-Z0-9._\-]+)\b/g;

export const mkFqdn = (): RegExp =>
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?){2,}\b/g;

// Matches key=value / key: value patterns for passwords, tokens, secrets
export const mkSensitiveKV = (): RegExp =>
  /(password|access_token|Authorization|Bearer|Basic|secret|api_key|apikey)([=:\s]+)\S+/gi;

// Credentials that are BLOCK ALWAYS — never tokenize, never allow through
export const mkCredential = (): RegExp =>
  /(?:sk-ant-[A-Za-z0-9\-_]{20,}|sk-proj-[A-Za-z0-9\-_]{20,}|sk_live_[A-Za-z0-9]+|sk_test_[A-Za-z0-9]+|ghp_[A-Za-z0-9]{32,}|ghs_[A-Za-z0-9]{32,}|whsec_[A-Za-z0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/g;

// MAC address
export const mkMac = (): RegExp =>
  /\b(?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}\b/g;

// GUID / UUID
export const mkGuid = (): RegExp =>
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi;

// ── Allowlist ─────────────────────────────────────────────────────────────────
// FQDNs ending with these suffixes are considered vendor infrastructure
// and are NOT tokenized. Compared case-insensitively, suffix-match.
export const FQDN_ALLOWLIST: readonly string[] = [
  '.veeam.com',
  '.microsoft.com',
  '.amazonaws.com',
  '.azure.com',
  '.github.com',
  '.nuget.org',
  '.anthropic.com',
  '.cloudflare.com',
];

// Literal hostnames that are never tokenized
export const HOST_ALLOWLIST: readonly string[] = ['localhost'];

export function isFqdnAllowed(host: string): boolean {
  const lower = host.toLowerCase();
  if (HOST_ALLOWLIST.includes(lower)) return true;
  return FQDN_ALLOWLIST.some((suffix) => lower.endsWith(suffix));
}
