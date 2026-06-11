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

  describe('serialize / deserialize round-trip', () => {
    test('happy path: tokens and reals survive round-trip', () => {
      const src = new ScrubMap();
      src.mint('CUSTOMER', 'Acme Corp');
      src.mint('IP', '10.0.5.1');
      src.mint('IP', '10.0.5.2');

      const envelope = src.serialize();
      expect(envelope.v).toBe(1);
      expect(envelope.entries.length).toBe(3);

      const dst = ScrubMap.deserialize(envelope);
      expect(dst.tokenFor('Acme Corp')).toBe('{CUSTOMER}');
      expect(dst.realFor('{CUSTOMER}')).toBe('Acme Corp');
      expect(dst.tokenFor('10.0.5.1')).toBe('{IP}');
      expect(dst.tokenFor('10.0.5.2')).toBe('{IP_1}');
    });

    test('counter preserved across deserialize', () => {
      const src = new ScrubMap();
      src.mint('IP', '1.1.1.1');
      src.mint('IP', '2.2.2.2');
      src.mint('IP', '3.3.3.3');

      const dst = ScrubMap.deserialize(src.serialize());
      // Counter must be at 3, so next mint produces {IP_3}, not a collision.
      const { token } = dst.mint('IP', '4.4.4.4');
      expect(token).toBe('{IP_3}');
    });

    test('malformed payload throws: null', () => {
      expect(() => ScrubMap.deserialize(null)).toThrow();
    });

    test('malformed payload throws: empty object', () => {
      expect(() => ScrubMap.deserialize({})).toThrow();
    });

    test('malformed payload throws: wrong version', () => {
      expect(() => ScrubMap.deserialize({ v: 2, entries: [] })).toThrow();
    });

    test('malformed payload throws: entries not an array', () => {
      expect(() => ScrubMap.deserialize({ v: 1, entries: 'nope' })).toThrow();
    });

    test('malformed individual entries are skipped', () => {
      const map = ScrubMap.deserialize({
        v: 1,
        entries: [
          { token: '{X}', real: 'x' },
          { token: 42 }, // bad — dropped
        ],
      });
      expect(map.realFor('{X}')).toBe('x');
      expect(map.size).toBe(1);
    });
  });

  // TDD for #63 (SCR-10): perf + correctness for apply() regex memoization.
  // 5k-row vocab simulation + 200 "cell" applies. Must be behavior-identical to uncached.
  // RED now (uncached): each apply rebuilds+recompiles giant alternation.
  describe('SCR-10 apply cache TDD', () => {
    test('large map apply produces identical output before/after (correctness) and meets perf budget', () => {
      const map = new ScrubMap();
      const N = 5000;
      // Realistic-ish longish literals to exercise alternation cost (simulates real PII values in vocab).
      for (let i = 0; i < N; i++) {
        const real = i % 7 === 0
          ? `Acme Customer ${i} Incorporated`
          : i % 5 === 0
          ? `user${i}@internal.example-${(i%20)}.local`
          : `server-host-${i}-prod`;
        map.mint('ITEM', real);
      }

      // Simulate 200-cell sheet: 200 independent cell values, some will match entries.
      const cells: string[] = [];
      for (let c = 0; c < 200; c++) {
        const idx = (c * 17) % N;
        const base = c % 3 === 0
          ? `Contact Acme Customer ${idx} Incorporated for order ${c}`
          : `Log from server-host-${idx}-prod at ${c}`;
        cells.push(base);
      }

      // Capture "golden" scrubbed using current (will be cached later) behavior.
      const goldens = cells.map((cell) => map.apply(cell));

      // Perf measurement over the 200 applies (core hot path exercised by xlsx per-cell + scrubText).
      const start = performance.now();
      const results = cells.map((cell) => map.apply(cell));
      const dur = performance.now() - start;

      // Correctness: identical results (behavior must not change with memo).
      for (let i = 0; i < results.length; i++) {
        expect(results[i]).toBe(goldens[i]);
      }
      // Spot real substitutions: at least some cells must have been mapped (exercises the alternation).
      const anyTokenized = results.some((r) => /\{ITEM(_\d+)?\}/.test(r));
      expect(anyTokenized).toBe(true);

      // Stated budget per acceptance (tight for TDD RED/GREEN): 200 applies against 5k vocab < 5 ms.
      // Forces cache of alternation regex. (Currently RED: each apply does O(n) sort + new RegExp on 5k terms.)
      expect(dur).toBeLessThan(5);
      // Also log for visible evidence in test output (red/green).
      console.log(`[TDD #63] 5k-map 200-apply dur=${dur.toFixed(2)}ms (budget<5)`);
    });

    test('apply cache invalidates on mint (subsequent apply sees new entry)', () => {
      const map = new ScrubMap();
      map.mint('FOO', 'alpha');
      expect(map.apply('see alpha here')).toBe('see {FOO} here');
      map.mint('FOO', 'beta');
      expect(map.apply('see beta here')).toBe('see {FOO_1} here');
    });

    test('apply cache invalidates on loadFromRows', () => {
      const map = new ScrubMap();
      map.loadFromRows([{ real_value: 'gamma', token: '{BAR}' }]);
      expect(map.apply('gamma value')).toBe('{BAR} value');
    });
  });

  // SCR-07 TDD boundary (red pre, green post)
  test('apply unicode-aware boundaries fire next to non-ASCII letters', () => {
    const map = new ScrubMap();
    map.mint('PERSON', 'José García');
    const text = 'Contact José García here. Glued: αJosé Garcíaβ end.';
    const result = map.apply(text);
    expect(result).toContain('{PERSON}');
    expect(result).toContain('Contact {PERSON} here.');
    expect(result).toContain('αJosé Garcíaβ');
    expect(result).not.toContain('α{PERSON}β');
  });
});
