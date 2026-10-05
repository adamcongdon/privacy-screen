---
project: privacy-screen
task: "Project ISA — privacy-screen"
phase: scoping
progress: 0/42
started: 2026-10-05T00:00:00-04:00
updated: 2026-10-05T00:00:00-04:00
---

# privacy-screen

<!-- Seed-generated draft (2026-10-05) from README, FEATURE_MAP, CHANGELOG, tests/, workflows, and the last 30 commits. Review required before this is authoritative. -->

## Problem

People paste customer names, IPs, hostnames, credentials, and other PII into cloud AI tools because there is no gate between the prompt and the provider. Existing filters run in the cloud (so the data has already left) or are ML-only and opaque. There is no local, auditable layer that tokenizes sensitive values before anything leaves the machine and works across pasted text, spreadsheets, PDFs, and Claude Code sessions.

## Vision

**Who it's for:** first, technical pre- and post-sales engineers (built for the author and SEs/CS at Veeam) who handle customer logs, configs, and reports and want AI help without leaking customer data. Beyond that, anyone who wants to anonymize a document before sending it to AI.

**The moment:** an SE drops in a customer log bundle or health-check report and gets two things at once. First, they *know* nothing leaked: they can see exactly what will leave the machine, with every sensitive value already a token, before they hit send. Second, the answer that comes back is as useful as if they had sent the raw document. They aren't trading usefulness for privacy.

## Out of Scope

- Blanket anonymization guarantees. This is a high-floor first layer, not a ceiling; it will miss novel name formats and anything not enumerated.
- Cloud-side or hosted scrubbing. Nothing is scrubbed off-machine.
- Telemetry of any kind.
- OCR of scanned or image-only PDFs (they error explicitly instead).
- The family privacy browser extension (Family Photo Guardian). It is a sibling effort with its own plan in `Plans/FAMILY_PHOTO_GUARDIAN.md`, not part of this product's done condition.

## Principles

- **Nothing raw ever leaves the machine.** Every byte that goes to a provider has been scrubbed on-device first. When usability and this rule conflict, the rule wins and usability gets solved another way. A miss is a bug, never a tradeoff.

## Constraints

- Runtime is Bun + TypeScript; server on Hono, UI on React + Vite + Tailwind.
- The server binds loopback only (`127.0.0.1:31338`) and refuses to start otherwise.
- Credentials always BLOCK; they are never tokenized and sent.
- Raw uploads never touch disk: staged in memory and dropped after the scrubbed copy is produced.
- The LLM judge is opt-in, local-only, refuses non-loopback endpoints, and can only add to the review queue. It never mutates scrub output.
- Auto-update is off by default (zero outbound network). When on, SHA-256 is verified before any binary swap and channel mismatches are rejected.
- Inference runs through the user's local `claude` CLI OAuth session; no API key is stored.
- Branch flow: `ac-build` → `beta` (auto beta prerelease) → `main` only via the guarded `promote-to-production` workflow. PRs to `main` must come from `beta` with owner approval.
- Workflow actions are pinned to full commit SHAs.
- Apache-2.0; `PRIVACY_CONFIG.yaml` and `*.db` are never committed.

## Goal

privacy-screen is a local-first PII gate that anyone can install with one double-click and trust: every supported input (text, xlsx/csv, PDF, Claude Code tool calls) is tokenized on-device before reaching an AI provider, credentials never leave, and the full test suite plus CI security gates stay green on every supported platform.

## Features

### F0 · Cross-cutting
Why: the trust promise. One leak or one unexplained network call breaks the product, whatever else works.

- [ ] ISC-1: `bun test tests/` passes with 0 failures on a checkout whose path contains a space (e.g. `/Volumes/My Drive/...`).
- [ ] ISC-2: `bun run lint` (tsc --noEmit) exits 0.
- [ ] ISC-3: The server refuses to bind any non-loopback host.
- [ ] ISC-4: Every credential category in the README table produces BLOCK on `/api/scrub`, `/api/files` (text, xlsx, PDF), and the hook. Nothing is tokenized and passed through.
- [ ] ISC-5: Origin policy rejects cross-origin POSTs and DNS-rebinding Host headers.
- [ ] ISC-6: Anti: with `update_channel: off` and judge disabled, a full scrub + review session makes zero outbound connections apart from the user-initiated `/api/send`.
- [ ] ISC-7: Anti: no uploaded file's raw bytes are written to disk during upload, scrub, or export.
- [ ] ISC-8: CI on `beta` is green for ci, gitleaks, semgrep, CodeQL, and OSV-Scanner.

