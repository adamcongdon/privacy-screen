# Changelog

All notable user-visible changes to **privacy-screen** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release section uses these subsections (omit any that have no entries):

- **Added** — new features
- **Changed** — changes in existing functionality
- **Deprecated** — soon-to-be removed features
- **Removed** — now removed features
- **Fixed** — any bug fixes
- **Security** — security-relevant changes

Releases before this file existed are catalogued on the
[GitHub Releases page](https://github.com/adamcongdon/privacy-screen/releases) (auto-generated
notes from merged PRs).

<!-- changelog:start -->

## [Unreleased]

### Added

### Changed

### Fixed

### Security

## [v1.0.0] - 2026-07-31

First stable release. Changes below cover everything user-visible since v0.0.4;
earlier history is on the [GitHub Releases page](https://github.com/adamcongdon/privacy-screen/releases).

### Added

- PDF upload + scrub: drop a `.pdf` and its text layer is extracted fully in memory and anonymized exactly like pasted text, with explicit per-file errors for scanned/image-only, corrupt, and password-protected PDFs (#192)
- PDF review UX: extracted text shown in the left pane, category-colored token pills + protected-item counts for file uploads, and an in-context judge callout (#198)
- **⬇ Scrubbed copy** export on every file chip — text files download their scrubbed content directly; PDFs are rebuilt as a clean document (reflowed from scrubbed text, never by editing original bytes) with defensive server-side re-scrub; a credential anywhere blocks the export with a visible blocked state (#198, #199)
- SSN detection (`{SSN}`): SSA-valid 3-2-4 with a required dash/space separator, rejecting invalid area/group/serial parts and never colliding with phone numbers (#199)
- Remembered per-column policies for xlsx/csv: the policy chosen at commit persists to `PRIVACY_CONFIG.yaml` keyed by column header and auto-applies to future uploads with a `remembered` badge (#143)
- Send-feedback from the app via a Cloudflare Worker relay, including a screenshot file picker (#119, #182)
- Optional blocking of PII found in tool output for Claude Code hook users (`hook.block_pii_in_tool_output`, enforce mode) (#170)

### Changed

- `disabled` mode is now a true emergency bypass (#181)
- Vocab export is safe-by-default; exporting full PII values is explicitly gated with a warning (#174)
- Spreadsheet scrubbing now covers rich text, hyperlinks, headers, and sheet metadata, and a credential anywhere in a workbook blocks the whole file (#136)

### Fixed

- A stale staged update is no longer surfaced as ready-to-apply
- Scrub failures and in-flight state now surface on the Scrub preview instead of failing silently (#138)
- Overlapping review spans are deduplicated and already-approved values no longer re-enter the review queue (#137)
- The saved system prompt is scrubbed and credential-gated on the send path (#135)
- Token minting is serialized across processes, preventing duplicate tokens for the same value (#132)
- Short trailing text chunks are no longer dropped from LLM-judge review (#124)
- All-uppercase FQDNs tokenize correctly (#121)
- Bulk vocab clear uses one request instead of one DELETE per row (#159)

### Security

- Hook fails closed on oversized or unparseable input, deep object nesting, object keys, and object-shaped tool responses (#125, #130)
- Fields skipped from scrubbing are still scanned for sensitive `key=value` pairs (#131)
- Update downloads are restricted to HTTPS GitHub hosts and SHA256-verified before apply (#176)
- CSRF guard on mutating routes; dev CORS origins are excluded from release builds (#129)
- LLM judge prompt hardened against injection embedded in scrubbed text; raw judge output is redacted to a shape summary unless a debug env is set (#163, #122)
- Rendered HTML preview passes through an allowlist sanitizer (#169)
- Release pipeline gates shipped binaries behind a secret/PII scan and excludes sourcemaps and non-allowlisted files from the web embed (#177, #162)

<!-- changelog:end -->

[Unreleased]: https://github.com/adamcongdon/privacy-screen/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/adamcongdon/privacy-screen/compare/v0.0.4...v1.0.0
