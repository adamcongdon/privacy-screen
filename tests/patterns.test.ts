/**
 * Pattern tests for the OpenAI-taxonomy parity categories.
 * Validates phone, address, credit card, URL, and extended credentials
 * detect correctly in isolation before they're plumbed through the scrubber.
 */
import { describe, test, expect } from 'bun:test';
import {
  mkPhone, mkStreetAddress, mkCreditCard, mkUrlPath,
  mkCredential, mkCorpEntity, mkSensitiveKV,
  mkPersonFromHeader, mkPersonAdjacentToEmail, mkSignOffName,
  NAME_DENYLIST, isValidPersonName, looksLikeIdentifier, looksLikeDate,
} from '../src/patterns';

function findAll(text: string, rx: RegExp): string[] {
  return [...text.matchAll(rx)].map((m) => m[0]);
}

describe('mkPhone', () => {
  test('matches parenthesized US format', () => {
    expect(findAll('Call (555) 123-4567 today', mkPhone())).toEqual(['(555) 123-4567']);
  });
  test('matches dashed US format', () => {
    expect(findAll('Reach 555-123-4567 anytime', mkPhone())).toEqual(['555-123-4567']);
  });
  test('matches +1 country code', () => {
    expect(findAll('Dial +1 555-123-4567 first', mkPhone())).toEqual(['+1 555-123-4567']);
  });
  test('matches international E.164-ish', () => {
    expect(findAll('From +44 20 7946 0958', mkPhone())).toEqual(['+44 20 7946 0958']);
  });
  test('does NOT match 10 consecutive digits without separators (timestamps/IDs)', () => {
    expect(findAll('record 5551234567 not a phone', mkPhone())).toEqual([]);
  });
  test('matches phone at end of sentence with trailing period (regression)', () => {
    expect(findAll('call (555) 123-4567.', mkPhone())).toEqual(['(555) 123-4567']);
  });
});

import { mkUncPath } from '../src/patterns';

describe('mkUncPath — regression: greedy match must not eat trailing text', () => {
  test('UNC path stops at whitespace; does NOT swallow following text', () => {
    const txt = 'backup to \\\\fileserver01\\Backups\\nightly and token sk-ant-xxx is here';
    const matches = findAll(txt, mkUncPath());
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('\\\\fileserver01\\Backups\\nightly');
    // critical: must NOT include "and token sk-ant-xxx is here"
    expect(matches[0]).not.toContain('sk-ant');
    expect(matches[0]).not.toContain('token');
  });
  test('UNC path stops at newline', () => {
    const txt = 'path \\\\srv\\share\\data\nfollowing line';
    expect(findAll(txt, mkUncPath())).toEqual(['\\\\srv\\share\\data']);
  });
});

describe('mkStreetAddress', () => {
  test('matches "123 Main Street"', () => {
    expect(findAll('lives at 123 Main Street.', mkStreetAddress())).toEqual(['123 Main Street']);
  });
  test('matches abbreviated suffix', () => {
    expect(findAll('456 Oak Ave is the address', mkStreetAddress())).toEqual(['456 Oak Ave']);
  });
  test('matches multi-word street name', () => {
    expect(findAll('789 North Park Avenue here', mkStreetAddress())).toEqual([
      '789 North Park Avenue',
    ]);
  });
  test('does NOT match number followed by lowercase word', () => {
    expect(findAll('the 42 number is fine', mkStreetAddress())).toEqual([]);
  });
});

describe('mkCreditCard', () => {
  test('matches Visa-prefix card', () => {
    expect(findAll('charge 4111 1111 1111 1111 please', mkCreditCard())).toEqual([
      '4111 1111 1111 1111',
    ]);
  });
  test('matches Mastercard', () => {
    expect(findAll('5555-5555-5555-4444 expires soon', mkCreditCard())).toEqual([
      '5555-5555-5555-4444',
    ]);
  });
  test('matches no-separator card', () => {
    expect(findAll('use 4111111111111111 now', mkCreditCard())).toEqual(['4111111111111111']);
  });
});

describe('mkUrlPath', () => {
  test('matches full URL with path', () => {
    expect(findAll('see https://internal.acme.com/secret/123', mkUrlPath())).toEqual([
      'https://internal.acme.com/secret/123',
    ]);
  });
  test('matches URL with query string', () => {
    expect(findAll('hit http://foo.com/?token=abc&x=1 once', mkUrlPath())).toEqual([
      'http://foo.com/?token=abc&x=1',
    ]);
  });
});

