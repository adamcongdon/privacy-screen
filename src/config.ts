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
import {
  isPatternName,
  type ColumnPatternRule,
  type XlsxConfig,
} from './xlsx-types';

// Re-export so existing consumers can `import type { XlsxConfig } from './config'`.
export type { ColumnPatternRule, XlsxConfig, PatternName } from './xlsx-types';

export type Mode = 'enforce' | 'observe' | 'disabled';

/**
 * Update channel. `off` is the default and means: no network activity ever.
 * `stable` / `beta` enable a single HTTPS GET to the release manifest on
 * version-check requests. See Plans/INSTALLER.md.
 */
export type UpdateChannel = 'off' | 'stable' | 'beta';

/** Canonical manifest URLs for the self-service channel picker (no YAML editing). */
export const UPDATE_CANONICAL_URLS: Record<'stable' | 'beta', string> = {
  stable: 'https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json',
  beta: 'https://raw.githubusercontent.com/adamcongdon/privacy-screen/beta/release-manifest-beta.json',
};

export function recommendedManifestUrlForChannel(
  ch: 'off' | 'stable' | 'beta',
): string | undefined {
  if (ch === 'off') return undefined;
  return UPDATE_CANONICAL_URLS[ch];
}

/**
 * LLM secondary-validation runtime. Only `llama-server` is supported in v1
 * (llama.cpp's HTTP server). The judge is opt-in and runs out-of-band — the
 * regex+vocab scrubber remains the safety-critical synchronous gate.
 *
 * See `Plans/LLM_RESEARCH.md` and `SAFETY_CHECKLIST.md`.
 */
export type LlmRuntime = 'llama-server';

/**
 * Hook-side knobs. Currently a single switch — confidence-gauge auto-approve
 * (Issue #6). When `auto_approve_clean = true` AND the synchronous judge
 * sync endpoint confirms zero suspicious spans AND the scrubber found zero
 * PII, the hook passes through silently instead of blocking.
 *
 * Default is `false`: behavior is unchanged from the v1 contract. This flag
 * is fail-CLOSED — any judge error/timeout/non-clean response disables
 * auto-approve for that call. See `hooks/lib/judge-sync.ts`.
 */
export interface HookConfig {
  /** Opt-in. Default false. See above. */
  auto_approve_clean: boolean;
}

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
  /** Extra FQDN suffixes never to tokenize (e.g. ".internal.example.com"). */
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
  /** Hook-side opt-in knobs (auto-approve precheck, etc). */
  hook: HookConfig;

  /**
   * Self-service user-defined literal patterns (from right-click "Tokenize selection").
   * These are high-priority literal matches in the scrubber (priority 1.2).
   * Persisted via UI only.
   */
  user_patterns?: Array<{ text: string; cat: string }>;

  /**
   * Self-service custom token categories (name + color) created by the user.
   * Merged with built-ins for pills, menus, vocab filters.
   * Persisted via UI only.
   */
  custom_categories?: Array<{ id: string; label: string; color: string }>;
  /**
   * xlsx scrubber config (Issue #23). Drives column → pattern resolution
   * for `.xlsx` uploads. Optional in the type so call sites that construct
   * `PrivacyConfig` literals (tests, mocks) don't break; `loadConfig`
   * always populates it with the default `{ columnRules: [], autoDetect: true }`.
   */
  xlsx?: XlsxConfig;
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
  update_manifest_url: UPDATE_CANONICAL_URLS.stable,
  llm_validate: {
    enabled: false,
    model_path: null,
    runtime: 'llama-server',
    endpoint: null,
    max_tokens: 256,
    timeout_ms: 2500,
    min_confidence: 0.6,
  },
  hook: {
    auto_approve_clean: false,
  },
  xlsx: {
    columnRules: [],
    autoDetect: true,
  },
  user_patterns: [],
  custom_categories: [],
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
  // Env-var override is authoritative — if set, never fall through to CWD or
  // project-root candidates, even when the target file doesn't exist. Tests
  // and isolated processes rely on this to keep the dev-machine config out.
  const envOverride = process.env.PRIVACY_SCREEN_CONFIG;
  if (envOverride) return envOverride;
  for (const c of [
    join(process.cwd(), 'PRIVACY_CONFIG.yaml'),
    resolve(import.meta.dir, '..', 'PRIVACY_CONFIG.yaml'),
  ]) {
    if (existsSync(c)) return c;
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
    update_manifest_url: safeManifestUrl(o.update_manifest_url, base.update_manifest_url),
    llm_validate: mergeLlmValidate(base.llm_validate, o.llm_validate),
    hook: mergeHook(base.hook, o.hook),
    xlsx: mergeXlsx(base.xlsx ?? { columnRules: [], autoDetect: true }, o.xlsx),
    user_patterns: mergeUserPatterns(base.user_patterns ?? [], o.user_patterns),
    custom_categories: mergeCustomCategories(base.custom_categories ?? [], o.custom_categories),
  };
}

