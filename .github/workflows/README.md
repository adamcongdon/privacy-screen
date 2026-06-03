# Workflows

## Active

- `ci.yml` — lint + test on push to main/dev and all PRs
- `gitleaks.yml` — secret-scanning on push + PR

## Disabled (`.yml.disabled`)

These three require GitHub Advanced Security or a public repo to upload SARIF results / scan dependency graph. Re-enable by renaming back to `.yml` once the repo is public or GHAS is enabled:

- `codeql.yml.disabled`
- `osv-scanner.yml.disabled`
- `dependency-review.yml.disabled`
