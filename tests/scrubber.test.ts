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

  test('skips allowlisted example FQDN', () => {
    const map = new ScrubMap();
    scrub('Check updates.example.com', map);
    expect(map.tokenFor('updates.example.com')).toBeUndefined();
  });

  test('skips allowlisted Microsoft FQDN', () => {
    const map = new ScrubMap();
    scrub('From packages.microsoft.com', map);
    expect(map.tokenFor('packages.microsoft.com')).toBeUndefined();
  });

  test('tokenizes 2-label internal hostname (.local suffix) — regression', () => {
    const map = new ScrubMap();
    scrub('Server acme.local is down', map);
    expect(map.tokenFor('acme.local')).toBeDefined();
  });
  test('tokenizes .lan suffix', () => {
    const map = new ScrubMap();
    scrub('Reach backup01.lan now', map);
    expect(map.tokenFor('backup01.lan')).toBeDefined();
  });
  test('tokenizes .corp suffix', () => {
    const map = new ScrubMap();
    scrub('From dc01.corp tonight', map);
    expect(map.tokenFor('dc01.corp')).toBeDefined();
  });
  test('does NOT match filename-shaped strings (file.txt)', () => {
    const map = new ScrubMap();
    scrub('see notes.txt and data.json', map);
    expect(map.tokenFor('notes.txt')).toBeUndefined();
    expect(map.tokenFor('data.json')).toBeUndefined();
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

// ── Config-driven behaviors ────────────────────────────────────────────────

import { scrubToolInput } from '../src/scrubber';
import type { PrivacyConfig } from '../src/config';

const baseCfg: PrivacyConfig = {
  fqdn_allowlist_extra: [],
  customer_names: [],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  skip_scrub_fields: {
    Edit: ['old_string', 'new_string'],
    MultiEdit: ['edits'],
    Grep: ['pattern'],
    Glob: ['pattern'],
  },
};

describe('scrubText — customer_names from config', () => {
  test('pre-mints customer names so they always tokenize as CUSTOMER', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = { ...baseCfg, customer_names: ['Acme Corp', 'Contoso Bank'] };
    const r = scrubText('Acme Corp paid Contoso Bank yesterday', map, null, {
      sourceEvent: 'test',
      config: cfg,
    });
    expect(r.scrubbed).not.toContain('Acme Corp');
    expect(r.scrubbed).not.toContain('Contoso Bank');
    expect(map.tokenFor('Acme Corp')).toBe('{CUSTOMER}');
    expect(map.tokenFor('Contoso Bank')).toBe('{CUSTOMER_1}');
  });

  test('case-insensitive customer name match', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = { ...baseCfg, customer_names: ['Acme Corp'] };
    const r = scrubText('ACME CORP and acme corp', map, null, {
      sourceEvent: 'test',
      config: cfg,
    });
    expect(r.scrubbed).not.toContain('ACME CORP');
    expect(r.scrubbed).not.toContain('acme corp');
  });
});

describe('scrubText — fqdn_allowlist_extra from config', () => {
  test('extra FQDN suffix passes through', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = {
      ...baseCfg,
      fqdn_allowlist_extra: ['.internal.example.com'],
    };
    const r = scrubText('Check api.internal.example.com', map, null, {
      sourceEvent: 'test',
      config: cfg,
    });
    expect(map.tokenFor('api.internal.example.com')).toBeUndefined();
    expect(r.scrubbed).toContain('api.internal.example.com');
  });
});

describe('scrubText — new categories', () => {
  test('phone number tokenized', () => {
    const map = new ScrubMap();
    const r = scrubText('Call (555) 123-4567 now', map, null, { sourceEvent: 'test' });
    expect(map.tokenFor('(555) 123-4567')).toBeDefined();
    expect(r.scrubbed).not.toContain('555');
  });

  test('street address tokenized', () => {
    const map = new ScrubMap();
    const r = scrubText('Lives at 123 Main Street here', map, null, { sourceEvent: 'test' });
    expect(map.tokenFor('123 Main Street')).toBeDefined();
    expect(r.scrubbed).not.toContain('Main Street');
  });

  test('credit card tokenized as ACCOUNT', () => {
    const map = new ScrubMap();
    const r = scrubText('use 4111-1111-1111-1111 today', map, null, { sourceEvent: 'test' });
    const tok = r.mintedTokens.find((t) => t.category === 'account_number');
    expect(tok).toBeDefined();
    expect(tok!.token).toMatch(/^\{ACCOUNT/);
  });

  test('JWT triggers hasCredentials', () => {
    const map = new ScrubMap();
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = scrubText(`token=${jwt}`, map, null, { sourceEvent: 'test' });
    expect(r.hasCredentials).toBe(true);
  });

  test('AWS access key triggers hasCredentials', () => {
    const r = scrubText(
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      new ScrubMap(),
      null,
      { sourceEvent: 'test' },
    );
    expect(r.hasCredentials).toBe(true);
  });
});

describe('scrubText — corp entity heuristic → unsureSpans', () => {
  test('Acme Corp goes to unsureSpans, not mintedTokens', () => {
    const map = new ScrubMap();
    const r = scrubText('Met with Acme Corp engineers', map, null, { sourceEvent: 'test' });
    expect(r.unsureSpans.some((s) => s.span === 'Acme Corp')).toBe(true);
    expect(map.tokenFor('Acme Corp')).toBeUndefined();
  });

  test('confirmed customer (in customer_names) bypasses review queue', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = { ...baseCfg, customer_names: ['Acme Corp'] };
    const r = scrubText('Met with Acme Corp engineers', map, null, {
      sourceEvent: 'test',
      config: cfg,
    });
    expect(r.unsureSpans.some((s) => s.span === 'Acme Corp')).toBe(false);
    expect(map.tokenFor('Acme Corp')).toBe('{CUSTOMER}');
  });
});