### F1 · Scrub engine
Why: deterministic, explainable detection is the floor everything else stands on.

- [ ] ISC-9: [SPLIT — see ISC-9.1, ISC-9.2]
- [ ] ISC-9.1: Every category in the README "What it covers" table has a passing positive-detection test.
- [ ] ISC-9.2: Every category in the README "What it covers" table has a passing negative (no false match) test.
- [ ] ISC-10: The same raw value maps to the same token across calls within one vocab DB.
- [ ] ISC-11: SSN detection never matches a bare 9-digit run without separators.
- [ ] ISC-12: Allowlisted values are never tokenized.

### F2 · App — paste, scrub, send
Why: the main path for anyone who isn't a Claude Code power user.

- [ ] ISC-13: A fresh packaged binary launched with `--open` serves the UI at `127.0.0.1:31338` and `GET /api/health` returns `{ ok, version }`.
- [ ] ISC-14: Pasted text with PII shows tokenized output in the UI before send, and the payload `/api/send` passes to `claude` contains no raw value from the scrub map.
- [ ] ISC-25: Antecedent: before send, the UI shows the exact outbound payload with every token visibly marked, so the user can confirm what leaves without reading the raw input.
- [ ] ISC-26: On a golden set of SE tasks (log triage, health-check summary, config review), answers from the scrubbed input are judged at least as useful as answers from the raw input on ≥90% of cases.

### F3 · Files — spreadsheets and PDFs
Why: real customer data shows up as attachments, not just prose.

- [ ] ISC-15: [SPLIT — see ISC-15.1, ISC-15.2]
- [ ] ISC-15.1: An xlsx column policy chosen at commit is written to `PRIVACY_CONFIG.yaml` as an `xlsx.columnRules` entry.
- [ ] ISC-15.2: A later upload with a matching header (case-insensitive) auto-resolves to the saved policy.
- [ ] ISC-16: Every `Skip` pass-through writes a `redaction_log` entry.
- [ ] ISC-31: A `Skip` column is scanned with the full free-text scrubber before commit; any detected credential blocks the file, and any detected PII lists the hits for the user to confirm before the column can pass raw.
- [ ] ISC-32: Anti: a remembered `Skip` rule never sends a column raw without that scan running on the current file.
- [ ] ISC-17: A scrubbed-PDF export contains no string from the original scrub map, and is rebuilt from scrubbed text rather than edited bytes.
- [ ] ISC-18: Scanned, corrupt, and password-protected PDFs each return a distinct explicit error.

### F4 · Claude Code hook
Why: the same engine guarding agent sessions, where the data flows without a human reviewing each send.

- [ ] ISC-19: The hook contract tests pass for UserPromptSubmit, PreToolUse, and PostToolUse (block / updatedInput / exit-code shapes).
- [ ] ISC-33: An observe-mode soak of 14 consecutive days on real Claude Code work logs fewer than 1 false positive per day on average (from `redaction_log`).
- [ ] ISC-34: Hook mode has zero misses on the PII golden test set.
- [ ] ISC-35: The README marks the hook as recommended only after the soak and golden set pass. (after: ISC-33, ISC-34)
- [ ] ISC-20: Edit/MultiEdit/NotebookEdit/Grep/Glob skipped fields round-trip byte-identical while still being credential-scanned.

### F5 · Optional LLM judge
Why: catches what regex misses without ever being trusted to rewrite output.

- [ ] ISC-36: The default judge model is non-Chinese-origin, Apache/MIT licensed, matches or beats Qwen2.5-1.5B recall on the judge golden set, and runs under ~2 GB RSS on an 8 GB Mac.
- [ ] ISC-37: [SPLIT — see ISC-37.1, ISC-37.2]
- [ ] ISC-37.1: The judge settings panel offers only the model tiers this machine's detected RAM and GPU/accelerator can run.
- [ ] ISC-37.2: Exactly one offered tier is marked recommended.
- [ ] ISC-38: Each higher tier beats the tier below it on judge golden-set recall; a tier that doesn't is not offered.
- [ ] ISC-39: Anti: no model is downloaded or swapped without the user clicking to install it.
- [ ] ISC-21: Hook stdout is byte-identical whether the judge succeeds, hangs past its abort, or refuses.

