/**
 * PRIVACY_CONFIG.yaml loader.
 *
 * Resolution order:
 *   1. $PRIVACY_SCREEN_CONFIG (explicit override)
 *   2. ./PRIVACY_CONFIG.yaml (relative to CWD)
 *   3. <project_root>/PRIVACY_CONFIG.yaml (relative to this file)
 *   4. Built-in defaults (no file = no extra config, sane defaults)
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

export type Mode = 'enforce' | 'observe' | 'disabled';

/**
 * Update channel. `off` is the default and means: no network activity ever.
 * `stable` / `beta` enable a single HTTPS GET to the release manifest on
 * version-check requests. See Plans/INSTALLER.md.
 */
export type UpdateChannel = 'off' | 'stable' | 'beta';

/**
 * LLM secondary-validation runtime. Only `llama-server` is supported in v1
 * (llama.cpp's HTTP server). The judge is opt-in and runs out-of-band — the
 * regex+vocab scrubber remains the safety-critical synchronous gate.
 *
 * See `Plans/LLM_RESEARCH.md` and `SAFETY_CHECKLIST.md`.
 */
export type LlmRuntime = 'llama-server';

export interface LlmValidateConfig {
  /** Master switch. Default false — judge is fully opt-in. */
  enabled: boolean;
  /** Absolute path to the GGUF model file. null = not installed. */
  model_path: string | null;
  /** Inference runtime. Only `llama-server` is supported in v1. */
  runtime: LlmRuntime;
  /**
   * External endpoint URL. null = the server lazy-starts its own llama-server
   * subprocess on a random loopback port. If set, MUST resolve to 127.0.0.1
   * or localhost — the hook refuses to POST to non-loopback hosts.
   */
  endpoint: string | null;
  /** Hard cap on judge response tokens. */
  max_tokens: number;
  /** Per-call wall-clock budget on the server side (ms). */
  timeout_ms: number;
  /** Spans below this confidence are dropped before reaching the review queue. */
  min_confidence: number;
}

export interface PrivacyConfig {
  /** Extra FQDN suffixes never to tokenize (e.g. ".helios.veeam.com"). */
  fqdn_allowlist_extra: string[];
  /** Customer names — always tokenized as {CUST_N}. Case-insensitive match. */
  customer_names: string[];
  /**
   * Person names — always pre-minted as {PERSON_N}. Use for known colleagues
   * who should be tokenized even when they don't show up in a header slot.
   */
  person_names: string[];
  /**
   * Allowlist for person-name detection — names that pass the heuristics but
   * should NOT be tokenized (e.g. your own name, public figures in quotes).
   */
  name_allowlist: string[];
  /** Below this confidence, detections go to review queue + block (fail-closed). */
  fail_open_confidence: number;
  /** Categories that ALWAYS block — never tokenize, never allow through. */
  fail_closed_categories: string[];
  /** Absolute path to vocab.db. null = default ($HOME/.claude/PAI/MEMORY/SCRUBBER/vocab.db). */
  db_path: string | null;
  /**
   * Operating mode:
   *   'enforce'  — block prompts + mutate tool inputs (default once enabled).
   *   'observe'  — log detections but allow through unmutated. Use for rollout.
   *   'disabled' — no-op; useful for emergency bypass without unregistering hooks.
   */
  mode: Mode;
  /** Per-tool input-field policy. Maps tool name → array of fields to skip scrubbing. */
  skip_scrub_fields: Record<string, string[]>;
  /**
   * Opt-in version-check channel. Default `off` — zero network activity.
   * `stable` / `beta` cause `/api/version` to perform a single HTTPS GET
   * to `update_manifest_url`. No telemetry, no auto-install. See
   * `Plans/INSTALLER.md`.
   */
  update_channel: UpdateChannel;
  /** URL of the release manifest (JSON). Used only when `update_channel !== 'off'`. */
  update_manifest_url: string;
  /**
   * Opt-in LLM secondary validator. The judge runs AFTER the regex+vocab
   * scrubber, sees the already-scrubbed text, and can only add items to the
   * review queue — never mutate the hot-path output. Disabled by default;
   * requires `bun cli/PrivacyScreen.ts install-judge` and a running server.
   * See `Plans/LLM_RESEARCH.md`.
   */
  llm_validate: LlmValidateConfig;
}

