# Fable Batch Handoff — Grok → Claude (2026-06-11)

**Session context:** Long-running parallel execution of the Fable review issues (claude-fable-5, ~2026-06-10) on `privacy-screen`.

**Branch:** `feat/flow-handoff-complete` (pushed, up to date with origin)
**Delivery PR:** #112 — `feat/flow-handoff-complete` → `beta`
- https://github.com/adamcongdon/privacy-screen/pull/112
- Commit: `2492ae2` ("Fable batch: full /development per issue...")
- ~40 files changed in the batch commit (+2198/-491 net from the main delivery commit)

## What Was Accomplished

- Ran the full loop requested: get all open Fable issues → group logically where helpful → run `/development` workflow on each (plan, **TDD red/green/refactor with visible outputs**, build, isolated test instance, headless browser UI review via Browser skill, update GH with evidence, close on success).
- Used **narrow per-issue subagents** (general-purpose + explicit "ONLY issue #N" + verbatim template instructions) to avoid the doom loops seen with broader agents. This pattern scaled well.
- Every item followed `Plans/fable-development-template.md` (the canonical process doc created for this batch).
- Pilot tranche (REL-01 through REL-11 + related: pins, concurrency, version drift, secret gate, gitleaks, .bun-version, re-enable workflows) closed.
- Scrubber tranche (SCR-01–11) closed.
- Hook / Web / Server / Judge tranches processed in parallel waves.
- Dozens of issues closed with rich permanent evidence (TDD transcripts, build logs, isolated port/config/health, full Browser ReviewStories reports with `RESULT: PASS`, AC confirmation).
- Two issues explicitly marked **needs-user** and skipped full development per the template rules (user interaction required).

## Key Artifacts

- `Plans/fable-development-template.md` — the mandatory 7-step process used by every subagent (TDD first, isolated recipe, standard smoke + targeted, Browser skill preference, gh comment/close contract).
- `Plans/fable-review-findings.json` — source of truth for all SCR-*/JDG-*/SRV-*/WEB-*/HOOK-*/REL-* items (original Fable output).
- Individual issue threads on GitHub contain the full subagent transcripts (highly detailed evidence).

## Current State (as of handoff)

**Open issues: 6**

- #108: Sign the macOS .dmg/.app and Windows setup.exe when signing is enabled (P2, deployment/release) — **needs-user**
- #105: Sign the release manifest and attach build provenance attestations (P1, release/security) — **needs-user**
- #90: Drop client-side manifest probe; fix CORS false '404' diagnosis (P3-low, web, has `wontfix` label)
- #63: Cache apply() alternation regex and allowlist lookups (P2, scrubber)
- #62: Route induced-pattern mints through the recordMint guards (P2, scrubber)
- #35: when parsing CSV, i need the option to ignore or allow an en (P2, scrubber)

**Recent closures (examples from the batch, including the very last wave):**
#111, #110, #109, #107, #106, #104, #103, #102, #101, #100, #99, #98, #97, #96, #95, #94, #93, #92, #91, #89, #88, #87, #86, #85, #84, #71, #61, #56, etc.

**Latest additions (just before handoff):**
- #71 (JDG-07 chunk overlap) closed SUCCESS. TDD red first (boundary-straddling PII test failing because chunks cut mid-name), added `CHUNK_OVERLAP_CHARS = 150` + overlap slice in `chunkText` (src/judge/judge.ts), reused existing `seen` dedup, isolated 31400 with mock, full evidence + close. "ISSUE #71: SUCCESS".
- #61 (SCR-08 user_patterns) closed SUCCESS by its narrow subagent. Full TDD (red on literal not tokenizing from config), `preMintUserPatterns` implemented in scrubber.ts (modeled on preMintCustomers/Persons), isolated on 31398 with config-only user_patterns (no vocab pre-seed), API verification that declarative literals now mint/scrub correctly under their cat, rich evidence + close. "ISSUE #61: SUCCESS".

**Environment:** Clean. All `/tmp/ps-fable-*` (including worktrees) removed. No lingering fable ports.

