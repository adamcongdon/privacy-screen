---
project: privacy-screen
task: "ac-build PR: issues #6 + #14 + #15 + claude workflows"
slug: ac-build-issues-and-claude-actions
effort: E5
phase: complete
progress: 36/36
mode: standard
started: 2026-06-09T13:55:00Z
updated: 2026-06-09T15:00:00Z
algorithm_version: 6.3.0
---

# privacy-screen — ISA

The system of record for privacy-screen's ideal state. Lives in the repo, evolves with the project. This run's scope is articulated in `## Goal` / `## Criteria`; long-lived principles stay above.

## Problem

privacy-screen ships a strong PII anonymization engine (regex + vocab + LLM judge) with a web UI and Claude Code hook. Three open issues track shipped-but-incomplete surfaces:

- **#6** — hook intercepts and blocks, but the message it returns is generic; the LLM judge is opt-in but its confidence signal is never used to auto-approve "100% clean" payloads. Users see friction even when the scrubber is perfectly confident.
- **#14** — code-signing infra landed (#87f8612) then immediately paused (#5e3117b) because no Apple Developer ID cert and no notarization story exist. The pipeline regression leaves releases unsigned with no on-ramp to re-enable.
- **#15** — no in-app feedback path. Users hitting bugs must context-switch to GitHub. The tool already detects the local `claude` CLI ("CLAUDE: 2.1.145 ONLINE") — it has everything it needs to file issues on behalf of the user, locally.

Additionally, repo lacks the three `claude-*.yml` workflows that automate triage, code review, and `@claude` mentions on `adamcongdon/se-lz`. Adding them turns every new privacy-screen issue into a guided, self-triaged unit of work.

## Vision

A Claude Code hook that says "here's what I found — 92% confident I caught it all; want me to send anyway?" instead of a wall of blocks. A web UI with a single "Send feedback" button that opens a GitHub issue without the user ever leaving the app. A release pipeline one repo-variable away from signed binaries the moment certs exist. And a private repo whose issues triage themselves the second they open.

Euphoric surprise lives at the moment the user opens a fresh issue and watches Claude apply labels, name the suspect file, and propose a fix — all without anyone typing `@claude`.

## Out of Scope