describe('mkCredential — extended set', () => {
  test('detects JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(findAll(jwt, mkCredential())).toHaveLength(1);
  });
  test('detects AWS access key id', () => {
    expect(findAll('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', mkCredential())).toEqual([
      'AKIAIOSFODNN7EXAMPLE',
    ]);
  });
  test('detects Bearer header', () => {
    expect(
      findAll('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', mkCredential()),
    ).toHaveLength(1);
  });
  test('detects Azure connection string AccountKey', () => {
    const azure = 'AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==';
    expect(findAll(azure, mkCredential())).toHaveLength(1);
  });
  test('detects Slack token', () => {
    expect(findAll('slack: xoxb-1234567890-abcdefghij', mkCredential())).toEqual([
      'xoxb-1234567890-abcdefghij',
    ]);
  });
});

describe('mkCorpEntity', () => {
  test('matches "Acme Corp"', () => {
    expect(findAll('the Acme Corp account', mkCorpEntity())).toEqual(['Acme Corp']);
  });
  test('matches "Contoso Inc"', () => {
    expect(findAll('Contoso Inc is the customer', mkCorpEntity())).toEqual(['Contoso Inc']);
  });
  test('matches "Fabrikam LLC"', () => {
    expect(findAll('Fabrikam LLC engaged', mkCorpEntity())).toEqual(['Fabrikam LLC']);
  });
  test('matches "Northwind Bank"', () => {
    expect(findAll('at Northwind Bank yesterday', mkCorpEntity())).toEqual(['Northwind Bank']);
  });
  test('does NOT match isolated suffix without capitalized prefix', () => {
    expect(findAll('a corp of one Inc is here', mkCorpEntity())).toEqual([]);
  });
});

describe('mkSensitiveKV', () => {
  test('matches password=foo', () => {
    expect(findAll('connection=password=hunter2 fine', mkSensitiveKV())).toHaveLength(1);
  });
  test('matches api_key: foo', () => {
    expect(findAll('api_key: abc123xyz', mkSensitiveKV())).toHaveLength(1);
  });
  test('matches quoted value', () => {
    expect(findAll('secret="hunter2"', mkSensitiveKV())).toHaveLength(1);
  });
});

// ── Person name detection (Feature 1) ────────────────────────────────────────

function captureGroups(text: string, rx: RegExp): string[] {
  return [...text.matchAll(rx)].map((m) => m[1]);
}

describe('mkPersonFromHeader', () => {
  test('extracts "Vincent Tidwell" from "From: Vincent Tidwell <vt@example.com>"', () => {
    const captures = captureGroups('From: Vincent Tidwell <vt@example.com>', mkPersonFromHeader());
    expect(captures).toContain('Vincent Tidwell');
  });
  test('extracts each name from a multi-recipient Cc line', () => {
    const text =
      'Cc: Blake Sheffield <bs@example.com>; Chad Aiken <ca@example.com>; Mike Bova <mb@example.com>';
    const captures = captureGroups(text, mkPersonFromHeader());
    expect(captures).toContain('Blake Sheffield');
    expect(captures).toContain('Chad Aiken');
    expect(captures).toContain('Mike Bova');
    expect(captures.length).toBe(3);
  });
  test('extracts from To: header anchored at line start', () => {
    const text = '\nTo: Alex Stone <as@example.com>';
    const captures = captureGroups(text, mkPersonFromHeader());
    expect(captures).toContain('Alex Stone');
  });
});

describe('mkPersonAdjacentToEmail', () => {
  test('extracts "Vincent Tidwell" from "ping Vincent Tidwell <vt@example.com>"', () => {
    const captures = captureGroups('ping Vincent Tidwell <vt@example.com>', mkPersonAdjacentToEmail());
    expect(captures).toContain('Vincent Tidwell');
  });
  test('extracts when the email is shortly after the name', () => {
    const captures = captureGroups(
      'reach out to Mike Bova later — mike.bova@example.com',
      mkPersonAdjacentToEmail(),
    );
    expect(captures).toContain('Mike Bova');
  });
});

describe('mkSignOffName', () => {
  test('extracts "Mike Bova" from "Best,\\nMike Bova"', () => {
    const text = 'Long body here.\n\nBest,\nMike Bova\n';
    const captures = captureGroups(text, mkSignOffName());
    expect(captures).toContain('Mike Bova');
  });
  test('extracts after "Thanks,"', () => {
    const text = 'cool!\n\nThanks,\nAlex Stone';
    const captures = captureGroups(text, mkSignOffName());
    expect(captures).toContain('Alex Stone');
  });
});

