/**
 * Tests for `server/lib/config-writer.ts` — comment-preserving YAML round-trip
 * for the `llm_validate` block. Uses a real tempfile + env var override so
 * the writer's path resolution matches production.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';

import { patchLlmValidate } from '../server/lib/config-writer';

const TEST_CONFIG = '/tmp/pai-privacy-config-writer.yaml';

beforeEach(() => {
  if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
  process.env.PRIVACY_SCREEN_CONFIG = TEST_CONFIG;
});

afterEach(() => {
  delete process.env.PRIVACY_SCREEN_CONFIG;
  if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
});

describe('patchLlmValidate', () => {
  test('flips enabled on an existing file and preserves comments', () => {
    writeFileSync(
      TEST_CONFIG,
      `# A user comment we must keep.
mode: observe
customer_names:
  - "Acme Corp"
# Block comment about the LLM judge.
llm_validate:
  enabled: false  # was off
  model_path: ~
`,
    );
    const next = patchLlmValidate({ enabled: true });
    expect(next.llm_validate.enabled).toBe(true);
    const after = readFileSync(TEST_CONFIG, 'utf-8');
    expect(after).toContain('# A user comment we must keep.');
    expect(after).toContain('# Block comment about the LLM judge.');
    expect(after).toContain('customer_names');
  });

  test('writes model_path and updates loaded config', () => {
    writeFileSync(TEST_CONFIG, `mode: observe\nllm_validate:\n  enabled: false\n`);
    const next = patchLlmValidate({ model_path: '/tmp/some.gguf' });
    expect(next.llm_validate.model_path).toBe('/tmp/some.gguf');
    const after = readFileSync(TEST_CONFIG, 'utf-8');
    expect(after).toContain('/tmp/some.gguf');
  });

  test('creates the file from scratch when missing', () => {
    expect(existsSync(TEST_CONFIG)).toBe(false);
    const next = patchLlmValidate({ enabled: true });
    expect(existsSync(TEST_CONFIG)).toBe(true);
    expect(next.llm_validate.enabled).toBe(true);
  });

  test('appends llm_validate block when absent from existing file', () => {
    writeFileSync(TEST_CONFIG, `mode: observe\ncustomer_names: []\n`);
    const next = patchLlmValidate({ enabled: true });
    expect(next.llm_validate.enabled).toBe(true);
    const after = readFileSync(TEST_CONFIG, 'utf-8');
    expect(after).toContain('mode: observe');
    expect(after).toContain('llm_validate');
  });

  test('null model_path clears the field', () => {
    writeFileSync(
      TEST_CONFIG,
      `llm_validate:\n  enabled: false\n  model_path: /tmp/old.gguf\n`,
    );
    const next = patchLlmValidate({ model_path: null });
    expect(next.llm_validate.model_path).toBeNull();
  });

  test('partial patch leaves other fields untouched', () => {
    writeFileSync(
      TEST_CONFIG,
      `llm_validate:\n  enabled: false\n  model_path: /tmp/keep.gguf\n  timeout_ms: 5000\n`,
    );
    const next = patchLlmValidate({ enabled: true });
    expect(next.llm_validate.enabled).toBe(true);
    expect(next.llm_validate.model_path).toBe('/tmp/keep.gguf');
    expect(next.llm_validate.timeout_ms).toBe(5000);
  });

  test('survives a malformed pre-existing file by starting fresh', () => {
    writeFileSync(TEST_CONFIG, `llm_validate: [unclosed\n`);
    const next = patchLlmValidate({ enabled: true });
    // The writer accepted the patch; loader was already ignoring the broken file.
    expect(next.llm_validate.enabled).toBe(true);
  });
});