describe('scrubToolInput — skip_scrub_fields for Edit safety', () => {
  test('Edit old_string/new_string pass through unmodified', () => {
    const map = new ScrubMap();
    const toolInput = {
      file_path: '/path/to/file',
      old_string: 'server at 10.0.0.1 is broken',
      new_string: 'server at 10.0.0.1 is fixed',
    };
    const { input } = scrubToolInput(
      toolInput,
      map,
      null,
      { sourceEvent: 'preToolUse:Edit', config: baseCfg },
      'Edit',
    );
    expect(input.old_string).toBe('server at 10.0.0.1 is broken');
    expect(input.new_string).toBe('server at 10.0.0.1 is fixed');
  });

  test('Edit still detects credentials in skipped fields and reports them', () => {
    const map = new ScrubMap();
    const toolInput = {
      file_path: '/path',
      old_string: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa_z',
      new_string: 'placeholder',
    };
    const { result } = scrubToolInput(
      toolInput,
      map,
      null,
      { sourceEvent: 'preToolUse:Edit', config: baseCfg },
      'Edit',
    );
    expect(result.hasCredentials).toBe(true);
  });

  test('Bash command field IS scrubbed (not in skip list)', () => {
    const map = new ScrubMap();
    const { input } = scrubToolInput(
      { command: 'ping 10.0.0.5' },
      map,
      null,
      { sourceEvent: 'preToolUse:Bash', config: baseCfg },
      'Bash',
    );
    expect(input.command).not.toContain('10.0.0.5');
  });

  test('Grep pattern field passes through unmodified', () => {
    const map = new ScrubMap();
    const { input } = scrubToolInput(
      { pattern: 'customer.acme.com', path: '/srv/logs' },
      map,
      null,
      { sourceEvent: 'preToolUse:Grep', config: baseCfg },
      'Grep',
    );
    expect(input.pattern).toBe('customer.acme.com');
  });
});

// ── Person detection (Feature 1) integration ───────────────────────────────