- Flipping the repo to public (issue #15 mentioned this; user decision, not implemented here)
- Acquiring an Apple Developer ID cert / setting up notarization secrets (un-pause is infra restore only)
- Mobile / iOS surface (web UI only)
- Adding new PII categories or scrubbing rules (separate work)
- Migrating off bun/TypeScript stack (architectural constraint; see Principles)

## Principles

- **Local-first.** No PII leaves the machine except to the user's already-trusted Anthropic endpoint. New routes preserve loopback-only binding and Host-header allowlisting.
- **Fail-CLOSED.** Hook errors block; uncertainty errs toward refusing the send. The judge confidence-gauge can only ADD permission to send (auto-approve on 100% clean), never SUBTRACT safety.
- **Inherit existing auth.** When the tool needs cloud access (GitHub, Anthropic), reuse the user's already-OAuth'd local CLI instead of asking for tokens.
- **Diagnostics get scrubbed first.** Any feature that ships diagnostics off-box runs them through `scrubText()` before transmission.
- **Workflows ship gated.** New CI/CD that depends on secrets degrades gracefully when secrets are absent (no red CI, just a no-op path).

## Constraints

- bun + TypeScript stack (existing). No new languages.
- All HTTP routes bind `127.0.0.1` only; Host-allowlist enforced; DNS-rebinding-defeated.
- Web/server share the `Hono` router. New routes register through `server/server.ts`.
- `bun test` must stay green at every commit boundary.
- Branch flow: `ac-build` (work) → `dev` (this PR) → `beta` (auto-release) → `main` (stable, owner-approved only).
- GitHub workflows run on `ubuntu-latest` (privacy-screen has no self-hosted runner).

## Goal

Land a single PR from `ac-build` to `dev` that (a) ports the three `claude-*.yml` workflows from `adamcongdon/se-lz` adapted to privacy-screen's domain, (b) restores the paused #14 code-signing infrastructure as a gated-off, ready-to-enable pipeline, (c) ships the #6 hook findings-preview + judge-confidence-gauge auto-approve flow, and (d) ships the #15 "Send feedback" button that files a GitHub issue via the local `claude` CLI — with `bun lint` clean and `bun test` 100% green.

## Criteria

**Workflow ports (D1–D3):**
- [ ] ISC-1: `.github/workflows/claude.yml` exists in repo
- [ ] ISC-2: `claude.yml` runs on `ubuntu-latest` (not `self-hosted`)
- [ ] ISC-3: `claude.yml` references `secrets.CLAUDE_CODE_OAUTH_TOKEN`
- [ ] ISC-4: `claude.yml` triggers on issue_comment, pr_review_comment, issues, pr_review with `@claude` mention
- [ ] ISC-5: `.github/workflows/claude-code-review.yml` exists
- [ ] ISC-6: `claude-code-review.yml` runs on `ubuntu-latest`, triggers on PR open/sync/reopen/ready_for_review
- [ ] ISC-7: `claude-code-review.yml` uses `/code-review:code-review` plugin prompt
- [ ] ISC-8: `.github/workflows/claude-triage.yml` exists
- [ ] ISC-9: `claude-triage.yml` runs on `ubuntu-latest`, triggers on `issues: [opened]`
- [ ] ISC-10: `claude-triage.yml` triage prompt references privacy-screen domain (hook, scrubber, judge, web UI) — NOT VIP/Blazor
- [ ] ISC-11: `claude-triage.yml` posts comment via gh CLI (not python+urllib like se-lz) so privacy-screen has no python dep
- [ ] ISC-12: `.github/workflows/README.md` documents `CLAUDE_CODE_OAUTH_TOKEN` + PAT requirements

**Code-signing restore (D4):**
- [ ] ISC-13: `.github/workflows/release.yml` restored to split-job structure (build / sign-macos / create-release) from commit 87f8612
- [ ] ISC-14: `scripts/build-release.ts` restored to support `--manifest-only` flag
- [ ] ISC-15: All signing steps gated on `vars.RUN_CODE_SIGNING == 'true'` — unset by default
- [ ] ISC-16: With `RUN_CODE_SIGNING` unset, release.yml produces unsigned releases identically to current behavior (no CI breakage)
- [ ] ISC-17: `.github/workflows/README.md` documents the secrets (WIN_P12_*, MAC_DEV_ID_*, NOTARY_*) required to enable

**Issue #6 hook polish (D5):**
- [ ] ISC-18: Hook BLOCK output includes the literal phrase "Double check it for sensitive data, personal data, PII"
- [ ] ISC-19: Hook BLOCK output enumerates findings (category + count) in a stable format
- [ ] ISC-20: When judge is enabled AND judge returns 0 suspicious_spans AND scrubber returns 0 findings, hook treats the payload as "100% clean" and passes through
- [ ] ISC-21: 100%-clean auto-approve path is gated by `cfg.hook.auto_approve_clean: true` (default false — opt-in)
- [ ] ISC-22: Existing hook-contract tests updated to match new BLOCK message format
- [ ] ISC-23: New test: auto-approve path triggers when configured AND clean
- [ ] ISC-24: New test: auto-approve does NOT trigger when judge finds suspicious spans

**Issue #15 feedback button (D6):**
- [ ] ISC-25: `POST /api/feedback` route exists in `server/server.ts`
- [ ] ISC-26: Feedback route collects sanitized diagnostics (config redacted, recent error count, version, claude detection status, judge status) — runs them through scrubber first
- [ ] ISC-27: Feedback route spawns local `claude` CLI with a prompt that includes diagnostics + asks it to file a GitHub issue
- [ ] ISC-28: Route refuses to run if `claude` CLI not detected (mirrors server boot gate)
- [ ] ISC-29: New Web UI button visible in header/topbar area with `Send feedback` label
- [ ] ISC-30: Button click → modal/dialog with diagnostics preview → user confirms → POST /api/feedback → toast on success or failure
- [ ] ISC-31: New test: /api/feedback handles missing `claude` CLI gracefully (returns 503)
- [ ] ISC-32: Anti: feedback diagnostics are never sent to GitHub without being scrubbed first

**Validation gates:**
- [ ] ISC-33: `bun lint` exits 0
- [ ] ISC-34: `bun test` exits 0 with all-pass (no new failures, baseline 359 + new tests)
- [ ] ISC-35: Anti: existing 6 skipped tests remain skipped (not silently unskipped or quietly removed)
- [ ] ISC-36: PR opened from `ac-build` to `dev` with description referencing #6, #14, #15

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-1..ISC-3 | file | exists + grep for runs-on + grep for secret | exact-match | Read + Grep |
| ISC-4..ISC-11 | file | grep for trigger types and prompt content | exact-match | Read + Grep |
| ISC-12 | file | grep README for secret names | substring | Grep |
| ISC-13..ISC-15 | file | grep release.yml for sign-macos job + RUN_CODE_SIGNING gate | exact-match | Read + Grep |
| ISC-16 | live | dry-run yaml lint + reason about gated path | structural | Read |
| ISC-17 | file | grep README for new secret names | substring | Grep |
| ISC-18..ISC-19 | bun test | hook-contract.test.ts assertions on BLOCK message format | passing | bun test |
| ISC-20..ISC-24 | bun test | new tests in hook-contract + judge-route | passing | bun test |
| ISC-25..ISC-32 | bun test | new tests in server-smoke + new feedback.test.ts | passing | bun test |
| ISC-33 | bash | `bun lint` exit code | exit 0 | Bash |
| ISC-34..ISC-35 | bash | `bun test` exit code + numeric pass count | 359+new pass | Bash |
| ISC-36 | gh | `gh pr view` returns the PR | exists | Bash |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| F1: workflow port — claude.yml | ISC-1..4 | — | yes |
| F2: workflow port — claude-code-review.yml | ISC-5..7 | — | yes |
| F3: workflow port — claude-triage.yml | ISC-8..11 | F1 (for trigger handoff) | yes |
| F4: workflows README update | ISC-12, ISC-17 | F1, F2, F3, F5 | no (last) |
| F5: signing infra restore | ISC-13..16 | — | yes |
| F6: hook findings-preview + judge auto-approve | ISC-18..24 | — | yes (uses Forge + Engineer) |
| F7: feedback button + /api/feedback route | ISC-25..32 | — | yes (uses /Development pipeline) |
| F8: full test suite + PR open | ISC-33..36 | F1..F7 | no (last) |

## Decisions

- **2026-06-09T13:55Z** — Effort tier E5 set via conversation-context override. Classifier returned E4 but user-confirmed all 3 issues + 3 workflows + signing restore + PR is comprehensive scope (>2h). `effort_source: context-override`.
- **2026-06-09T13:55Z** — Workflows ported with `runs-on: ubuntu-latest` (not `self-hosted`); user's privacy-screen repo has no self-hosted runner; se-lz uses Veeam infra runners not available here.
- **2026-06-09T13:55Z** — Triage workflow rewritten from python+urllib to bash+gh-cli. gh is available on ubuntu-latest runners by default; bash+gh is more idiomatic; avoids spurious python dep for a tiny POST.
- **2026-06-09T13:55Z** — #14 signing infra restored via re-apply of commit 87f8612's content, but with `RUN_CODE_SIGNING` gate explicitly defaulted-off. User has no certs yet; this leaves them 1-repo-variable away from re-enabling when they do.
- **2026-06-09T13:55Z** — #15 feedback flow uses local `claude` CLI (already a hard dep per `claude-code-check.ts`) instead of a user-supplied PAT or server-side GitHub App. Inherits user's gh CLI session; matches the "Inherit existing auth" principle.
- **2026-06-09T13:55Z** — Show-your-math: delegation floor under by 1. Anvil skipped because whole-project context already loaded into my own session window; Forge covers GPT-5.4 perspective; no second OpenAI-family lens adds value here.
- **2026-06-09T13:55Z** — `Plans/FAMILY_PHOTO_GUARDIAN.md` left untracked — it's a spin-off project's planning doc, not part of this PR.
- **2026-06-09T14:18Z** — Forge unavailable (codex CLI absent at `~/.bun/bin/codex`). Per Forge's own fallback doctrine, swapping to `Copilot` (GitHub-family, `gh copilot` at `--reasoning-effort xhigh`) as the audited substitute. Implementation work for Engineer-A/B/C will route through Copilot. If Copilot also returns unavailable, fall through to Engineer (Claude-family) with show-your-math.

## Changelog

*(Populated at LEARN.)*

## Verification

**Test suite (post-remediation):** `bun lint` exits 0; `bun test` reports `371 pass, 6 skip, 0 fail` across 21 files (751 expect() calls). Baseline was 359 pass, so 12 new tests landed in this PR (hook-contract update + hook-auto-approve x2 + feedback-route x9 covering 503, anti-leak, success, preview, error paths, oversized redaction, env-var gating).

- ISC-1..ISC-11 — verified via `grep` on `.github/workflows/claude.yml`, `claude-code-review.yml`, `claude-triage.yml` (ubuntu-latest, secrets referenced, privacy-screen triage prompt, gh CLI not python).
- ISC-12, ISC-17 — `.github/workflows/README.md` lists `CLAUDE_CODE_OAUTH_TOKEN`, `PRIVACY_SCREEN_TRIAGE_PAT`, `RUN_CODE_SIGNING`, and the WIN_*/APPLE_* secret set.
- ISC-13..ISC-16 — `release.yml` re-restored via `git revert 5e3117b` (commit `fd3ecd6`). Five gates on `vars.RUN_CODE_SIGNING == 'true'` (lines 119, 202, 318, 385, 480). With variable unset, all signing steps skip and the workflow produces unsigned releases identically to pre-#14.
- ISC-18..ISC-19 — hook BLOCK output now contains the literal phrase and the `category × count` enumeration (verified by passing `tests/hook-contract.test.ts` assertions). Findings grouper handles both regex-detected PII (`mintedTokens` path) and pre-mint customer/person names (scrubbed-text token-literal scan path).
- ISC-20..ISC-24 — `tests/hook-auto-approve.test.ts` passes both cases. Default `cfg.hook.auto_approve_clean = false` verified in `src/config.ts` defaults block.
- ISC-25 — `app.route('/api/feedback', feedbackRoute)` present in `server/server.ts:128`.
- ISC-26 — `scrubText()` called on both diagnostics blob and user summary before any spawn. Verified by `tests/feedback-route.test.ts` anti-leak case that asserts raw customer name never appears in captured spawn argv.
- ISC-27 — `Bun.spawn` with `['claude', '-p', prompt]` (switched from `spawnSync` per Pentester MED-3 to keep the event loop free).
- ISC-28 — 503 returned when `checkClaudeCode().found === false`. Verified by `tests/feedback-route.test.ts` case (a).
- ISC-29..ISC-30 — `web/src/App.tsx` topbar Send-feedback button + `web/src/components/FeedbackDialog.tsx` modal with diagnostics preview + summary textarea + toast on result.
- ISC-31..ISC-32 — anti-leak test passes; redaction snapshot now has runtime `assertRedacted()` guard (Pentester HIGH-3 remediation).
- ISC-33 — `bun lint` exit 0 verified.
- ISC-34..ISC-35 — `bun test` 371/0/6 verified; baseline 359 still passing, 6 skips unchanged.
- ISC-36 — PR opened: https://github.com/adamcongdon/privacy-screen/pull/17 (ac-build → dev, 14 commits ahead).

**Doctrine compliance:**
- Rule 1 (live-probe): scrub + spawn paths verified by passing tests; lint + test exit codes captured. UI verification via Interceptor deferred — local web flow only; no deploy step in this PR.
- Rule 2 (Advisor): consulted on the spawn-resolution, gh-CLI hardening, and fail-CLOSED contract questions. Concerns about (a) and (b) folded into the Pentester remediation commit `8dfd6db`.
- Rule 2a (Cato cross-vendor audit): **substitute used** — Cato is codex-CLI-dependent and the binary is absent on this host (same constraint that blocked Forge). The Anthropic-blind-spot lens was therefore covered by (i) Copilot as the GitHub-family code substrate for every implementation pass and (ii) the Pentester (`silent-failure-hunter`) audit which surfaced 3 HIGH + 8 MEDIUM findings, all remediated in commit `8dfd6db`. Show-your-math logged in `## Decisions`.
- Rule 3 (conflict surfacing): Pentester verdict was `FAIL`; remediated and re-tested. No silent switch.

**Deliverable compliance (D1–D8):**
- D1: `.github/workflows/claude.yml` ✓
- D2: `.github/workflows/claude-code-review.yml` ✓
- D3: `.github/workflows/claude-triage.yml` ✓
- D4: `release.yml` + `scripts/build-release.ts` restored, gated off ✓
- D5: #6 hook polish ✓ (commit `74217ed`)
- D6: #15 feedback button + route ✓ (commits `efa0b8e` backend + `7a8a98f` web + `8dfd6db` security pass)
- D7: lint + test green ✓
- D8: PR appended below ✓
