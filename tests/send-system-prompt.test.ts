/**
 * SRV-04 (#77): the saved system_prompt must be scrubbed (never raw) before it
 * reaches the provider, and a credential in it must block the send.
 */
import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';
import type { PrivacyConfig } from '../src/config';
import { resolveSystemPrompt } from '../server/routes/send';

const cfg: PrivacyConfig = {
  fqdn_allowlist_extra: [],
  customer_names: [],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  skip_scrub_fields: {},
  update_channel: 'off',
  update_manifest_url:
    'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json',
  feedback_relay_url: 'https://privacy-screen-feedback.example.workers.dev',
  llm_validate: {
    enabled: false, model_path: null, runtime: 'llama-server', endpoint: null,
    max_tokens: 256, timeout_ms: 2500, min_confidence: 0.6,
  },
  hook: { auto_approve_clean: false },
};

describe('resolveSystemPrompt (SRV-04 #77)', () => {
  test('empty/undefined prompt resolves to no system arg', () => {
    expect(resolveSystemPrompt(undefined, new ScrubMap(), null, cfg).system).toBeUndefined();
    expect(resolveSystemPrompt('   ', new ScrubMap(), null, cfg).system).toBeUndefined();
  });

  test('PII in the system prompt is tokenized, never passed raw', () => {
    const map = new ScrubMap();
    const out = resolveSystemPrompt(
      'You assist Acme staff. Reach ops at 10.20.30.40 or admin@corp.example.',
      map, null, cfg,
    );
    expect(out.hasCredentials).toBe(false);
    expect(out.system).toBeDefined();
    expect(out.system!).not.toContain('10.20.30.40');
    expect(out.system!).not.toContain('admin@corp.example');
    expect(out.system!).toMatch(/\{IP\}|\{EMAIL\}/);
  });

  test('a credential in the system prompt blocks (hasCredentials true, no system)', () => {
    const out = resolveSystemPrompt(
      'Use token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12 when calling the API.',
      new ScrubMap(), null, cfg,
    );
    expect(out.hasCredentials).toBe(true);
    expect(out.system).toBeUndefined();
  });
});
