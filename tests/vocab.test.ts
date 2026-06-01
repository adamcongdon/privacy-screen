import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { VocabStore } from '../src/vocab';
import { ScrubMap } from '../src/scrub-map';

const TEST_DB = '/tmp/pai-privacy-vocab-test.db';

function freshStore(): VocabStore {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new VocabStore(TEST_DB);
}

describe('VocabStore', () => {
  let store: VocabStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { try { store.close(); } catch {} if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

  test('persistMint saves token and can be loaded into ScrubMap', () => {
    store.persistMint('Acme Corp', '{CUSTOMER}', 'customer', 1.0);
    const map = new ScrubMap();
    store.loadIntoMap(map);
    expect(map.tokenFor('Acme Corp')).toBe('{CUSTOMER}');
  });

  test('persistMint is idempotent (upsert on hit_count)', () => {
    store.persistMint('10.0.0.1', '{IP}', 'ip', 1.0);
    store.persistMint('10.0.0.1', '{IP}', 'ip', 1.0); // second call
    const rows = store.allVocab();
    const row = rows.find((r) => r.real_value === '10.0.0.1');
    expect(row?.hit_count).toBe(2);
  });

  test('loadIntoMap reconstructs counters', () => {
    store.persistMint('host-a', '{SERVER}', 'fqdn', 0.85);
    store.persistMint('host-b', '{SERVER_1}', 'fqdn', 0.85);
    store.persistMint('host-c', '{SERVER_2}', 'fqdn', 0.85);
    const map = new ScrubMap();
    store.loadIntoMap(map);
    // Next mint should be SERVER_3
    const { token } = map.mint('SERVER', 'host-d');
    expect(token).toBe('{SERVER_3}');
  });

  test('forgetReal removes a vocab entry', () => {
    store.persistMint('Acme Corp', '{CUSTOMER}', 'customer', 1.0);
    expect(store.forgetReal('Acme Corp')).toBe(true);
    expect(store.allVocab().find((r) => r.real_value === 'Acme Corp')).toBeUndefined();
  });

  test('forgetReal returns false for unknown entry', () => {
    expect(store.forgetReal('nonexistent')).toBe(false);
  });

  test('allowlist: literal match works', () => {
    store.addAllowlist('localhost');
    expect(store.isAllowlisted('localhost')).toBe(true);
    expect(store.isAllowlisted('otherhost')).toBe(false);
  });

  test('allowlist: regex match works', () => {
    store.addAllowlist('\\.example\\.com$', true);
    expect(store.isAllowlisted('updates.example.com')).toBe(true);
    expect(store.isAllowlisted('updates.acme.com')).toBe(false);
  });

  test('addReviewItem and pendingReview', () => {
    store.addReviewItem({
      span: 'Contoso Inc',
      surrounding: '...at Contoso Inc we...',
      suggested_cat: 'customer',
      confidence: 0.65,
      source_event: 'userPromptSubmit',
    });
    const pending = store.pendingReview();
    expect(pending.length).toBe(1);
    expect(pending[0].span).toBe('Contoso Inc');
  });

  test('setReviewStatus transitions pending to confirmed', () => {
    store.addReviewItem({
      span: 'Fabrikam',
      surrounding: 'at Fabrikam',
      confidence: 0.6,
      source_event: 'preToolUse:Bash',
    });
    const [item] = store.pendingReview();
    store.setReviewStatus(item.id, 'confirmed');
    expect(store.pendingReview().length).toBe(0);
  });

  // ── findByToken (Bug 2 — ISC-4) ──────────────────────────────────────────

  test('findByToken returns the matching row by token string', () => {
    store.persistMint('Acme Corp', '{CUSTOMER}', 'customer', 1.0);
    const row = store.findByToken('{CUSTOMER}');
    expect(row).not.toBeNull();
    expect(row!.real_value).toBe('Acme Corp');
    expect(row!.token).toBe('{CUSTOMER}');
    expect(row!.category).toBe('customer');
  });

  test('findByToken returns null for unknown token', () => {
    expect(store.findByToken('{UNKNOWN_9999}')).toBeNull();
  });

  test('findByToken is case-sensitive (tokens are canonical uppercase)', () => {
    store.persistMint('Jane Doe', '{PERSON}', 'person', 1.0);
    expect(store.findByToken('{PERSON}')).not.toBeNull();
    expect(store.findByToken('{person}')).toBeNull();
  });

  test('logRedaction produces stats', () => {
    store.logRedaction('s1', 'userPromptSubmit', 2, 1, false);
    store.logRedaction('s1', 'preToolUse:Bash', 0, 1, true);
    const rows = store.stats(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].minted).toBeGreaterThanOrEqual(2);
  });
});