describe('NAME_DENYLIST', () => {
  test('contains weekdays', () => {
    expect(NAME_DENYLIST.has('monday')).toBe(true);
    expect(NAME_DENYLIST.has('sunday')).toBe(true);
  });
  test('contains full and abbreviated months', () => {
    expect(NAME_DENYLIST.has('january')).toBe(true);
    expect(NAME_DENYLIST.has('december')).toBe(true);
    expect(NAME_DENYLIST.has('jan')).toBe(true);
    expect(NAME_DENYLIST.has('sept')).toBe(true);
  });
  test('contains email header words', () => {
    expect(NAME_DENYLIST.has('from')).toBe(true);
    expect(NAME_DENYLIST.has('to')).toBe(true);
    expect(NAME_DENYLIST.has('cc')).toBe(true);
    expect(NAME_DENYLIST.has('subject')).toBe(true);
  });
  test('contains sign-off words', () => {
    expect(NAME_DENYLIST.has('best')).toBe(true);
    expect(NAME_DENYLIST.has('thanks')).toBe(true);
    expect(NAME_DENYLIST.has('regards')).toBe(true);
  });
});

describe('isValidPersonName', () => {
  test('returns true for a normal two-token name', () => {
    expect(isValidPersonName('Vincent Tidwell', [])).toBe(true);
  });
  test('returns false for a single token', () => {
    expect(isValidPersonName('Vincent', [])).toBe(false);
  });
  test('returns false when a token is in NAME_DENYLIST', () => {
    expect(isValidPersonName('From Bob', [])).toBe(false);
    expect(isValidPersonName('Best Wishes', [])).toBe(false);
    expect(isValidPersonName('Monday Morning', [])).toBe(false);
  });
  test('returns false when the name is allowlisted', () => {
    expect(isValidPersonName('Vincent Tidwell', ['Vincent Tidwell'])).toBe(false);
  });
  test('allowlist comparison is case-insensitive', () => {
    expect(isValidPersonName('Vincent Tidwell', ['vincent tidwell'])).toBe(false);
  });
  test('returns false for a name longer than 60 chars', () => {
    const long = 'A' + 'b'.repeat(30) + ' C' + 'd'.repeat(30);
    expect(isValidPersonName(long, [])).toBe(false);
  });
  test('returns false when a token does not start with uppercase', () => {
    expect(isValidPersonName('vincent Tidwell', [])).toBe(false);
  });
});

describe('looksLikeDate', () => {
  // positive — all-numeric segments, 2+ segments
  test('returns true for "13.05.2026" (DD.MM.YYYY)', () => {
    expect(looksLikeDate('13.05.2026')).toBe(true);
  });
  test('returns true for "2026.05.13" (YYYY.MM.DD)', () => {
    expect(looksLikeDate('2026.05.13')).toBe(true);
  });
  test('returns true for "1.2.3" (all numeric segments)', () => {
    expect(looksLikeDate('1.2.3')).toBe(true);
  });
  test('returns true for "2024.12" (2-segment all-numeric)', () => {
    expect(looksLikeDate('2024.12')).toBe(true);
  });
  // negative — has non-numeric segment(s)
  test('returns false for "server.example.com"', () => {
    expect(looksLikeDate('server.example.com')).toBe(false);
  });
  test('returns false for "host.local"', () => {
    expect(looksLikeDate('host.local')).toBe(false);
  });
  test('returns false for "a.b.c" (alpha segments)', () => {
    expect(looksLikeDate('a.b.c')).toBe(false);
  });
  test('returns false for empty string', () => {
    expect(looksLikeDate('')).toBe(false);
  });
  test('returns false for a single segment with no dot', () => {
    expect(looksLikeDate('20260513')).toBe(false);
  });
});

describe('looksLikeIdentifier', () => {
  test('returns true for a JS classList chain', () => {
    expect(looksLikeIdentifier('content.classList.contains')).toBe(true);
  });
  test('returns true for a camelCase segment', () => {
    expect(looksLikeIdentifier('button.collapsible.classBtn')).toBe(true);
  });
  test('returns true for "el.classList.contains"', () => {
    expect(looksLikeIdentifier('el.classList.contains')).toBe(true);
  });
  test('returns true for "Array.prototype.indexOf"', () => {
    expect(looksLikeIdentifier('Array.prototype.indexOf')).toBe(true);
  });
  test('returns false for "example.com"', () => {
    expect(looksLikeIdentifier('example.com')).toBe(false);
  });
  test('returns false for "www.google.com"', () => {
    expect(looksLikeIdentifier('www.google.com')).toBe(false);
  });
  test('returns false for "host.acme.com"', () => {
    expect(looksLikeIdentifier('host.acme.com')).toBe(false);
  });
});
