/**
 * Comment-preserving writer for PRIVACY_CONFIG.yaml.
 *
 * Uses `yaml`'s Document API to round-trip an existing YAML file, mutate a
 * specific scalar/mapping, and write back without dropping the user's
 * comments or formatting. We only support the precise fields the GUI needs
 * to toggle today — `llm_validate.enabled` and `llm_validate.model_path` —
 * because surgical mutation is much safer than a re-serialize that could
 * subtly change quoting or indentation.
 *
 * If the file doesn't exist, we create a minimal one with just the mutated
 * section. If the file exists but lacks the `llm_validate` block, we append
 * one (with surrounding comments).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Document, parseDocument, isMap, isScalar, YAMLMap } from 'yaml';
import {
  loadConfig,
  type PrivacyConfig,
  type Mode,
  UPDATE_CANONICAL_URLS,
} from '../../src/config';
import { resolveConfigPath } from './config-resolver';

/**
 * Write the config file, creating the parent directory if needed. The canonical
 * user-data location ($HOME/.privacy-screen/) may not exist on a fresh install,
 * and writeFileSync does not create intermediate directories — without this the
 * first settings save on a clean machine would throw ENOENT and 500. Mirrors
 * the ensureDir step in secrets.ts.
 */
function writeConfigFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Fields the GUI may patch. Mirrors a subset of `LlmValidateConfig`. */
export interface LlmValidatePatch {
  enabled?: boolean;
  model_path?: string | null;
}

/** Top-level update prefs the GUI may patch (from PRIVACY_CONFIG.yaml). */
export interface UpdateConfigPatch {
  update_channel?: 'off' | 'stable' | 'beta';
  update_manifest_url?: string;
}

/** Self-service features persisted at YAML root (patterns for tokenize, custom categories). */
export interface SelfServicePatch {
  user_patterns?: Array<{ text: string; cat: string }>;
  custom_categories?: Array<{ id: string; label: string; color: string }>;
}

/** Write the patch to PRIVACY_CONFIG.yaml. Returns the post-write config. */
export function patchLlmValidate(patch: LlmValidatePatch): PrivacyConfig {
  const path = resolveConfigPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  let doc: Document;
  try {
    doc = parseDocument(existing);
    // `parseDocument` returns a doc with errors[] populated on malformed input
    // rather than throwing. Treat any parse error the same as "no file".
    if (doc.errors.length > 0) {
      doc = new Document(new YAMLMap());
    }
  } catch {
    doc = new Document(new YAMLMap());
  }

  if (!isMap(doc.contents)) {
    doc.contents = new YAMLMap();
  }

  // Get or create the llm_validate node as a YAMLMap (not a plain object —
  // plain objects don't satisfy isMap() and break subsequent .set calls).
  const raw = doc.get('llm_validate', true);
  let llmNode: YAMLMap;
  if (isMap(raw)) {
    llmNode = raw;
  } else {
    llmNode = new YAMLMap();
    doc.set('llm_validate', llmNode);
  }

  if (typeof patch.enabled === 'boolean') {
    llmNode.set('enabled', patch.enabled);
  }
  if (patch.model_path !== undefined) {
    if (patch.model_path === null) {
      const node = llmNode.get('model_path', true);
      if (isScalar(node)) {
        node.value = null;
      } else {
        llmNode.set('model_path', null);
      }
    } else {
      llmNode.set('model_path', patch.model_path);
    }
  }

  const out = String(doc);
  writeConfigFile(path, out);

  // Re-load so we surface back the canonicalized + defaulted view.
  return loadConfig(path);
}

/** Write update_channel / update_manifest_url at the YAML root (comment-preserving).
 *
 * When a channel is written, we *always* also write the corresponding manifest URL
 * (the recommended one for that channel, or an explicit custom if provided in the
 * same patch). This prevents the stale-default bug where `update_channel: beta`
 * was saved without a `update_manifest_url`, causing loadConfig to fall back to the
 * stable URL and the channel-guard in checkForUpdate to suppress all updates.
 */
export function patchUpdateConfig(patch: UpdateConfigPatch): PrivacyConfig {
  const path = resolveConfigPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  let doc: Document;
  try {
    doc = parseDocument(existing);
    if (doc.errors.length > 0) {
      doc = new Document(new YAMLMap());
    }
  } catch {
    doc = new Document(new YAMLMap());
  }

  if (!isMap(doc.contents)) {
    doc.contents = new YAMLMap();
  }

  const ch = typeof patch.update_channel === 'string' ? patch.update_channel : undefined;
  const explicitUrl =
    typeof patch.update_manifest_url === 'string' && patch.update_manifest_url.length > 0
      ? patch.update_manifest_url
      : undefined;

  if (ch) {
    doc.set('update_channel', ch);
  }

  if (explicitUrl) {
    doc.set('update_manifest_url', explicitUrl);
  } else if (ch === 'stable' || ch === 'beta') {
    doc.set('update_manifest_url', UPDATE_CANONICAL_URLS[ch]);
  } else if (ch === 'off') {
    // When turning updates off, drop any stale URL key so the YAML reflects the intent.
    if (doc.has('update_manifest_url')) {
      doc.delete('update_manifest_url');
    }
  }

  const out = String(doc);
  writeConfigFile(path, out);

  return loadConfig(path);
}

/**
 * Write the screening `mode` scalar at the YAML root (comment-preserving).
 *
 * `mode` is the single canonical screening setting in PRIVACY_CONFIG.yaml — the
 * same field the hook/CLI enforcement path reads (`src/config.ts`). Surfacing it
 * through the settings API lets the web Settings screen control the same knob.
 */
export function patchScreeningMode(mode: Mode): PrivacyConfig {
  const path = resolveConfigPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  let doc: Document;
  try {
    doc = parseDocument(existing);
    if (doc.errors.length > 0) {
      doc = new Document(new YAMLMap());
    }
  } catch {
    doc = new Document(new YAMLMap());
  }

  if (!isMap(doc.contents)) {
    doc.contents = new YAMLMap();
  }

  doc.set('mode', mode);

  writeConfigFile(path, String(doc));

  return loadConfig(path);
}

/** Write user_patterns and/or custom_categories arrays (for self-service tokenize + custom cats). */
export function patchSelfService(patch: SelfServicePatch): PrivacyConfig {
  const path = resolveConfigPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  let doc: Document;
  try {
    doc = parseDocument(existing);
    if (doc.errors.length > 0) {
      doc = new Document(new YAMLMap());
    }
  } catch {
    doc = new Document(new YAMLMap());
  }

  if (!isMap(doc.contents)) {
    doc.contents = new YAMLMap();
  }

  if (Array.isArray(patch.user_patterns)) {
    doc.set('user_patterns', patch.user_patterns);
  }
  if (Array.isArray(patch.custom_categories)) {
    doc.set('custom_categories', patch.custom_categories);
  }

  writeConfigFile(path, String(doc));

  return loadConfig(path);
}