/**
 * Parse and validate the `xlsx:` YAML section. Rejects rules with an
 * invalid `pattern` literal with a clear error — silent fallback would
 * just leave the user puzzled why their column rule isn't firing.
 *
 * Shape contract (from privacy-config.example.yaml):
 *   xlsx:
 *     autoDetect: true
 *     columnRules:
 *       - header: "Customer Email"
 *         pattern: Email
 *       - headerRegex: "phone|mobile"
 *         pattern: Phone
 */
function mergeXlsx(base: XlsxConfig, override: unknown): XlsxConfig {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;

  const autoDetect =
    typeof o.autoDetect === 'boolean' ? o.autoDetect : base.autoDetect;

  let columnRules: ColumnPatternRule[] = base.columnRules;
  if (Array.isArray(o.columnRules)) {
    columnRules = o.columnRules.map((raw, idx) => {
      if (!raw || typeof raw !== 'object') {
        throw new Error(
          `[PrivacyScreen] xlsx.columnRules[${idx}]: rule must be an object`,
        );
      }
      const r = raw as Record<string, unknown>;
      if (!isPatternName(r.pattern)) {
        throw new Error(
          `[PrivacyScreen] xlsx.columnRules[${idx}].pattern: invalid PatternName '${String(r.pattern)}'. ` +
            `Valid: Email, Phone, SSN, IPv4, IPv6, PersonName, StreetAddress, FQDN, CreditCard, UncPath, DomainUser, MAC, GUID.`,
        );
      }
      const rule: ColumnPatternRule = { pattern: r.pattern };
      if (typeof r.header === 'string' && r.header.length > 0) rule.header = r.header;
      if (typeof r.headerRegex === 'string' && r.headerRegex.length > 0) {
        rule.headerRegex = r.headerRegex;
      }
      if (!rule.header && !rule.headerRegex) {
        throw new Error(
          `[PrivacyScreen] xlsx.columnRules[${idx}]: must define 'header' or 'headerRegex'`,
        );
      }
      return rule;
    });
  }

  return { autoDetect, columnRules };
}

function mergeHook(base: HookConfig, override: unknown): HookConfig {
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  return {
    auto_approve_clean:
      typeof o.auto_approve_clean === 'boolean'
        ? o.auto_approve_clean
        : base.auto_approve_clean,
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

/**
 * Validate the manifest URL: must be a parseable URL with `https:` protocol.
 * Anything else (http://, missing, malformed, non-string) falls back to the
 * built-in default and emits a one-line stderr warning. The 4-hour update
 * poll only reaches whatever this resolves to, so we refuse to leak the
 * version-check beacon in plaintext.
 */
function safeManifestUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') {
      process.stderr.write(
        `[PrivacyScreen] update_manifest_url must use https:// — got '${u.protocol}//...'. Falling back to default.\n`,
      );
      return fallback;
    }
    return value;
  } catch {
    process.stderr.write(
      `[PrivacyScreen] update_manifest_url is not a valid URL. Falling back to default.\n`,
    );
    return fallback;
  }
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

function mergeUserPatterns(
  base: Array<{ text: string; cat: string }>,
  override: unknown,
): Array<{ text: string; cat: string }> {
  if (!Array.isArray(override)) return base;
  return override
    .filter((p): p is { text: string; cat: string } =>
      p && typeof p === 'object' && typeof p.text === 'string' && p.text.length > 0 && typeof p.cat === 'string' && p.cat.length > 0,
    )
    .map((p) => ({ text: p.text, cat: p.cat.toLowerCase() }));
}

function mergeCustomCategories(
  base: Array<{ id: string; label: string; color: string }>,
  override: unknown,
): Array<{ id: string; label: string; color: string }> {
  if (!Array.isArray(override)) return base;
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string; color: string }> = [];
  for (const c of override) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' ? c.id : '';
    const label = typeof c.label === 'string' ? c.label.trim() : '';
    const color = typeof c.color === 'string' ? c.color : '';
    if (!id || !label || !color || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, color });
  }
  return out.length ? out : base;
}