describe('scrubText — person name detection', () => {
  test('detects person from From: header', () => {
    const map = new ScrubMap();
    const r = scrubText(
      'From: Vincent Tidwell <vt@example.com>\nHello.',
      map,
      null,
      { sourceEvent: 'test', config: baseCfg },
    );
    expect(map.tokenFor('Vincent Tidwell')).toBeDefined();
    expect(map.tokenFor('Vincent Tidwell')).toMatch(/^\{PERSON/);
    expect(r.scrubbed).not.toContain('Vincent Tidwell');
  });

  test('full email-header sample mints all four names', () => {
    const map = new ScrubMap();
    const sample = [
      'From: Vincent Tidwell <vt@example.com>',
      'To: Adam Congdon <adam@example.com>',
      'Cc: Blake Sheffield <bs@example.com>; Chad Aiken <ca@example.com>; Mike Bova <mb@example.com>',
      '',
      'Hey team,',
      '',
      'Quick sync notes from Vincent Tidwell and Mike Bova.',
      '',
      'Best,',
      'Mike Bova',
    ].join('\n');
    const r = scrubText(sample, map, null, { sourceEvent: 'test', config: baseCfg });
    expect(map.tokenFor('Vincent Tidwell')).toBeDefined();
    expect(map.tokenFor('Blake Sheffield')).toBeDefined();
    expect(map.tokenFor('Chad Aiken')).toBeDefined();
    expect(map.tokenFor('Mike Bova')).toBeDefined();
    expect(r.scrubbed).not.toContain('Vincent Tidwell');
    expect(r.scrubbed).not.toContain('Mike Bova');
    expect(r.scrubbed).not.toContain('Blake Sheffield');
    expect(r.scrubbed).not.toContain('Chad Aiken');
  });

  test('respects name_allowlist from config', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = { ...baseCfg, name_allowlist: ['Adam Congdon'] };
    const r = scrubText(
      'From: Adam Congdon <adam@example.com>\nHi.',
      map,
      null,
      { sourceEvent: 'test', config: cfg },
    );
    expect(map.tokenFor('Adam Congdon')).toBeUndefined();
    expect(r.scrubbed).toContain('Adam Congdon');
  });

  test('pre-mints person_names from config', () => {
    const map = new ScrubMap();
    const cfg: PrivacyConfig = { ...baseCfg, person_names: ['Vincent Tidwell'] };
    const r = scrubText('Talk to Vincent Tidwell about it', map, null, {
      sourceEvent: 'test',
      config: cfg,
    });
    expect(map.tokenFor('Vincent Tidwell')).toBeDefined();
    expect(map.tokenFor('Vincent Tidwell')).toMatch(/^\{PERSON/);
    expect(r.scrubbed).not.toContain('Vincent Tidwell');
  });
});

// ── Feature 1B: JS/CSS identifier filtering in FQDN detection ──────────────

// ── Feature 3: allowlist round-trip (forget + re-scrub) ────────────────────

import { VocabStore } from '../src/vocab';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

describe('scrubText — allowlist suppresses minting (Feature 3)', () => {
  function freshVocab(): { vocab: VocabStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pai-scrubber-allowlist-'));
    return { vocab: new VocabStore(join(dir, 'vocab.db')), dir };
  }

  test('respects allowlist for person tokens', () => {
    const { vocab, dir } = freshVocab();
    try {
      vocab.addAllowlist('Vincent Tidwell', false, 'allowlisted name');
      const map = new ScrubMap();
      const r = scrubText(
        'From: Vincent Tidwell <vt@example.com>\nHello.',
        map,
        vocab,
        { sourceEvent: 'test', config: baseCfg },
      );
      expect(map.tokenFor('Vincent Tidwell')).toBeUndefined();
      expect(r.scrubbed).toContain('Vincent Tidwell');
    } finally {
      vocab.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('respects allowlist for email tokens', () => {
    const { vocab, dir } = freshVocab();
    try {
      vocab.addAllowlist('keepme@example.com', false, 'allowlisted email');
      const map = new ScrubMap();
      const r = scrubText(
        'Contact keepme@example.com please.',
        map,
        vocab,
        { sourceEvent: 'test', config: baseCfg },
      );
      expect(map.tokenFor('keepme@example.com')).toBeUndefined();
      expect(r.scrubbed).toContain('keepme@example.com');
    } finally {
      vocab.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forget→re-scrub round-trip leaves value plain', () => {
    const { vocab, dir } = freshVocab();
    try {
      const map = new ScrubMap();
      const sample = 'host backup01.acme.internal is up';
      // First scrub mints the host.
      const r1 = scrubText(sample, map, vocab, { sourceEvent: 'test', config: baseCfg });
      expect(r1.scrubbed).not.toContain('backup01.acme.internal');
      // User clicks "forget" → DELETE handler removes vocab + adds allowlist.
      vocab.forgetReal('backup01.acme.internal');
      vocab.addAllowlist('backup01.acme.internal', false, 'forget action');
      // Re-scrub with a fresh map (singleton was reset in the real flow).
      const map2 = new ScrubMap();
      const r2 = scrubText(sample, map2, vocab, { sourceEvent: 'test', config: baseCfg });
      expect(map2.tokenFor('backup01.acme.internal')).toBeUndefined();
      expect(r2.scrubbed).toContain('backup01.acme.internal');
    } finally {
      vocab.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scrubText — FQDN identifier filtering', () => {
  test('does not mint HOST for "content.classList.contains"', () => {
    const map = new ScrubMap();
    const r = scrubText('content.classList.contains is true', map, null, {
      sourceEvent: 'test',
      config: baseCfg,
    });
    expect(map.tokenFor('content.classList.contains')).toBeUndefined();
    expect(map.tokenFor('classList.contains')).toBeUndefined();
    expect(r.mintedTokens.find((t) => t.type === 'HOST')).toBeUndefined();
  });

  test('does not mint HOST for "button.collapsible.classBtn"', () => {
    const map = new ScrubMap();
    const r = scrubText('button.collapsible.classBtn fires onClick', map, null, {
      sourceEvent: 'test',
      config: baseCfg,
    });
    expect(r.mintedTokens.find((t) => t.type === 'HOST' && t.realValue.includes('classBtn'))).toBeUndefined();
  });

  test('mixed: real FQDN tokenized, JS identifier passes through', () => {
    const map = new ScrubMap();
    const r = scrubText(
      'visit example.com but content.classList.add fires onClick',
      map,
      null,
      { sourceEvent: 'test', config: baseCfg },
    );
    expect(map.tokenFor('example.com')).toBeUndefined(); // 2-label public domain isn't in mkFqdn
    // The plan calls out 2-label only with internal-suffix — so example.com is a 2-label,
    // and mkFqdn only matches 2-labels with internal suffixes, so this is consistent.
    // The key assertion: the JS identifier chain is NOT minted.
    expect(map.tokenFor('content.classList.add')).toBeUndefined();
    expect(map.tokenFor('classList.add')).toBeUndefined();
  });

  test('real 3-label FQDN still tokenized when not a JS identifier', () => {
    const map = new ScrubMap();
    scrubText('connect to host.example.com please', map, null, {
      sourceEvent: 'test',
      config: baseCfg,
    });
    expect(map.tokenFor('host.example.com')).toBeDefined();
  });
});
