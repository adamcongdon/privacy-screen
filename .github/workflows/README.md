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
- Release workflow supports optional code signing (see "Code signing" section below).

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

## Code signing for releases (issue #14)

Releases can (and should) be code-signed so that end users get properly signed+notarized macOS binaries (Developer ID + hardened runtime + Apple notarization + staple) and Authenticode-signed Windows binaries. This matches the signing flow used in related exampleHub projects.

### Enabling
1. In the repo: Settings → Secrets and variables → Actions → Variables tab
   - Create variable `RUN_CODE_SIGNING` with value `true`
2. Add the following **secrets** (only required when the variable above is `true`):

   **Windows (osslsigncode path on the ubuntu build runner):**
   - `WINDOWS_CERT_P12` — base64 of your code-signing `.p12` (EV certificate recommended for SmartScreen)
   - `WINDOWS_CERT_PASSWORD` — passphrase for the p12

   **macOS (on a dedicated `macos-latest` runner):**
   - `APPLE_CERT_P12` — base64 of a "Developer ID Application" certificate export (.p12)
   - `APPLE_CERT_PASSWORD` — passphrase for the p12
   - `APPLE_API_KEY` — base64 of an App Store Connect API key file (AuthKey_*.p8)
   - `APPLE_API_KEY_ID` — e.g. `2X9R4HXF34`
   - `APPLE_API_ISSUER` — the Issuer UUID for that key (shown in App Store Connect)
   - `APPLE_SIGN_IDENTITY` (optional) — full identity string, e.g. `Developer ID Application: Your Name (TEAMID)`. Falls back to a generic "Developer ID Application" lookup.

3. (Optional but recommended) Also set `RUN_VIRUSTOTAL_SCAN=true` (and provide `VT_API_KEY`) so the *signed* Windows binary (and the pre-mac-sign darwins) are scanned.

When `RUN_CODE_SIGNING` is not `true` (or secrets are absent), the workflow still produces and releases *unsigned* binaries (the pre-#14 behavior). The `create-release` job gracefully handles the case where the macOS signing job is skipped.

### What changes in the artifacts
- The release manifest (`release-manifest*.json`) and the asset URLs it contains always describe the bytes users actually download.
- The in-app updater (`server/lib/update-install.ts`) verifies the manifest `sha256` against the downloaded file; signing therefore "just works" for users on the new flow.
- Beta and stable channels are unaffected except for the added signatures on the binaries.

### Local testing of the manifest step
```bash
# After a normal build (unsigned is fine for testing the script path)
bun scripts/build-release.ts --channel stable
# Later, to simulate the post-sign manifest regeneration used by create-release:
bun scripts/build-release.ts --manifest-only --channel stable
```
The `--manifest-only` flag (added for #14) skips the web build and compiles and simply (re)hashes whatever platform binaries are present in `dist/`, using the current `package.json` version (or a beta-qualified one you arrange) for the manifest.
