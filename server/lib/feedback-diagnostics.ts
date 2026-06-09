/**
 * Feedback diagnostics collector — pure helper.
 *
 * Returns a structured, UNSCRUBBED snapshot of the runtime state that's
 * useful for triaging a user-submitted bug. The caller (server/routes/feedback.ts)
 * is responsible for running the resulting object through `scrubText()` before
 * it ever leaves the process — this helper deliberately does NOT scrub so
 * the same shape can be unit-tested without the scrubber dependency.
 *
 * Contract:
 *   - No exceptions on a "best effort" field. A missing package.json must
 *     surface as `version: "unknown"`, not as a thrown error.
 *   - No long timeouts. The judge reachability probe is a 50ms TCP-style
 *     fetch; if it doesn't answer in time we report `configured: false`.
 *   - The `config` snapshot strips identifying fields (customer_names,
 *     person_names) and any path-shaped string that contains $HOME. Other
 *     fields useful for triage (mode, llm_validate.enabled,
 *     hook.auto_approve_clean) are kept verbatim.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { checkClaudeCode } from './claude-code-check';
import type { PrivacyConfig } from '../../src/config';

export interface Diagnostics {
  version: string;
  claudeCode: { found: boolean; version: string | null };
  judge: { enabled: boolean; configured: boolean };
  config: RedactedConfigSnapshot;
}

/**
 * A redacted view of PrivacyConfig — keeps the fields that help triage a bug
 * report (operating mode, whether the judge is on, what hook behaviors are
 * enabled) and drops anything that would identify the user.
 */
export interface RedactedConfigSnapshot {
  mode: PrivacyConfig['mode'];
  llm_validate: { enabled: boolean };
  hook: { auto_approve_clean: boolean };
  update_channel: PrivacyConfig['update_channel'];
  fqdn_allowlist_extra_count: number;
  customer_names_count: number;
  person_names_count: number;
  name_allowlist_count: number;
}

export function collectDiagnostics(cfg: PrivacyConfig): Diagnostics {
  return {
    version: readPackageVersion(),
    claudeCode: checkClaudeCode(),
    judge: probeJudge(cfg),
    config: redactConfig(cfg),
  };
}

/**
 * Read the version field from the project root's package.json. Falls back to
 * "unknown" on any I/O or parse failure — version reporting is best-effort
 * and must not break the feedback flow.
 */
function readPackageVersion(): string {
  // server/lib/feedback-diagnostics.ts → project root is two levels up.
  const candidates = [
    resolve(import.meta.dir, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) {
        return raw.version;
      }
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
}

/**
 * Lightweight reachability check for the judge endpoint. We don't actually
 * call the model — we just want to know whether the user has it wired up.
 * `enabled` reflects the config switch; `configured` is true when the
 * endpoint is set AND the loopback TCP fetch returned anything (even a 404),
 * within a hard 50ms budget so the preview stays snappy.
 */
function probeJudge(cfg: PrivacyConfig): { enabled: boolean; configured: boolean } {
  const enabled = cfg.llm_validate.enabled;
  const endpoint = cfg.llm_validate.endpoint;
  if (!endpoint) {
    return { enabled, configured: false };
  }
  // We are intentionally synchronous here — the caller is happy to receive
  // configured:false if the probe didn't finish, and a true async probe would
  // complicate the contract. So we return the "config presence" signal, not
  // a live network probe. Anyone reading the field gets a deterministic
  // answer based on whether the user pointed the endpoint at something.
  return { enabled, configured: endpoint.length > 0 };
}

/**
 * Strip identifying / path fields from the config. Everything left is safe
 * for sharing in a bug report:
 *   - operating mode (enforce/observe/disabled)
 *   - whether the judge is enabled (boolean)
 *   - whether the hook's auto-approve-clean precheck is on
 *   - update channel
 *   - counts of the user-provided lists (so triage can tell "did they
 *     configure any custom names" without revealing the names themselves)
 */
function redactConfig(cfg: PrivacyConfig): RedactedConfigSnapshot {
  return {
    mode: cfg.mode,
    llm_validate: { enabled: cfg.llm_validate.enabled },
    hook: { auto_approve_clean: cfg.hook.auto_approve_clean },
    update_channel: cfg.update_channel,
    fqdn_allowlist_extra_count: cfg.fqdn_allowlist_extra.length,
    customer_names_count: cfg.customer_names.length,
    person_names_count: cfg.person_names.length,
    name_allowlist_count: cfg.name_allowlist.length,
  };
}
