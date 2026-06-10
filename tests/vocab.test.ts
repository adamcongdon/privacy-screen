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

  // Issue #41 — allowlist persistence across the queue ↔ judge boundary.
  test('addReviewItem suppresses spans already on the allowlist', () => {
    store.addAllowlist('updates.example.com');
    const inserted = store.addReviewItem({
      span: 'updates.example.com',
      surrounding: 'GET updates.example.com/manifest',
      suggested_cat: 'fqdn',
      confidence: 0.7,
      source_event: 'judge:userPromptSubmit',
    });
    expect(inserted).toBe(false);
    expect(store.pendingReview().length).toBe(0);
  });

  test('addReviewItem respects regex allowlist entries', () => {
    store.addAllowlist('\\.example\\.com$', true);
    const inserted = store.addReviewItem({
      span: 'mirror.example.com',
      surrounding: 'hit mirror.example.com',
      confidence: 0.8,
      source_event: 'judge:userPromptSubmit',
    });
    expect(inserted).toBe(false);
    expect(store.pendingReview().length).toBe(0);
  });

  test('pendingReview filters out items whose span was allowlisted after enqueue', () => {
    // Reproduces the user-reported flow: queue gets seeded first, then the
    // user allowlists the same span. Without the read-time filter, the row
    // keeps appearing on every refresh until the user clicks it.
    store.addReviewItem({
      span: 'controller.local',
      surrounding: 'connect controller.local 443',
      confidence: 0.6,
      source_event: 'judge:userPromptSubmit',
    });
    expect(store.pendingReview().length).toBe(1);
    store.addAllowlist('controller.local');
    expect(store.pendingReview().length).toBe(0);
  });

  test('addReviewItem returns true and persists when no allowlist match', () => {
    const inserted = store.addReviewItem({
      span: 'NewCustomer Ltd',
      surrounding: 'meeting with NewCustomer Ltd',
      confidence: 0.65,
      source_event: 'judge:userPromptSubmit',
    });
    expect(inserted).toBe(true);
    expect(store.pendingReview().length).toBe(1);
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

describe('induced_patterns', () => {
  let store: VocabStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { try { store.close(); } catch {} if (existsSync(TEST_DB)) unlinkSync(TEST_DB); });

  function seedPattern(overrides?: Partial<{ category: string; regex_source: string; confidence: number }>) {
    return store.persistInducedPattern({
      category: overrides?.category ?? 'customer',
      regex_source: overrides?.regex_source ?? '\\bINC-\\d{5}\\b',
      skeleton: '\\bINC-\\d{5}\\b',
      source_examples: ['INC-12345', 'INC-99001', 'INC-00042'],
      confidence: overrides?.confidence ?? 0.8,
    });
  }

  test('persistInducedPattern inserts and returns a positive id', () => {
    const id = seedPattern();
    expect(id).toBeGreaterThan(0);
  });

  test('pendingPatterns returns inserted pattern with status pending', () => {
    seedPattern();
    const rows = store.pendingPatterns();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].category).toBe('customer');
    expect(rows[0].regex_source).toBe('\\bINC-\\d{5}\\b');
  });

  test('activePatterns returns only active patterns', () => {
    const id = seedPattern();
    expect(store.activePatterns().length).toBe(0);
    store.setInducedStatus(id, 'active');
    expect(store.activePatterns().length).toBe(1);
    expect(store.pendingPatterns().length).toBe(0);
  });

  test('setInducedStatus transitions to rejected', () => {
    const id = seedPattern();
    store.setInducedStatus(id, 'rejected');
    expect(store.pendingPatterns().length).toBe(0);
    expect(store.activePatterns().length).toBe(0);
  });

  test('updateInducedRegex changes regex_source', () => {
    const id = seedPattern();
    store.updateInducedRegex(id, '\\bINC-\\d{4,6}\\b');
    const row = store.pendingPatterns()[0];
    expect(row.regex_source).toBe('\\bINC-\\d{4,6}\\b');
  });

  test('bumpInducedHit increments hit_count', () => {
    const id = seedPattern();
    store.setInducedStatus(id, 'active');
    store.bumpInducedHit(id);
    store.bumpInducedHit(id);
    const row = store.activePatterns()[0];
    expect(row.hit_count).toBe(2);
  });

  test('deleteInducedPattern removes the row', () => {
    const id = seedPattern();
    store.deleteInducedPattern(id);
    expect(store.pendingPatterns().length).toBe(0);
  });

  test('source_examples stored as JSON array', () => {
    seedPattern();
    const row = store.pendingPatterns()[0];
    const parsed = JSON.parse(row.source_examples);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain('INC-12345');
  });

  test('vocabByCategory returns only rows for that category', () => {
    store.persistMint('Acme Corp', '{CUSTOMER}', 'customer', 1.0);
    store.persistMint('10.0.0.1', '{IP}', 'ip', 1.0);
    const cust = store.vocabByCategory('customer');
    expect(cust.length).toBe(1);
    expect(cust[0].real_value).toBe('Acme Corp');
  });

  test('categoriesAboveThreshold returns categories with enough entries', () => {
    store.persistMint('Acme Corp', '{CUSTOMER}', 'customer', 1.0);
    store.persistMint('Contoso', '{CUSTOMER_1}', 'customer', 1.0);
    store.persistMint('Fabrikam', '{CUSTOMER_2}', 'customer', 1.0);
    store.persistMint('10.0.0.1', '{IP}', 'ip', 1.0);
    const cats = store.categoriesAboveThreshold(3);
    expect(cats.some((c) => c.category === 'customer' && c.count >= 3)).toBe(true);
    expect(cats.some((c) => c.category === 'ip')).toBe(false); // only 1 ip entry
  });
});
