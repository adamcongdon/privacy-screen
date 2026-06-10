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

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { Document, parseDocument, isMap, isScalar, YAMLMap } from 'yaml';
import { loadConfig, type PrivacyConfig, type Mode } from '../../src/config';
import { resolveConfigPath } from './config-resolver';

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
  writeFileSync(path, out);

  // Re-load so we surface back the canonicalized + defaulted view.
  return loadConfig(path);
}

/** Write update_channel / update_manifest_url at the YAML root (comment-preserving). */
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

  if (typeof patch.update_channel === 'string') {
    doc.set('update_channel', patch.update_channel);
  }
  if (typeof patch.update_manifest_url === 'string' && patch.update_manifest_url.length > 0) {
    doc.set('update_manifest_url', patch.update_manifest_url);
  }

  const out = String(doc);
  writeFileSync(path, out);

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

  writeFileSync(path, String(doc));

  return loadConfig(path);
}
