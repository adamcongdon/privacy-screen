/**
 * Config loader tests.
 * Verifies that PRIVACY_CONFIG.yaml is read, env overrides applied,
 * and defaults preserved on missing/invalid input.
 */
import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { loadConfig } from '../src/config';

const TEST_CONFIG = '/tmp/pai-privacy-config-test.yaml';

function cleanup(): void {
  if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
  delete process.env.PRIVACY_SCREEN_CONFIG;
  delete process.env.PRIVACY_SCREEN_MODE;
}

beforeEach(cleanup);
afterEach(cleanup);

describe('loadConfig', () => {
  test('returns defaults when no file exists', () => {
    const cfg = loadConfig('/nonexistent/path/PRIVACY_CONFIG.yaml');
    expect(cfg.fqdn_allowlist_extra).toEqual([]);
    expect(cfg.customer_names).toEqual([]);
    expect(cfg.fail_open_confidence).toBe(0.7);
    expect(cfg.mode).toBe('enforce');
  });

  test('loads customer_names from YAML', () => {
    writeFileSync(
      TEST_CONFIG,
      `
customer_names:
  - "Acme Corporation"
  - "Contoso Bank"
`,
    );
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.customer_names).toEqual(['Acme Corporation', 'Contoso Bank']);
  });

  test('loads fqdn_allowlist_extra from YAML', () => {
    writeFileSync(TEST_CONFIG, `fqdn_allowlist_extra:\n  - .internal.example.com\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.fqdn_allowlist_extra).toEqual(['.internal.example.com']);
  });

  test('PRIVACY_SCREEN_MODE env overrides config', () => {
    writeFileSync(TEST_CONFIG, `mode: enforce\n`);
    process.env.PRIVACY_SCREEN_MODE = 'observe';
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.mode).toBe('observe');
  });

  test('invalid mode value falls back to default', () => {
    writeFileSync(TEST_CONFIG, `mode: chaos-monkey\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.mode).toBe('enforce');
  });

  test('skip_scrub_fields has Edit defaults', () => {
    const cfg = loadConfig('/nonexistent');
    expect(cfg.skip_scrub_fields.Edit).toContain('old_string');
    expect(cfg.skip_scrub_fields.Edit).toContain('new_string');
    expect(cfg.skip_scrub_fields.Grep).toContain('pattern');
  });

  test('user can extend skip_scrub_fields for custom tools', () => {
    writeFileSync(
      TEST_CONFIG,
      `
skip_scrub_fields:
  CustomTool: ["query"]
`,
    );
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.skip_scrub_fields.CustomTool).toEqual(['query']);
    // Built-in Edit defaults still present
    expect(cfg.skip_scrub_fields.Edit).toContain('old_string');
  });

  test('malformed YAML returns defaults without throwing', () => {
    writeFileSync(TEST_CONFIG, `customer_names: [unclosed\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.customer_names).toEqual([]);
  });
});
