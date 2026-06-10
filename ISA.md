---
project: privacy-screen
task: "Issue #16: periodic auto-update poll + global update-available banner"
slug: issue-16-auto-update
effort: E3
phase: complete
progress: 15/15
mode: standard
started: 2026-06-09T16:00:00Z
updated: 2026-06-09T19:00:00Z
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

## Issue #16 — Auto-Update

Issue #16 was filed against a "Squirrel.Windows / electron-updater" suggestion that doesn't fit privacy-screen's stack. The backend half (`/api/version` + `/api/update/{status,download,apply}`) already exists and was shipped under the ac-build PR (#17). The remaining gap is in the web client: the version check only fires on app boot and on settings-drawer open, so a user who leaves the app open for a workday never learns about a new release until they happen to open Settings. And the per-version "dismiss" persistence has no banner UI to drive it.

Engineer-A landed the store-side primitives — `startVersionPoller`, `stopVersionPoller`, `dismissedUpdateVersion`, `settingsDeepLink`, the `UpdateAvailableBanner` component, and the unit tests for both — on commit `9bd9acb`. This cycle (Engineer-B's slice) wires that primitive into the running app: render the banner under the header, drive the poller lifecycle from `settings.update_channel`, deep-link the banner click into the Settings drawer's update section, and document the feature in README + this ISA.

## Goal

Wire Engineer-A's auto-update primitives into the running app shell: render the global update banner directly below the header, drive `startVersionPoller`/`stopVersionPoller` from a `useEffect` keyed on `settings.update_channel`, add the `#update-section` anchor + auto-scroll deep link to `SettingsDrawer`, document the feature in README, with `bun lint` clean, `bun test` 100% green, and `bun run web:build` succeeding.

## Criteria

- [ ] ISC-1: `web/src/store.ts` exports `startVersionPoller` and `stopVersionPoller`.
- [ ] ISC-2: `VERSION_POLL_INTERVAL_MS === 4 * 60 * 60 * 1000`.
- [ ] ISC-3: Poller no-ops when `settings.update_channel === 'off'`.
- [ ] ISC-4: Poller no-ops when `document.visibilityState !== 'visible'`.
- [ ] ISC-5: `App.tsx` has a `useEffect` keyed on `settings?.update_channel` that starts the poller for stable/beta and stops it otherwise.
- [ ] ISC-6: `web/src/components/UpdateAvailableBanner.tsx` exists and is rendered from `App.tsx` directly below the header.
- [ ] ISC-7: Banner visibility gates on `updateAvailable === true` AND `dismissedUpdateVersion !== updateInfo.version`.
- [ ] ISC-8: Dismiss persists to `localStorage['ps:dismissedUpdateVersion']`.
- [ ] ISC-9: Clicking banner body opens SettingsDrawer with `settingsDeepLink === 'update'`; drawer scrolls to `#update-section`.
- [ ] ISC-10: `tests/update-poll.test.ts` covers off/on/flip/hidden/double-start and passes.
- [ ] ISC-11: `tests/update-banner.test.ts` covers render/dismiss/reappear/click and passes.
- [ ] ISC-12: Channel-off network invariant — no fetch to manifest URL when off.
- [ ] ISC-13: `README.md` contains an `## Auto-update` section.
- [ ] ISC-14: `ISA.md` updated with a fresh cycle for issue #16.
- [ ] ISC-15: `bun lint` exits 0; `bun test` exits 0 with all existing tests still passing; no new dependencies added.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| ISC-1, ISC-2 | file | grep store.ts for exports + constant | exact-match | Read + Grep |
| ISC-3, ISC-4, ISC-12 | bun test | `tests/update-poll.test.ts` covers channel-off, channel-flip, hidden-tab branches | passing | bun test |
| ISC-5 | file | grep App.tsx for `useEffect` keyed on `settings?.update_channel` | exact-match | Read + Grep |
| ISC-6 | file | App.tsx imports + renders `UpdateAvailableBanner` directly below `</header>` | structural | Read |
| ISC-7, ISC-8, ISC-9 | bun test | `tests/update-banner.test.ts` covers visibility gate, dismiss localStorage, click deep-link | passing | bun test |
| ISC-10, ISC-11 | bash | both test files exit 0 inside the suite | passing | bun test |
| ISC-13 | file | grep README for `## Auto-update` H2 | substring | Grep |
| ISC-14 | file | ISA.md frontmatter `phase: in_progress`, `slug: issue-16-auto-update`, this section present | structural | Read |
| ISC-15 | bash | `bun lint`, `bun test`, `bun run web:build` all exit 0; `package.json` deps unchanged | exit 0 | Bash |

## Features

| name | satisfies | depends_on | parallelizable |
|---|---|---|---|
| F1: store primitives (poller + dismiss + deep-link) — Engineer-A `9bd9acb` | ISC-1..4, ISC-7, ISC-8, ISC-10..12 | — | shipped |
| F2: UpdateAvailableBanner component — Engineer-A `9bd9acb` | ISC-6, ISC-7, ISC-9, ISC-11 | F1 | shipped |
| F3: App.tsx wiring (banner mount + poller useEffect) — Engineer-B | ISC-5, ISC-6 | F1, F2 | this cycle |
| F4: SettingsDrawer deep-link anchor + scroll | ISC-9 | F1 | this cycle |
| F5: README `## Auto-update` section | ISC-13 | — | this cycle |
| F6: ISA fresh cycle | ISC-14 | — | this cycle |
| F7: Verification gate (lint + test + build) | ISC-15 | F3..F6 | this cycle (last) |

## Decisions

- **2026-06-09T16:00Z** — Issue #16's triage suggestion ("Squirrel.Windows / electron-updater") rejected as stack-mismatch — privacy-screen is a bun+TypeScript Hono server with a Vite-bundled React client, not an Electron app. Reframing the issue as "the existing /api/version + /api/update/* backend is fine; the gap is in client-side cadence + global UX" preserves the user-visible outcome (find out about updates without opening Settings) while staying inside the existing architecture.
- **2026-06-09T16:00Z** — Effort tier E3 — code surface is small (~5 files), no new dependencies, no new HTTP routes, no new tests (Engineer-A already wrote them). The complexity is "wire two primitives into the app shell correctly the first time without breaking the existing drawer flow."
- **2026-06-09T16:00Z** — Engineer-A landed the store primitives + banner component + tests in `9bd9acb` (separate slice). Engineer-B handles the App.tsx + SettingsDrawer wiring + docs. Files forbidden for this cycle: `web/src/store.ts`, `web/src/components/UpdateAvailableBanner.tsx`, `tests/update-poll.test.ts`, `tests/update-banner.test.ts` — touching them would race the A/B serialization.
- **2026-06-09T16:00Z** — Poller lifecycle uses a `useEffect` keyed on `settings?.update_channel` (not bundled with the boot effect). Settings hydrate asynchronously: first render has `channel === undefined`, second has the loaded value. A separate effect lets the second pass actually start the poller; bundling would have required imperative re-checks.
- **2026-06-09T16:00Z** — README placement honored the brief literally: `## Auto-update` placed after `## Quick start — Hook` and before `## What it covers`. The pre-existing `## Updates` section (lines 235+) remains in place because it documents the download/install UX (a related but distinct surface). The new section is the opt-in + privacy-guarantees frame the brief specified.
- **2026-06-09T16:00Z** — ISA: previous cycle's Goal/Criteria/Test-Strategy/Features/Decisions/Verification archived under `## Prior Runs` rather than deleted, per the brief's "DON'T lose history" rule. Long-lived `## Problem` / `## Vision` / `## Out of Scope` / `## Principles` / `## Constraints` remain at the top — they describe the project, not any single cycle.

## Changelog

*(Populated at LEARN, after QA + UI + Pentester gates clear.)*

## Verification

All 15 ISC criteria verified across four commits on `ac-build`. Pipeline phases ran: Architect → Engineer-A → Engineer-B → 3× code-review (correctness/quality/efficiency) → simplify polish → QATester + UIReviewer + Silas (pentester) → validation hardening pass → green.

- [x] ISC-1..ISC-4 — `web/src/store.ts` lines 68 (`VERSION_POLL_INTERVAL_MS`), 219–222 (store-type exports), 684–714 (start/stop/dismiss/visibility/channel guards); `tests/update-poll.test.ts` 14 tests green.
- [x] ISC-5 — `web/src/App.tsx:92-97` `useEffect(..., [updateChannel, startVersionPoller, stopVersionPoller])`; starts on stable/beta, cleanup stops unconditionally.
- [x] ISC-6 — `web/src/App.tsx:159` renders `<UpdateAvailableBanner />` immediately after `</header>` at line 154.
- [x] ISC-7 — `UpdateAvailableBanner.tsx:32-33` early-return when `!versionInfo?.updateAvailable || !updateInfo?.version` or `dismissedUpdateVersion === updateInfo.version`.
- [x] ISC-8 — LS key is `ps.dismissed-update-version` (simplify polish renamed from colon-style for convention consistency); written via `dismissUpdate` action.
- [x] ISC-9 — Banner body sets `settingsDeepLink='update'` then opens drawer; `SettingsDrawer.tsx:68-76` scrolls `#update-section` (line 241) into view via `requestAnimationFrame` + `scrollIntoView`, then clears the deep link.
- [x] ISC-10, ISC-11 — full test suite green (see Output values below).
- [x] ISC-12 — channel-off invariant verified at three independent layers: server `routes/version.ts:36-45` short-circuit, client `store.ts:689-690` channel-guard, test `update-poll.test.ts:102` asserts zero fetch over 8 ticks. Hardening: HTTPS-only enforcement in `safeManifestUrl()` + `redirect: 'error'` in `update-check.ts` so even an opted-in user can't be tricked into a plaintext or cross-origin beacon.
- [x] ISC-13 — `README.md:30` `## Auto-update` section present (between `## Quick start — Hook` and `## What it covers`).
- [x] ISC-14 — frontmatter `slug: issue-16-auto-update`, this section, and `## Issue #16 — Auto-Update` above all present; prior run archived under `## Prior Runs`.
- [x] ISC-15 — `bun lint` exit 0; `bun test` 390 pass / 6 skip / 0 fail across 23 files; `bun run web:build` exit 0; `git diff origin/dev..ac-build -- package.json bun.lock` empty.

**Closing values:**
- `bun lint` exit: 0
- `bun test` final: 390 pass / 6 skip / 0 fail (782 expect() calls, 3.29s, 23 files)
- `bun run web:build` exit: 0 (`dist/assets/index-*.js` 318.16 KB / 98.86 KB gzip)
- PR URL: https://github.com/adamcongdon/privacy-screen/pull/18

**Commits on `ac-build`:**
- `9bd9acb` — feat(#16): version poller + UpdateAvailableBanner (Engineer-A)
- `a009f61` — feat(#16): wire poller + banner into App; docs + ISA (Engineer-B)
- `38ba0e2` — refactor(#16): simplify polish — LS key convention + banner narrowing
- `41f4ef0` — fix(#16): UI a11y + manifest egress hardening from validation phase

**Validation findings resolved in `41f4ef0`:**
- UIReviewer HIGH — banner contrast 3.76:1 → ~5.1:1 (emerald-600 → emerald-700); body button focus-ring restored.
- Pentester MED — `redirect: 'error'` on the manifest GET; `safeManifestUrl()` refuses non-https + malformed URLs.

## Prior Runs

History of cycles that closed against this ISA. Newest first.

### ac-build PR — issues #6 + #14 + #15 + claude workflows (closed 2026-06-09T15:00Z)

> Phase: complete. Progress: 36/36. Effort: E5. PR: https://github.com/adamcongdon/privacy-screen/pull/17.

**Prior Goal:** Land a single PR from `ac-build` to `dev` that (a) ports the three `claude-*.yml` workflows from `adamcongdon/se-lz` adapted to privacy-screen's domain, (b) restores the paused #14 code-signing infrastructure as a gated-off, ready-to-enable pipeline, (c) ships the #6 hook findings-preview + judge-confidence-gauge auto-approve flow, and (d) ships the #15 "Send feedback" button that files a GitHub issue via the local `claude` CLI — with `bun lint` clean and `bun test` 100% green.

**Prior Criteria:**

*Workflow ports (D1–D3):*
- [x] ISC-1: `.github/workflows/claude.yml` exists in repo
- [x] ISC-2: `claude.yml` runs on `ubuntu-latest` (not `self-hosted`)
- [x] ISC-3: `claude.yml` references `secrets.CLAUDE_CODE_OAUTH_TOKEN`
- [x] ISC-4: `claude.yml` triggers on issue_comment, pr_review_comment, issues, pr_review with `@claude` mention
- [x] ISC-5: `.github/workflows/claude-code-review.yml` exists
- [x] ISC-6: `claude-code-review.yml` runs on `ubuntu-latest`, triggers on PR open/sync/reopen/ready_for_review
- [x] ISC-7: `claude-code-review.yml` uses `/code-review:code-review` plugin prompt
- [x] ISC-8: `.github/workflows/claude-triage.yml` exists
- [x] ISC-9: `claude-triage.yml` runs on `ubuntu-latest`, triggers on `issues: [opened]`
- [x] ISC-10: `claude-triage.yml` triage prompt references privacy-screen domain (hook, scrubber, judge, web UI) — NOT VIP/Blazor
- [x] ISC-11: `claude-triage.yml` posts comment via gh CLI (not python+urllib like se-lz) so privacy-screen has no python dep
- [x] ISC-12: `.github/workflows/README.md` documents `CLAUDE_CODE_OAUTH_TOKEN` + PAT requirements

*Code-signing restore (D4):*
- [x] ISC-13: `.github/workflows/release.yml` restored to split-job structure (build / sign-macos / create-release) from commit 87f8612
- [x] ISC-14: `scripts/build-release.ts` restored to support `--manifest-only` flag
- [x] ISC-15: All signing steps gated on `vars.RUN_CODE_SIGNING == 'true'` — unset by default
- [x] ISC-16: With `RUN_CODE_SIGNING` unset, release.yml produces unsigned releases identically to current behavior (no CI breakage)
- [x] ISC-17: `.github/workflows/README.md` documents the secrets (WIN_P12_*, MAC_DEV_ID_*, NOTARY_*) required to enable

*Issue #6 hook polish (D5):*
- [x] ISC-18: Hook BLOCK output includes the literal phrase "Double check it for sensitive data, personal data, PII"
- [x] ISC-19: Hook BLOCK output enumerates findings (category + count) in a stable format
- [x] ISC-20: When judge is enabled AND judge returns 0 suspicious_spans AND scrubber returns 0 findings, hook treats the payload as "100% clean" and passes through
- [x] ISC-21: 100%-clean auto-approve path is gated by `cfg.hook.auto_approve_clean: true` (default false — opt-in)
- [x] ISC-22: Existing hook-contract tests updated to match new BLOCK message format
- [x] ISC-23: New test: auto-approve path triggers when configured AND clean
- [x] ISC-24: New test: auto-approve does NOT trigger when judge finds suspicious spans

*Issue #15 feedback button (D6):*
- [x] ISC-25: `POST /api/feedback` route exists in `server/server.ts`
- [x] ISC-26: Feedback route collects sanitized diagnostics (config redacted, recent error count, version, claude detection status, judge status) — runs them through scrubber first
- [x] ISC-27: Feedback route spawns local `claude` CLI with a prompt that includes diagnostics + asks it to file a GitHub issue
- [x] ISC-28: Route refuses to run if `claude` CLI not detected (mirrors server boot gate)
- [x] ISC-29: New Web UI button visible in header/topbar area with `Send feedback` label
- [x] ISC-30: Button click → modal/dialog with diagnostics preview → user confirms → POST /api/feedback → toast on success or failure
- [x] ISC-31: New test: /api/feedback handles missing `claude` CLI gracefully (returns 503)
- [x] ISC-32: Anti: feedback diagnostics are never sent to GitHub without being scrubbed first

*Validation gates:*
- [x] ISC-33: `bun lint` exits 0
- [x] ISC-34: `bun test` exits 0 with all-pass (no new failures, baseline 359 + new tests)
- [x] ISC-35: Anti: existing 6 skipped tests remain skipped (not silently unskipped or quietly removed)
- [x] ISC-36: PR opened from `ac-build` to `dev` with description referencing #6, #14, #15

**Prior Test Strategy** *(condensed; see git history of this file for the full per-row table)*: file/grep checks on the three workflow YAMLs, structural review of `release.yml`'s `RUN_CODE_SIGNING` gates, `bun test` assertions on hook-contract / hook-auto-approve / feedback-route, and `gh pr view` confirming PR #17.

**Prior Features:** F1 claude.yml port · F2 claude-code-review.yml port · F3 claude-triage.yml port · F4 workflows README · F5 signing-infra restore · F6 hook findings-preview + judge auto-approve · F7 feedback button + /api/feedback route · F8 full test suite + PR open.

**Prior Decisions:**

- **2026-06-09T13:55Z** — Effort tier E5 set via conversation-context override. Classifier returned E4 but user-confirmed all 3 issues + 3 workflows + signing restore + PR is comprehensive scope (>2h). `effort_source: context-override`.
- **2026-06-09T13:55Z** — Workflows ported with `runs-on: ubuntu-latest` (not `self-hosted`); user's privacy-screen repo has no self-hosted runner; se-lz uses example infra runners not available here.
- **2026-06-09T13:55Z** — Triage workflow rewritten from python+urllib to bash+gh-cli. gh is available on ubuntu-latest runners by default; bash+gh is more idiomatic; avoids spurious python dep for a tiny POST.
- **2026-06-09T13:55Z** — #14 signing infra restored via re-apply of commit 87f8612's content, but with `RUN_CODE_SIGNING` gate explicitly defaulted-off. User has no certs yet; this leaves them 1-repo-variable away from re-enabling when they do.
- **2026-06-09T13:55Z** — #15 feedback flow uses local `claude` CLI (already a hard dep per `claude-code-check.ts`) instead of a user-supplied PAT or server-side GitHub App. Inherits user's gh CLI session; matches the "Inherit existing auth" principle.
- **2026-06-09T13:55Z** — Show-your-math: delegation floor under by 1. Anvil skipped because whole-project context already loaded into my own session window; Forge covers GPT-5.4 perspective; no second OpenAI-family lens adds value here.
- **2026-06-09T13:55Z** — `Plans/FAMILY_PHOTO_GUARDIAN.md` left untracked — it's a spin-off project's planning doc, not part of this PR.
- **2026-06-09T14:18Z** — Forge unavailable (codex CLI absent at `~/.bun/bin/codex`). Per Forge's own fallback doctrine, swapping to `Copilot` (GitHub-family, `gh copilot` at `--reasoning-effort xhigh`) as the audited substitute. Implementation work for Engineer-A/B/C will route through Copilot. If Copilot also returns unavailable, fall through to Engineer (Claude-family) with show-your-math.

**Prior Verification:**

`bun lint` exits 0; `bun test` reports `371 pass, 6 skip, 0 fail` across 21 files (751 expect() calls). Baseline was 359 pass, so 12 new tests landed in this PR (hook-contract update + hook-auto-approve x2 + feedback-route x9 covering 503, anti-leak, success, preview, error paths, oversized redaction, env-var gating).

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

*Doctrine compliance:*
- Rule 1 (live-probe): scrub + spawn paths verified by passing tests; lint + test exit codes captured. UI verification via Interceptor deferred — local web flow only; no deploy step in this PR.
- Rule 2 (Advisor): consulted on the spawn-resolution, gh-CLI hardening, and fail-CLOSED contract questions. Concerns about (a) and (b) folded into the Pentester remediation commit `8dfd6db`.
- Rule 2a (Cato cross-vendor audit): **substitute used** — Cato is codex-CLI-dependent and the binary is absent on this host (same constraint that blocked Forge). The Anthropic-blind-spot lens was therefore covered by (i) Copilot as the GitHub-family code substrate for every implementation pass and (ii) the Pentester (`silent-failure-hunter`) audit which surfaced 3 HIGH + 8 MEDIUM findings, all remediated in commit `8dfd6db`. Show-your-math logged in `## Decisions`.
- Rule 3 (conflict surfacing): Pentester verdict was `FAIL`; remediated and re-tested. No silent switch.

*Deliverable compliance (D1–D8):*
- D1: `.github/workflows/claude.yml` ✓
- D2: `.github/workflows/claude-code-review.yml` ✓
- D3: `.github/workflows/claude-triage.yml` ✓
- D4: `release.yml` + `scripts/build-release.ts` restored, gated off ✓
- D5: #6 hook polish ✓ (commit `74217ed`)
- D6: #15 feedback button + route ✓ (commits `efa0b8e` backend + `7a8a98f` web + `8dfd6db` security pass)
- D7: lint + test green ✓
- D8: PR appended below ✓
