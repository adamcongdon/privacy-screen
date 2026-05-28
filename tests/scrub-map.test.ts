import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';

describe('ScrubMap', () => {
  test('first instance produces unqualified token', () => {
    const map = new ScrubMap();
    const { token } = map.mint('CUSTOMER', 'Acme Corp');
    expect(token).toBe('{CUSTOMER}');
  });

  test('subsequent instances produce numbered tokens', () => {
    const map = new ScrubMap();
    const t0 = map.mint('SERVER', 'server-a').token;
    const t1 = map.mint('SERVER', 'server-b').token;
    const t2 = map.mint('SERVER', 'server-c').token;
    expect(t0).toBe('{SERVER}');
    expect(t1).toBe('{SERVER_1}');
    expect(t2).toBe('{SERVER_2}');
  });

  test('same input returns same token (idempotent)', () => {
    const map = new ScrubMap();
    const r1 = map.mint('CUSTOMER', 'Acme Corp');
    const r2 = map.mint('CUSTOMER', 'Acme Corp');
    expect(r1.token).toBe(r2.token);
    expect(r2.isNew).toBe(false);
  });

  test('lookup is case-insensitive', () => {
    const map = new ScrubMap();
    map.mint('CUSTOMER', 'Acme Corp');
    expect(map.tokenFor('acme corp')).toBe('{CUSTOMER}');
    expect(map.tokenFor('ACME CORP')).toBe('{CUSTOMER}');
    expect(map.tokenFor('Acme Corp')).toBe('{CUSTOMER}');
  });

  test('adversarial guard: token-shaped input is refused', () => {
    const map = new ScrubMap();
    const { token, isNew } = map.mint('CUSTOMER', '{CUSTOMER}');
    expect(token).toBe('{CUSTOMER}');
    expect(isNew).toBe(false);
    expect(map.tokenFor('{CUSTOMER}')).toBeUndefined();
  });

  test('adversarial guard: numbered token-shaped input is refused', () => {
    const map = new ScrubMap();
    const { token } = map.mint('SERVER', '{SERVER_1}');
    expect(token).toBe('{SERVER_1}');
    expect(map.size).toBe(0);
  });

  test('apply substitutes longest match first', () => {
    const map = new ScrubMap();
    map.mint('SERVER', 'server01');
    map.mint('SERVER', 'server01.acme.com');
    const text = 'Connect to server01.acme.com and server01';
    const result = map.apply(text);
    // server01.acme.com must not be partially matched as server01
    expect(result).not.toContain('server01.acme.com');
    expect(result).toContain('{SERVER_1}'); // the FQDN token
    expect(result).toContain('{SERVER}');   // the short name token
  });

  test('restore reverses substitution', () => {
    const map = new ScrubMap();
    map.mint('CUSTOMER', 'Acme Corp');
    map.mint('IP', '10.0.5.1');
    const original = 'Customer Acme Corp has IP 10.0.5.1';
    const scrubbed = map.apply(original);
    const restored = map.restore(scrubbed);
    expect(restored).toBe(original);
  });

  test('restore longest-token-first prevents partial replacement', () => {
    const map = new ScrubMap();
    // Simulate {SERVER_10} and {SERVER_1} both present
    map.loadFromRows([
      { real_value: 'host-a', token: '{SERVER}' },
      { real_value: 'host-b', token: '{SERVER_1}' },
      { real_value: 'host-c', token: '{SERVER_10}' },
    ]);
    const text = '{SERVER_10} and {SERVER_1}';
    const restored = map.restore(text);
    expect(restored).toBe('host-c and host-b');
  });

  test('empty map: apply returns text unchanged', () => {
    const map = new ScrubMap();
    expect(map.apply('hello world')).toBe('hello world');
  });

  test('empty string: apply returns empty string', () => {
    const map = new ScrubMap();
    expect(map.apply('')).toBe('');
  });

  test('loadFromRows reconstructs counters correctly', () => {
    const map = new ScrubMap();
    map.loadFromRows([
      { real_value: 'a', token: '{SERVER}' },
      { real_value: 'b', token: '{SERVER_1}' },
      { real_value: 'c', token: '{SERVER_2}' },
    ]);
    // Next mint should be SERVER_3
    const { token } = map.mint('SERVER', 'd');
    expect(token).toBe('{SERVER_3}');
  });
});