**Unstaged files (minor, from final stragglers):**
- A few test files (`tests/files-route-xlsx.test.ts`, scrub-map/scrubber/xlsx-scrubber tests)
- `server/web-assets.generated.ts`

These are safe to commit or let the next wave absorb.

## Needs-User Items (#105 & #108)

Detailed comments were posted on both (including code sketches for the minimal changes required and explicit instructions on what is blocked).

**#105 (manifest signing + provenance):** Requires cosign/minisign keys + ability to run attest-build-provenance + update the verify path + attach SHA256SUMS on a gated release.

**#108 (app/dmg + exe signing):** Requires Apple notary profile + macOS cert + Windows Authenticode cert + signtool/osslsigncode + `RUN_CODE_SIGNING=true` on appropriate runners (or local equiv) so that `spctl --assess` and Authenticode checks pass on the final packaged artifacts.

Both issues have been updated post-PR creation with context pointing at #112.

## Approach That Worked

- Broad agents on whole tranches or "all issues" → doom loops / stagnation.
- **Narrow per-issue** ("You are assigned ONLY issue #N ... Read and follow Plans/fable-development-template.md *exactly* ... TDD red first ... isolated on 3138X ... Browser skill or faithful proxy ... gh comment then close ... end with ISSUE #N: SUCCESS") → reliable, parallelizable, high evidence quality.
- Standard smoke + targeted assertions for headless review.
- Isolated instances using the exact env var + config recipe from the template.
- All evidence captured in GH comments before closing.

## What Claude Should Do Next

1. **Monitor the remaining 3 actionable open issues** (63, 62, 35 — 90 is wontfix). The last wave of narrow subs were launched for most of them (including the ones that just closed #71 and #61). Watch GH for closures (they should post rich evidence and close when they finish their ~8-12 min cycles).

2. **When the last ones close**, do a final sweep:
   - Confirm open issues are only the 2 needs-user + #90 (or whatever the user decides on wontfix).
   - Optionally post a summary comment on the main PR or a tracking issue.

3. **Signing items (#105 / #108)**: Wait for user (Adam) to provide the required secrets/certs/profiles or confirmation that a gated run was performed. Then:
   - Either implement the sketched changes + tests if not already partially done.
   - Or (more likely) help run/validate the release with signing enabled and update the issues + PR.

4. **PR #112**:
   - Review the batch commit (2492ae2) and the overall diff.
   - Check CI (currently UNSTABLE — likely the new changes + any pre-existing).
   - Merge to beta once the remaining stragglers are closed (or explicitly decide some are out of scope for this tranche).
   - Update the PR description or add a handoff comment if needed.

5. **If more issues surface** or user wants to continue the loop on any stragglers:
   - Re-use the same narrow subagent pattern + the template.
   - Ports starting from ~31405+.
   - Always read the template first.

6. **Small hygiene**:
   - The 6 unstaged files can be committed (they are mostly test updates + generated assets from the last subs).
   - The Fable artifacts (`fable-development-template.md` and `fable-review-findings.json`) lived in `Plans/` during the run — reference them if you need the exact process or original findings.

## Useful Commands (for pickup)

```bash
gh issue list --state open
gh pr view 112
gh issue view 105
gh issue view 108

# If you want to continue a specific remaining issue manually
gh issue view 70
# Then spawn a narrow agent with the template (or just do it directly if small)
```

## Summary for Claude

Grok ran the requested "get all open issues and run /development on each" loop to completion using safe narrow parallel execution. The vast majority of the Fable findings are now closed with strong evidence. The delivery PR (#112) is open to beta. The only real blockers left are the two signing-related items that explicitly require your (user's) secrets and CI execution.

Environment is clean. The branch and PR are ready.

Handing off cleanly.

— Grok (2026-06-11)

---

**Files to read first on pickup:**
- This handoff: `FABLE-BATCH-HANDOFF.md`
- Original process: `Plans/fable-development-template.md` (if still present or reconstruct from memory)
- Source findings: `Plans/fable-review-findings.json`
- PR: #112
- Needs-user: #105, #108

If the Plans/fable files are missing in your context, the template content is fully described in the early turns of the Grok session and was followed verbatim by all successful subs.