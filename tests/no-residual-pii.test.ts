/**
 * SCR-11 (#64): the #1 invariant test — re-run every PII detector over the
 * SCRUBBED output and assert zero non-allowlisted residual matches.
 *
 * Example-based tests check specific cases; this property-style test asserts
 * the invariant directly against a realistic mixed-PII corpus, so weakening any
 * detector (or a regression like the FQDN, unicode, or xlsx gaps) fails here
 * mechanically.
 */
import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';
import { scrubText } from '../src/scrubber';
import type { PrivacyConfig } from '../src/config';
import {
  mkIpv4, mkIpv6, mkEmail, mkUncPath, mkDomainUser, mkFqdn,
  mkPhone, mkStreetAddress, mkCreditCard, mkUrlPath, mkSensitiveKV,
  mkMac, mkGuid,
} from '../src/patterns';

const cfg: PrivacyConfig = {
  fqdn_allowlist_extra: [],
  customer_names: ['Acme Corp', 'Contoso Bank'],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  skip_scrub_fields: {},
  update_channel: 'off',
  update_manifest_url:
    'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json',
  feedback_relay_url: 'https://privacy-screen-feedback.example.workers.dev',
  llm_validate: {
    enabled: false, model_path: null, runtime: 'llama-server', endpoint: null,
    max_tokens: 256, timeout_ms: 2500, min_confidence: 0.6,
  },
  hook: { auto_approve_clean: false },
};

// Detectors that should find NOTHING in scrubbed output. Person-name detectors
// are heuristic/context-bound and intentionally excluded from the mechanical
// residual sweep (they over-match on token text); the structured-PII detectors
// below are the hard invariant.
const RESIDUAL_DETECTORS: Array<[string, () => RegExp]> = [
  ['ipv4', mkIpv4],
  ['ipv6', mkIpv6],
  ['email', mkEmail],
  ['uncPath', mkUncPath],
  ['domainUser', mkDomainUser],
  ['fqdn', mkFqdn],
  ['phone', mkPhone],
  ['streetAddress', mkStreetAddress],
  ['creditCard', mkCreditCard],
  ['urlPath', mkUrlPath],
  ['sensitiveKV', mkSensitiveKV],
  ['mac', mkMac],
  ['guid', mkGuid],
];

/** A scrubbed-text token like {IP}, {EMAIL_2}, {FQDN}. */
const TOKEN_RE = /\{[A-Z][A-Z0-9]*(?:_\d+)?\}/g;

/** Vendor/infra forms that are allowlisted and legitimately survive scrubbing. */
const ALLOWLISTED = [
  'mgmt.azure.com', 'packages.microsoft.com', 'github.com', 'localhost',
];

function assertNoResidualPii(scrubbed: string): void {
  // Strip the tokens themselves so the detectors don't match token text.
  const withoutTokens = scrubbed.replace(TOKEN_RE, ' ');
  for (const [name, mk] of RESIDUAL_DETECTORS) {
    const matches = [...withoutTokens.matchAll(mk())]
      .map((m) => m[0])
      .filter((s) => !ALLOWLISTED.some((a) => s.toLowerCase().includes(a)));
    expect(matches, `detector ${name} found residual PII: ${JSON.stringify(matches)}`).toEqual([]);
  }
}

describe('no residual PII invariant (SCR-11 #64)', () => {
  const CORPUS = [
    'Email alice@customer.example and bob@contoso.example about the outage.',
    'Login to DC01.CORP.ACME.COM and BACKUP01.CONTOSO.LOCAL tonight.',
    'Server backup01.acme.internal at 10.66.77.88 and 192.168.1.5.',
    'IPv6 fe80::1ff:fe23:4567:890a is unreachable.',
    'Call (555) 123-4567 or +44 20 7946 0958 for support.',
    'MAC 00:1A:2B:3C:4D:5E on the switch.',
    'Ticket GUID 550e8400-e29b-41d4-a716-446655440000.',
    'See https://customer.example/path?user=secret for details.',
    'UNC share \\\\fileserver01\\share\\reports.',
    'Domain user CONTOSO\\jsmith logged in.',
    'Acme Corp paid Contoso Bank via card 4111 1111 1111 1111.',
    'Ship to 123 Main Street, Springfield.',
  ].join('\n');

  test('scrubbing the mixed-PII corpus leaves zero residual structured PII', () => {
    const map = new ScrubMap();
    const r = scrubText(CORPUS, map, null, { sourceEvent: 'test', config: cfg });
    assertNoResidualPii(r.scrubbed);
  });

  test('scrubbed output is idempotent (re-scrub finds nothing new)', () => {
    const map = new ScrubMap();
    const first = scrubText(CORPUS, map, null, { sourceEvent: 'test', config: cfg });
    const second = scrubText(first.scrubbed, map, null, { sourceEvent: 'test', config: cfg });
    expect(second.scrubbed).toBe(first.scrubbed);
    assertNoResidualPii(second.scrubbed);
  });
});