### F6 · Distribution and update
Why: a privacy tool nobody can install doesn't protect anybody.

- [ ] ISC-22: Each release publishes a Windows setup.exe, macOS arm64 + x64 DMGs, and a manifest whose SHA-256 values match the assets.
- [ ] ISC-23: Applying a downloaded update whose SHA-256 doesn't match the manifest is refused and leaves the running binary in place.

### F8 · Answer rehydration (Layer D)
Why: an answer that reads `{CUSTOMER}` and `{IP_2}` makes the user do the swap in their head. Swapping the real values back in locally is what makes the scrubbed answer as useful as a raw one.

- [ ] ISC-27: In the app, every token in the model's answer that exists in the local scrub map is shown with its original value, and the swap happens entirely on-device.
- [ ] ISC-28: The user can switch the answer between the real-value and tokenized views.
- [ ] ISC-29: Anti: a follow-up turn never sends rehydrated values to the provider; the next payload is re-scrubbed and contains no raw value from the scrub map.
- [ ] ISC-30: A token the model invented or mangled (not in the scrub map) is left visibly as-is, never guessed.

### F7 · Docs truth
Why: on a public repo the README is the product's promise. A dead link there reads as an abandoned project.

- [ ] ISC-24: Every repo-relative path the README links to exists (currently `Plans/INSTALLER.md` and `Plans/LLM_RESEARCH.md` do not).

## Not yet specified

- fog: Judge tiers. Which models fill each tier (e.g. ~1.5B / ~7B / ~14B+), and where do the RAM/GPU cutoffs sit? Graduates when candidates are benchmarked against the golden set.

## Test Strategy

| isc | type | check | threshold | tool | anchors_to |
|-----|------|-------|-----------|------|------------|
| ISC-1 | bash | `bun test tests/` from a checkout path with a space | 0 fail | bun | tests/ |
| ISC-2 | bash | `bun run lint` | exit 0 | tsc | tsconfig.json |
| ISC-3 | bun-test | start server with non-loopback HOST | refuses | bun | server/server.ts |
| ISC-4 | bun-test | credential fixtures through scrub, files, hook | BLOCK on all | bun | tests/no-residual-pii.test.ts |
| ISC-5 | bun-test | origin-policy suite | pass | bun | tests/origin-policy.test.ts |
| ISC-6 | bash | scrub session under a network monitor (lsof / Little Snitch log) | 0 outbound | lsof | server/ |
| ISC-7 | bash | upload xlsx + PDF, `fs_usage`/find newer files in temp + data dirs | no raw bytes | fs_usage | server/routes |
| ISC-8 | bash | `gh run list --branch beta` latest per workflow | all success | gh | .github/workflows |
| ISC-9 | bun-test | patterns suite | pass | bun | tests/patterns.test.ts |
| ISC-10 | bun-test | vocab stability | pass | bun | tests/vocab.test.ts |
| ISC-11 | bun-test | SSN negative cases | pass | bun | tests/patterns.test.ts |
| ISC-12 | bun-test | allowlist case | pass | bun | tests/scrubber.test.ts |
| ISC-13 | screenshot | launch packaged binary, open UI | UI renders, health ok | Interceptor | dist/ |
| ISC-14 | bun-test | send payload vs scrub map | no raw value | bun | tests/send-system-prompt.test.ts |
| ISC-25 | screenshot | paste PII sample, open pre-send view | every token marked, no raw value | Interceptor | web/src |
| ISC-26 | eval | paired raw vs scrubbed answers, rubric judge | ≥90% at parity | Evals | tests/ |
| ISC-27 | bun-test | answer with known tokens → render | all mapped tokens show originals | bun | web/src |
| ISC-28 | screenshot | toggle view on a rehydrated answer | both views render | Interceptor | web/src |
| ISC-29 | bun-test | follow-up payload vs scrub map | no raw value | bun | server/routes |
| ISC-30 | bun-test | answer with unknown `{FOO_9}` | left verbatim | bun | web/src |
| ISC-31 | bun-test | Skip column seeded with IP + credential | PII listed, credential BLOCK | bun | tests/files-route-xlsx.test.ts |
| ISC-32 | bun-test | remembered Skip + PII in new file | scan runs, confirm required | bun | tests/files-route-xlsx.test.ts |
| ISC-33 | manual | 14-day `redaction_log` FP review | <1 FP/day avg | cli stats | hooks/ |
| ISC-34 | bun-test | golden PII set through hook | 0 misses | bun | tests/hook-contract.test.ts |
| ISC-35 | bash | grep README hook status vs ISC-33/34 state | consistent | bash | README.md |
| ISC-36 | eval | golden set recall + RSS + license check | ≥ Qwen recall, <2 GB | Evals | tests/judge-golden.test.ts |
| ISC-37 | bun-test | mocked 8/16/32 GB + GPU specs → offered tiers | matches tier table | bun | server/routes |
| ISC-38 | eval | golden recall per tier | strictly increasing | Evals | tests/judge-golden.test.ts |
| ISC-39 | bun-test | tier recommendation with no click | 0 downloads | bun | tests/install-judge.test.ts |
| ISC-15 | bun-test | columnRules persistence | pass | bun | tests/files-route-xlsx.test.ts |
| ISC-16 | bun-test | skip → redaction_log | pass | bun | tests/xlsx-scrubber.test.ts |
| ISC-17 | bun-test | exported PDF text vs scrub map | no raw value | bun | tests/files-route-pdf-render.test.ts |
| ISC-18 | bun-test | three bad-PDF fixtures | distinct errors | bun | tests/files-route-pdf.test.ts |
| ISC-19 | bun-test | hook contract suite | pass | bun | tests/hook-contract.test.ts |
| ISC-20 | bun-test | skipped-field round trip | byte-identical | bun | tests/hook-contract.test.ts |
| ISC-21 | bun-test | judge handoff suite | byte-identical stdout | bun | tests/hook-judge-handoff.test.ts |
| ISC-22 | bash | `gh release view` assets + sha256 compare to manifest | all match | gh | .github/workflows/release.yml |
| ISC-23 | bun-test | bad-sha apply | refused, binary unchanged | bun | tests/update-install-fetch.test.ts |
| ISC-24 | bash | extract README relative links, `test -e` each | 0 missing | bash | README.md |

