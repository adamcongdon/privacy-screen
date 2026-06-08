# Workflows

## Active

- `ci.yml` — lint + test on push to ac-build / beta / main and all PRs. Also contains two required status checks for the `main` branch:
  - `enforce-beta-to-main` — fails any PR targeting `main` whose source branch is not `beta`.
  - `require-owner-approval` — fails PRs to `main` until the repository owner (`@adamcongdon`) has provided an approving review. Complements branch protection + CODEOWNERS.
- `release.yml` — **beta builds on every push to `beta`**; **full stable releases on every push to `main`** (only from `beta`).
  - Runs the normal test/lint first.
  - For `beta`: mutates version to `<base>-beta.<run_number>` (ephemeral for the build), produces a GitHub **prerelease**, uploads the three platform binaries + `release-manifest.json` (with `channel: "beta"`), then commits the manifest to repo root as `release-manifest-beta.json` on the `beta` branch (with `[skip ci]`).
  - For main: produces a regular GitHub release (not prerelease), uploads binaries + `release-manifest.json` (with `channel: "stable"`), then commits the manifest to `release-manifest.json` on `main`.
  - Beta users point `update_manifest_url` at the `beta` branch's `release-manifest-beta.json` and set `update_channel: beta`.
- `gitleaks.yml` — secret-scanning on push + PR

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

These three require GitHub Advanced Security or a public repo to upload SARIF results / scan dependency graph. Re-enable by renaming back to `.yml` once the repo is public or GHAS is enabled:

- `codeql.yml.disabled`
- `osv-scanner.yml.disabled`
- `dependency-review.yml.disabled`
