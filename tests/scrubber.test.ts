/**
 * Scrubber tests — port of se-lz PiiScrubberTests.cs
 * Tests the scrubText() function against canonical cases from the C# test suite.
 */
import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';
import { scrubText } from '../src/scrubber';

function scrub(text: string, map?: ScrubMap) {
  const m = map ?? new ScrubMap();
  return scrubText(text, m, null, { sourceEvent: 'test' });
}

describe('scrubText — IPv4', () => {
  test('detects private IPv4 and mints IP token', () => {
    const map = new ScrubMap();
    const r = scrub('Server at 192.168.1.1 is down', map);
    expect(map.tokenFor('192.168.1.1')).toBe('{IP}');
    expect(r.scrubbed).not.toContain('192.168.1.1');
    expect(r.mintedTokens[0].token).toBe('{IP}');
  });

  test('detects public IPv4', () => {
    const r = scrub('Connect to 8.8.8.8 for DNS');
    expect(r.scrubbed).not.toContain('8.8.8.8');
    expect(r.mintedTokens.some((t) => t.type === 'IP')).toBe(true);
  });

  test('multiple IPs get sequential tokens', () => {
    const map = new ScrubMap();
    scrub('10.0.0.1 and 10.0.0.2 and 10.0.0.1', map);
    expect(map.tokenFor('10.0.0.1')).toBe('{IP}');
    expect(map.tokenFor('10.0.0.2')).toBe('{IP_1}');
  });
});

describe('scrubText — Email', () => {
  test('detects email and mints EMAIL token', () => {
    const map = new ScrubMap();
    scrub('Contact admin@acme.com for support', map);
    expect(map.tokenFor('admin@acme.com')).toBe('{EMAIL}');
  });
});

describe('scrubText — FQDN', () => {
  test('tokenizes non-allowlisted FQDN', () => {
    const map = new ScrubMap();
    const r = scrub('Server is backup01.acme.internal', map);
    expect(map.tokenFor('backup01.acme.internal')).toBeDefined();
    expect(r.scrubbed).not.toContain('backup01.acme.internal');
  });

  test('skips allowlisted Veeam FQDN', () => {
    const map = new ScrubMap();
    scrub('Check updates.veeam.com', map);
    expect(map.tokenFor('updates.veeam.com')).toBeUndefined();
  });

  test('skips allowlisted Microsoft FQDN', () => {
    const map = new ScrubMap();
    scrub('From packages.microsoft.com', map);
    expect(map.tokenFor('packages.microsoft.com')).toBeUndefined();
  });

  test('tokenizes customer FQDN not in allowlist', () => {
    const map = new ScrubMap();
    scrub('backup01.acme.internal is unreachable', map);
    expect(map.tokenFor('backup01.acme.internal')).toBeDefined();
  });
});

describe('scrubText — UNC path', () => {
  test('detects UNC path', () => {
    const r = scrub('Backup stored at \\\\fileserver01\\Backup\\data');
    expect(r.scrubbed).not.toContain('fileserver01');
    expect(r.mintedTokens.some((t) => t.type === 'PATH')).toBe(true);
  });
});

describe('scrubText — credentials (BLOCK ALWAYS)', () => {
  test('detects Anthropic API key', () => {
    const r = scrub('key = sk-ant-api03-xxxxxxxxxxxxxxxxxxx_yyy');
    expect(r.hasCredentials).toBe(true);
    expect(r.credentialSnippets.length).toBeGreaterThan(0);
    expect(r.scrubbed).not.toContain('sk-ant-api03');
    expect(r.scrubbed).toContain('[CREDENTIAL-REDACTED]');
  });

  test('detects GitHub PAT', () => {
    const r = scrub('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh');
    expect(r.hasCredentials).toBe(true);
  });

  test('detects PRIVATE KEY header', () => {
    const r = scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...');
    expect(r.hasCredentials).toBe(true);
  });
});

describe('scrubText — round-trip reversibility', () => {
  test('scrub then restore returns original', () => {
    const map = new ScrubMap();
    const original = 'Customer Acme Corp has server backup01.acme.internal at 10.5.5.1';
    // Pre-populate map (simulating vocab load)
    map.mint('CUSTOMER', 'Acme Corp');
    const r = scrubText(original, map, null, { sourceEvent: 'test' });
    const restored = map.restore(r.scrubbed);
    // IPs and FQDNs detected by regex; CUSTOMER from map
    expect(restored).toBe(original);
  });
});

describe('scrubText — idempotence', () => {
  test('scrubbing twice produces same result', () => {
    const map = new ScrubMap();
    const first = scrubText('IP: 192.168.1.5', map, null, { sourceEvent: 'test' });
    const second = scrubText(first.scrubbed, map, null, { sourceEvent: 'test' });
    expect(first.scrubbed).toBe(second.scrubbed);
  });
});

describe('scrubText — empty / null', () => {
  test('empty string returns unchanged', () => {
    const r = scrub('');
    expect(r.scrubbed).toBe('');
    expect(r.modified).toBe(false);
  });

  test('clean text returns unchanged', () => {
    const r = scrub('All systems normal, no issues found.');
    expect(r.modified).toBe(false);
  });
});

describe('scrubText — longest match', () => {
  test('FQDN matched as one token, not substring', () => {
    const map = new ScrubMap();
    // Pre-mint "server01" as a named server
    map.mint('SERVER', 'server01');
    // Now let the FQDN fall through to regex detection
    const r = scrubText('Connect to server01.acme.com via server01', map, null, { sourceEvent: 'test' });
    // The FQDN should get its own HOST token
    const hostToken = r.mintedTokens.find((t) => t.realValue === 'server01.acme.com');
    expect(hostToken).toBeDefined();
    expect(r.scrubbed).not.toContain('server01.acme.com');
  });
});
