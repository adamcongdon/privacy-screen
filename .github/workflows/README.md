# Workflows

## Active

- `ci.yml` — lint + test on push to ac-build / beta / main and all PRs. Also contains two required status checks for the `main` branch:
  - `enforce-beta-to-main` — fails any PR targeting `main` whose source branch is not `beta`.
  - `require-owner-approval` — fails PRs to `main` until the repository owner (`@adamcongdon`) has provided an approving review. Complements branch protection + CODEOWNERS.
- `release.yml` — **beta builds on every push to `beta`**; **full stable releases on every push to `main`** (only from `beta`).
  - Runs the normal test/lint first (in a separate `test` job).
  - `build` job: compiles web bundle + the three platform binaries (cross-compile on ubuntu), optionally signs the Windows exe (see code signing below), runs optional VirusTotal scan, uploads `build-binaries` artifact.
  - `sign-macos` job (only when `RUN_CODE_SIGNING=true`): downloads darwin binaries, imports Apple Developer ID cert into a transient keychain, `codesign --options runtime --timestamp`, submits to Apple notary via `notarytool` (App Store Connect API key), staples, uploads `final-darwin-binaries`.
  - `create-release` job: downloads base build binaries + (when signing) the final darwin overlays, (re)generates the release manifest via `bun scripts/build-release.ts --manifest-only` (so hashes are of the final signed bytes), creates the GitHub Release (prerelease for beta) with the three binaries + named manifest, then commits the manifest to the branch root (`release-manifest*.json`) with `[skip ci]`.
  - For `beta`: version is mutated to `<base>-beta.<run_number>` (ephemeral) so the baked manifest + release title reflect the beta qualifier.
  - Beta users point `update_manifest_url` at the `beta` branch's `release-manifest-beta.json` and set `update_channel: beta`.
  - The manifest's `sha256` values (consumed by the in-app updater) are *always* taken from the final artifacts that users will actually download.
- `gitleaks.yml` — secret-scanning on push + PR
- `semgrep.yml` — SAST/code security scanning (Semgrep p/ci + p/security + p/secrets rules) on push + PR. No GitHub Advanced Security required.
- Release workflow also performs VirusTotal scanning of the built platform binaries (when `VT_API_KEY` secret is configured).

## Branch protection expectations for `main`
- Require pull requests.
- Require at least 1 approving review.
- Require status checks: `test`, `enforce-beta-to-main`, `require-owner-approval` (and any others you enable).
- (Recommended) Require review from Code Owners (see `.github/CODEOWNERS`).
- Restrict direct pushes to `main` (only merges via PRs).

PRs from any branch other than `beta` to `main` are hard-blocked by CI. Only the owner can satisfy the approval gate.

Branch roles:
- `ac-build`: Your primary day-to-day development branch.
- `beta`: PR into `beta` (from ac-build) → auto beta build + manifest. This is the feeder for betas.
- `main`: PR from `beta` to `main` → stable release (protected).

## Disabled (`.yml.disabled`)

These require GitHub Advanced Security (or making the repo public) for full features like SARIF upload to code scanning and dependency graph:

- `codeql.yml.disabled` — GitHub CodeQL SAST
- `osv-scanner.yml.disabled` — Google OSV dependency vulnerability scanner (scheduled)
- `dependency-review.yml.disabled` — GitHub dependency review on PRs (blocks PRs introducing vulnerable deps)

They can be re-enabled by renaming the files once GHAS is available.

## Additional security tooling (no GHAS needed)
- Semgrep (active via `semgrep.yml`)
- gitleaks (active)
- VirusTotal binary scanning on releases (when secret configured)
- Consider enabling Dependabot (add `.github/dependabot.yml`) for automated dependency security updates.

## Code signing status (issue #14)

Code signing for releases was prototyped (Windows via osslsigncode + macOS Developer ID + notarization). It is currently **paused**.

- No `RUN_CODE_SIGNING` variable or signing secrets are configured.
- Releases are produced **unsigned** (current behavior).
- The implementation attempt lives in the immediately preceding git commit on this branch for future reference.

When work resumes:
- Windows signing can potentially use existing Azure key material (no Apple account needed for that part).
- macOS still requires a paid Apple Developer account ($99/yr) + Developer ID Application cert + notarization for good Gatekeeper behavior on web downloads.
- User will research distribution/signing options in a follow-up session.

For now the release workflow is intentionally simple and matches the pre-#14 state.
