# Diagnose & Fix Failing GitHub Actions

## Context

All five workflows on `privacy-screen` are failing in some configuration. The repo is **private** (`adamcongdon/privacy-screen`), which is the root cause of three of the failures — GitHub's free code scanning + dependency graph features require either a public repo or GitHub Advanced Security. The other failures are a workflow-config bug, a CI trigger gap, and a real test-suite divergence between local and CI.

Decision per Adam: keep the repo private for now, **disable** the three GHAS-requiring workflows until repo goes public; fix the rest.

## Root-cause matrix (latest runs on commit `8ab050a`)

| Workflow | Status | Root cause | Category |
|---|---|---|---|
| `osv-scanner` | fail | Scan returns "No issues found" (exit 0), then `upload-sarif` errors: *"Code scanning is not enabled for this repository."* | GHAS — disable |
| `codeql` | fail | CodeQL analysis completes (79 TS files scanned), then upload errors: *"Code scanning is not enabled."* | GHAS — disable |
| `dependency-review` | fail | Action errors immediately: *"Dependency review is not supported on this repository. Please ensure that Dependency graph is enabled along with GitHub Advanced Security."* | GHAS — disable |
| `gitleaks` (PR event) | fail | *"GITHUB_TOKEN is now required to scan pull requests."* — workflow doesn't pass the token | Workflow bug |
| `gitleaks` (push event) | pass | No token required for push events — that's why it succeeds on the `dev` push and fails on PRs | (same workflow, dual behavior) |
| `ci` | fail | 16 tests fail in CI; only 3 fail locally — divergence to investigate | Real test failures |
| `ci` on `dev` pushes | n/a | `ci.yml` only triggers on `push: branches: [main]` + `pull_request`, so direct `dev` pushes get no CI signal | CI trigger gap |

## Recommended changes

### 1. Disable GHAS-requiring workflows (3 files)

Delete or rename to keep them in git for later re-enablement:

- `/Users/adam.congdon/code/privacy-screen/.github/workflows/codeql.yml`
- `/Users/adam.congdon/code/privacy-screen/.github/workflows/osv-scanner.yml`
- `/Users/adam.congdon/code/privacy-screen/.github/workflows/dependency-review.yml`

**Recommendation:** rename to `.yml.disabled` rather than delete. GitHub only loads `*.yml`/`*.yaml`, so renaming silences them without losing the config. Add a one-line README note explaining "re-enable when repo goes public."

### 2. Fix `gitleaks.yml` — add `GITHUB_TOKEN`

`/Users/adam.congdon/code/privacy-screen/.github/workflows/gitleaks.yml` line 22-27 — add `GITHUB_TOKEN` to the env block:

```yaml
      - name: Run gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_CONFIG: .gitleaks.toml
```

The automatic `secrets.GITHUB_TOKEN` is always available — no setup needed.

### 3. Fix `ci.yml` — run on `dev` pushes too

`/Users/adam.congdon/code/privacy-screen/.github/workflows/ci.yml` lines 3-6:

```yaml
on:
  push:
    branches: [main, dev]
  pull_request:
```

### 4. Diagnose + fix the 16 CI test failures

**Symptoms (from CI log `26904240561`):**
- One unnamed test fails with `5000.14ms — a beforeEach/afterEach hook timed out`
- Just after the timeout, the hook subprocess starts emitting: `[PrivacyScreen] PRIVACY_CONFIG.yaml parse error: YAMLParseError: Flow sequence in block collection ...`
- 14 of the 16 failures are hook-contract / hook-judge-handoff tests where `out.parsed` is `null` (hook didn't emit valid JSON) or `out.exitCode` doesn't match expected — consistent with the hook crashing on YAML parse before doing its work
- One additional failure: `POST /api/judge > 413 when Content-Length exceeds 256 KB` (separate logic issue)
- CI ran **331 tests** vs local **359 tests** — 28 fewer tests executed, suggesting a `beforeAll` failure aborted a describe block

**Investigation plan (during execute phase):**

1. **Pinpoint the 5s timeout.** The unnamed timeout is the first failure. It appears between `tests/llm-process.test.ts` (last passing) and the hook-contract failures. Likely candidates: `tests/judge-route.test.ts` or another test that spawns a subprocess in `beforeAll`/`beforeEach`. The 5s default Bun timeout suggests an awaited child-process startup that never resolves in CI (no GPU, slower I/O, or unavailable binary).

2. **Trace why the hook subprocess hits a YAML parse error in CI.** The tests in `tests/hook-contract.test.ts:48-54` spawn the hook with `env: { ...process.env, PRIVACY_SCREEN_CONFIG: configPath }`. The configPath points to a freshly-written tempdir YAML (valid). But the hook's `src/config.ts:153-163` resolution checks env first, then CWD, then project-root. The error suggests the hook is reading the *wrong* file — possibly the repo-root `PRIVACY_CONFIG.yaml`, or a config test fixture leaked into stdout.

   - Confirm whether the parse error originates from the test fixture in `tests/config.test.ts` (which deliberately tests malformed YAML) and is being captured into a *different* test's stderr because Bun's stderr capture is shared when tests run concurrently.
   - If the YAML error is just leaked stderr noise from `config.test.ts`, then the real root cause for the 14 hook tests is the `beforeEach` timeout poisoning the env. Look upstream in the test order.

3. **Compare the 28 missing tests.** Diff `bun test --reporter=junit` output local vs CI to see which describe block aborted.

4. **Fix `POST /api/judge > 413 when Content-Length exceeds 256 KB`.** Read `src/server.ts` `/api/judge` route + `tests/judge-route.test.ts:180`. The test expects status `413`; current behavior likely returns a different code when Content-Length is large.

**Files to read during execute:**
- `tests/judge-route.test.ts` (the unnamed timeout candidate; also the 413 test)
- `tests/hook-contract.test.ts` (already partially read — lines 48-120)
- `tests/hook-judge-handoff.test.ts` (2 fails)
- `tests/config.test.ts` (deliberate parse-error test that may be leaking stderr)
- `src/server.ts` (413 logic)
- `hooks/PrivacyScreen.hook.ts` (subprocess entry, to see how it reacts on config-load failure)

## Verification

After changes:

1. **Locally:**
   ```
   bun lint
   bun test
   ```
   Target: 0 fails, 0 unexpected skips.

2. **Push to dev** — verify:
   - `ci` workflow now runs and passes
   - `gitleaks` passes on both push and PR triggers
   - The three disabled workflows don't appear in the Actions tab (or are clearly marked disabled)

3. **Spot-check** that `gh run list --limit 5` shows green checks on `ci` and `gitleaks` for the latest commit.

## Out of scope (this plan)

- Making the repo public (separate decision)
- Re-enabling codeql/osv-scanner/dependency-review (do that when repo goes public)
- The 6 intentionally-skipped golden judge tests (those require the LLM to be installed)