const DEFAULTS: PrivacyConfig = {
  fqdn_allowlist_extra: [],
  customer_names: [],
  person_names: [],
  name_allowlist: [],
  fail_open_confidence: 0.7,
  fail_closed_categories: ['credential'],
  db_path: null,
  mode: 'enforce',
  /**
   * Fields whose contents must round-trip through the tool unmodified.
   * Scrubbing old_string would make Edit fail to match the file.
   * Scrubbing Grep/Glob patterns would make searches miss real strings.
   * file_path / path are scrubbed normally — they don't need string-match.
   */
  skip_scrub_fields: {
    Edit: ['old_string', 'new_string'],
    MultiEdit: ['edits'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    NotebookEdit: ['old_string', 'new_string'],
  },
  update_channel: 'off',
  update_manifest_url:
    'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json',
  llm_validate: {
    enabled: false,
    model_path: null,
    runtime: 'llama-server',
    endpoint: null,
    max_tokens: 256,
    timeout_ms: 2500,
    min_confidence: 0.6,
  },
};

export function loadConfig(explicitPath?: string): PrivacyConfig {
  const path = explicitPath ?? findConfigPath();
  if (!path || !existsSync(path)) return applyEnvOverrides(DEFAULTS);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[PrivacyScreen] PRIVACY_CONFIG.yaml parse error: ${err}\n`);
    return applyEnvOverrides(DEFAULTS);
  }
  const merged = mergeConfig(DEFAULTS, raw);
  return applyEnvOverrides(merged);
}

function findConfigPath(): string | null {
  const candidates: Array<string | undefined> = [
    process.env.PRIVACY_SCREEN_CONFIG,
    join(process.cwd(), 'PRIVACY_CONFIG.yaml'),
    resolve(import.meta.dir, '..', 'PRIVACY_CONFIG.yaml'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function mergeConfig(base: PrivacyConfig, override: unknown): PrivacyConfig {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;

  return {
    fqdn_allowlist_extra: arrayOfStrings(o.fqdn_allowlist_extra, base.fqdn_allowlist_extra),
    customer_names: arrayOfStrings(o.customer_names, base.customer_names),
    person_names: arrayOfStrings(o.person_names, base.person_names),
    name_allowlist: arrayOfStrings(o.name_allowlist, base.name_allowlist),
    fail_open_confidence:
      typeof o.fail_open_confidence === 'number' ? o.fail_open_confidence : base.fail_open_confidence,
    fail_closed_categories: arrayOfStrings(o.fail_closed_categories, base.fail_closed_categories),
    db_path: typeof o.db_path === 'string' && o.db_path.length > 0 ? o.db_path : base.db_path,
    mode: isMode(o.mode) ? o.mode : base.mode,
    skip_scrub_fields: mergeSkipFields(base.skip_scrub_fields, o.skip_scrub_fields),
    update_channel: isUpdateChannel(o.update_channel) ? o.update_channel : base.update_channel,
    update_manifest_url:
      typeof o.update_manifest_url === 'string' && o.update_manifest_url.length > 0
        ? o.update_manifest_url
        : base.update_manifest_url,
    llm_validate: mergeLlmValidate(base.llm_validate, o.llm_validate),
  };
}

function applyEnvOverrides(cfg: PrivacyConfig): PrivacyConfig {
  const envMode = process.env.PRIVACY_SCREEN_MODE;
  if (envMode && isMode(envMode)) {
    return { ...cfg, mode: envMode };
  }
  return cfg;
}

function arrayOfStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function isMode(v: unknown): v is Mode {
  return v === 'enforce' || v === 'observe' || v === 'disabled';
}

function isUpdateChannel(v: unknown): v is UpdateChannel {
  return v === 'off' || v === 'stable' || v === 'beta';
}

function isLlmRuntime(v: unknown): v is LlmRuntime {
  return v === 'llama-server';
}

function mergeLlmValidate(
  base: LlmValidateConfig,
  override: unknown,
): LlmValidateConfig {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    model_path:
      typeof o.model_path === 'string' && o.model_path.length > 0
        ? o.model_path
        : base.model_path,
    runtime: isLlmRuntime(o.runtime) ? o.runtime : base.runtime,
    endpoint:
      typeof o.endpoint === 'string' && o.endpoint.length > 0
        ? o.endpoint
        : base.endpoint,
    max_tokens:
      typeof o.max_tokens === 'number' && o.max_tokens > 0
        ? Math.floor(o.max_tokens)
        : base.max_tokens,
    timeout_ms:
      typeof o.timeout_ms === 'number' && o.timeout_ms > 0
        ? Math.floor(o.timeout_ms)
        : base.timeout_ms,
    min_confidence:
      typeof o.min_confidence === 'number' &&
      o.min_confidence >= 0 &&
      o.min_confidence <= 1
        ? o.min_confidence
        : base.min_confidence,
  };
}

function mergeSkipFields(
  base: Record<string, string[]>,
  override: unknown,
): Record<string, string[]> {
  if (!override || typeof override !== 'object') return base;
  const out: Record<string, string[]> = { ...base };
  for (const [tool, fields] of Object.entries(override as Record<string, unknown>)) {
    if (Array.isArray(fields)) {
      out[tool] = fields.filter((f): f is string => typeof f === 'string');
    }
  }
  return out;
}
