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

describe('loadConfig — llm_validate', () => {
  test('defaults to disabled with safe values', () => {
    const cfg = loadConfig('/nonexistent');
    expect(cfg.llm_validate.enabled).toBe(false);
    expect(cfg.llm_validate.model_path).toBeNull();
    expect(cfg.llm_validate.runtime).toBe('llama-server');
    expect(cfg.llm_validate.endpoint).toBeNull();
    expect(cfg.llm_validate.max_tokens).toBe(256);
    expect(cfg.llm_validate.timeout_ms).toBe(2500);
    expect(cfg.llm_validate.min_confidence).toBe(0.6);
  });

  test('YAML override round-trips every field', () => {
    writeFileSync(
      TEST_CONFIG,
      `
llm_validate:
  enabled: true
  model_path: /tmp/qwen2.5-1.5b.gguf
  runtime: llama-server
  endpoint: http://127.0.0.1:9999
  max_tokens: 128
  timeout_ms: 1000
  min_confidence: 0.75
`,
    );
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.enabled).toBe(true);
    expect(cfg.llm_validate.model_path).toBe('/tmp/qwen2.5-1.5b.gguf');
    expect(cfg.llm_validate.endpoint).toBe('http://127.0.0.1:9999');
    expect(cfg.llm_validate.max_tokens).toBe(128);
    expect(cfg.llm_validate.timeout_ms).toBe(1000);
    expect(cfg.llm_validate.min_confidence).toBe(0.75);
  });

  test('partial override keeps unspecified defaults', () => {
    writeFileSync(TEST_CONFIG, `llm_validate:\n  enabled: true\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.enabled).toBe(true);
    expect(cfg.llm_validate.max_tokens).toBe(256);
    expect(cfg.llm_validate.min_confidence).toBe(0.6);
  });

  test('invalid runtime falls back to default', () => {
    writeFileSync(TEST_CONFIG, `llm_validate:\n  runtime: openai-cloud\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.runtime).toBe('llama-server');
  });

  test('out-of-range min_confidence is rejected', () => {
    writeFileSync(TEST_CONFIG, `llm_validate:\n  min_confidence: 1.5\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.min_confidence).toBe(0.6);
  });

  test('negative timeout is rejected', () => {
    writeFileSync(TEST_CONFIG, `llm_validate:\n  timeout_ms: -100\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.timeout_ms).toBe(2500);
  });

  test('non-object llm_validate is ignored', () => {
    writeFileSync(TEST_CONFIG, `llm_validate: "yes please"\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.llm_validate.enabled).toBe(false);
  });

  // Issue #16 pentester hardening: non-HTTPS manifest URLs fall back to
  // the safe default so an http:// beacon can't leak in plaintext.
  test('http:// update_manifest_url falls back to default', () => {
    writeFileSync(TEST_CONFIG, `update_manifest_url: "http://attacker.example/manifest.json"\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.update_manifest_url.startsWith('https://')).toBe(true);
    expect(cfg.update_manifest_url).not.toContain('attacker.example');
  });

  test('malformed update_manifest_url falls back to default', () => {
    writeFileSync(TEST_CONFIG, `update_manifest_url: "not a url"\n`);
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.update_manifest_url.startsWith('https://')).toBe(true);
  });

  test('valid https:// update_manifest_url is preserved', () => {
    writeFileSync(
      TEST_CONFIG,
      `update_manifest_url: "https://example.invalid/manifest.json"\n`,
    );
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.update_manifest_url).toBe('https://example.invalid/manifest.json');
  });
});