## Decisions

- 2026-10-05: Seed-generated draft. ISC-1..24 seeded from README, FEATURE_MAP, tests/, and workflows. Run the ISA Interview workflow on this file to fill Principles, refine Vision and Goal, and audit claims.
- 2026-10-05: Pre-seed probe run on a local checkout (branch `docs/verify-app` @ 7b61678): `bun run lint` clean; `bun test` 678 pass / 42 fail / 6 skip. All 42 failures are subprocess-spawn suites (hook contract, judge handoff, auto-approve, cli scrub, llm-process). Root cause: tests build paths from `new URL(...).pathname` without decoding, so a checkout path with a space arrives as `%20` (ENOENT). Running the hook and CLI directly works. This is a test-harness bug, not a product bug. That's why ISC-1 names a space in the path.
- 2026-10-05: refined: Layer D (answer rehydration) moved from Out of Scope into scope as F8, per the principal. Driver: the Vision's "answer as useful as raw" pillar. Confirmed no reversal code exists today.
- 2026-10-05: refined: xlsx `Skip` keeps raw pass-through but must clear a PII/credential scan with explicit user confirmation first (ISC-31, ISC-32). Reconciles Skip with the "nothing raw leaves" principle; principal chose warn-first over keep or drop.
- 2026-10-05: Family Photo Guardian stays a separate project with its own repo and ISA; never a privacy-screen feature (principal).
- 2026-10-05: Hook-recommendation bar set by principal: 14-day observe soak, <1 FP/day, 0 golden-set misses (ISC-33..35). Hook fog graduated.
- 2026-10-05: Judge bar set (ISC-36) and spec-scaled tiers added (ISC-37..39) per principal: better hardware gets bigger, more accurate judge models, always opt-in to download.
- 2026-10-05: refined: split bundled ISC-9, ISC-15, ISC-37 into .1/.2 children per Splitting Test (ISAGate advisory). Parents kept as tombstones for ID stability.
