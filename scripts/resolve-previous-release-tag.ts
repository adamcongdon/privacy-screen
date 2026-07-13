#!/usr/bin/env bun
/**
 * Resolve the previous same-channel GitHub release tag for --notes-start-tag.
 *
 * Issue #49: bare `gh release create --generate-notes` walks back to a stale
 * base (e.g. v0.0.4 / beta.5) when intermediate cuts only touch manifest
 * commits, so every beta body repeats the same PR list. Pinning
 * --notes-start-tag to the prior same-channel release fixes that.
 *
 * Usage (CLI):
 *   bun scripts/resolve-previous-release-tag.ts <beta|stable> <currentTag> <releases.json>
 *
 * releases.json is the output of:
 *   NO_COLOR=1 gh release list --limit 50 --json tagName,isPrerelease
 * (newest-first; empty array allowed). Prefer plain JSON (NO_COLOR / --jq '.')
 * so ANSI color escapes cannot break JSON.parse.
 *
 * Output: previous tag to stdout, or empty line if none.
 * Exit 0 always on valid input; exit 2 on usage/parse errors.
 */

export type ReleaseEntry = {
  tagName: string;
  isPrerelease: boolean;
};

export type Channel = 'beta' | 'stable';

/** Strip ANSI CSI/OSC sequences (defense if `gh` still colorizes JSON). */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

/**
 * Pick the newest prior release for the channel, skipping the tag being cut.
 * `releases` must be newest-first (GitHub list order).
 *
 * - beta  → first prerelease whose tagName !== currentTag
 * - stable → first non-prerelease whose tagName !== currentTag
 */
export function resolvePreviousReleaseTag(
  releases: ReleaseEntry[],
  channel: Channel,
  currentTag: string,
): string {
  const wantPrerelease = channel === 'beta';
  for (const r of releases) {
    if (!r?.tagName) continue;
    if (r.tagName === currentTag) continue;
    if (r.isPrerelease === wantPrerelease) return r.tagName;
  }
  return '';
}

/** Parse `gh release list --json` output (optionally ANSI-tainted). */
export function parseReleaseListJson(raw: string): ReleaseEntry[] {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) return [];
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of { tagName, isPrerelease }');
  }
  return parsed as ReleaseEntry[];
}

// --- CLI (only when this file is the entrypoint) ---
if (import.meta.main) {
  const channel = process.argv[2] as Channel | undefined;
  const currentTag = process.argv[3];
  const jsonPathOrInline = process.argv[4];

  if (
    (channel !== 'beta' && channel !== 'stable') ||
    !currentTag ||
    jsonPathOrInline === undefined
  ) {
    process.stderr.write(
      'Usage: resolve-previous-release-tag.ts <beta|stable> <currentTag> <releases.json|-|\'[]\'>\n',
    );
    process.exit(2);
  }

  let raw: string;
  if (jsonPathOrInline === '-') {
    raw = await Bun.stdin.text();
  } else if (jsonPathOrInline.startsWith('[') || jsonPathOrInline.startsWith('{')) {
    raw = jsonPathOrInline;
  } else {
    raw = await Bun.file(jsonPathOrInline).text();
  }

  let entries: ReleaseEntry[];
  try {
    entries = parseReleaseListJson(raw);
  } catch (e) {
    process.stderr.write(`Invalid JSON: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const prev = resolvePreviousReleaseTag(entries, channel, currentTag);
  process.stdout.write(`${prev}\n`);
}
