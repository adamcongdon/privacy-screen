# privacy-screen

Local-first PII anonymization layer for AI providers. Two modes of use, same engine underneath:

| Mode | Audience | Status |
|---|---|---|
| **App** — three-pane web UI on `localhost:31338` for paste-prompt-and-send workflow against the Anthropic API | Anyone who wants a privacy gate between their prompts and the cloud | **M1-app in progress** |
| **Hook** — Claude Code hook that intercepts every prompt and tool call inside Claude Code sessions | Claude Code power users | M1-hook shipped, not yet registered |

In both modes, customer names, IPs, phone numbers, addresses, credit cards, emails, hostnames, and credentials are replaced with stable tokens (`{CUSTOMER}`, `{IP_2}`, `{PHONE}`) before anything leaves the machine. Tokens are stored locally in SQLite. The cloud only ever sees tokens.

## Quick start — App

```bash
# One-time: make sure Claude Code is installed and logged in
claude --version    # 2.x required
claude login        # OAuth — used by the app for inference

bun install
bun run start       # builds web/dist + boots server on 127.0.0.1:31338
open http://127.0.0.1:31338
```

**No API key needed** — inference runs through your local `claude` CLI, using the same OAuth session you already have. The server refuses to start if `claude` isn't on PATH. Walk `SAFETY_CHECKLIST_APP.md` before sending real data.

## Quick start — Hook

`SAFETY_CHECKLIST.md` (the older one) covers the Claude Code hook flow. Hook is NOT yet registered in your `settings.json` — opt in only after the checklist passes.

## What it covers

PrivacyScreen ships with deterministic regex coverage for the 8-category taxonomy used by [OpenAI's Privacy Filter](https://openai.com/index/introducing-openai-privacy-filter/) plus infrastructure-specific categories Adam works with daily:

| Category | Example | Token | Source |
|---|---|---|---|
| Credentials (BLOCK) | `sk-ant-…`, `ghp_…`, JWT, `AKIA…`, Bearer, Azure `AccountKey=…`, PRIVATE KEY | **BLOCKED** | Custom + OpenAI `secret` |
| Sensitive KV (REDACT) | `password=…`, `api_key=…`, `secret=…` | `[REDACTED]` | Custom |
| Account number | `4111-1111-1111-1111` (Visa/MC/Amex/Discover) | `{ACCOUNT}` | OpenAI `account_number` |
| Phone | `(555) 123-4567`, `+44 20 7946 0958` | `{PHONE}` | OpenAI `private_phone` |
| Street address | `123 Main Street` (US suffix set) | `{ADDR}` | OpenAI `private_address` |
| Email | `user@customer.local` | `{EMAIL}` | OpenAI `private_email` |
| URL with path | `https://internal.acme.com/secret/123` | `{URL}` | OpenAI `private_url` |
| IPv4 / IPv6 | `10.0.5.3` | `{IP}` | Custom |
| FQDN | `server.customer.com` | `{HOST}` | Custom (allowlist for vendor infra) |
| UNC path | `\\server\share` | `{PATH}` | Custom (Veeam-specific) |
| Domain user | `DOMAIN\user` | `{USER}` | Custom (Veeam-specific) |
| MAC address | `aa:bb:cc:dd:ee:ff` | `{MAC}` | Custom |
| GUID | `550e8400-…` | `{GUID}` | Custom |
| Customer names | from `PRIVACY_CONFIG.yaml` | `{CUSTOMER}` | Custom |
| Corp entity heuristic | `Acme Corp`, `Contoso Inc` | **REVIEW QUEUE** (0.6 confidence) | Custom |

**Honest limits** (per OpenAI's own framing): PrivacyScreen is one layer of defense, not a blanket anonymization guarantee. It uses regex, not ML — it will miss novel name formats, regional naming conventions, multilingual text, and any pattern not enumerated above. Treat it as a high-floor first line of defense, not a ceiling. Tune through `customer_names` + the review queue.

**Optional LLM secondary validator (opt-in, default off).** A small local LLM (Qwen2.5-1.5B Q4_K_M via `llama-server`) can run as a JUDGE that reads the *already-scrubbed* text and flags PII the regex layer might have missed — multilingual names, regional address formats, novel credential patterns. The judge can only *add* items to the existing review queue; it never mutates scrub output. Runs fully local; the hook refuses any non-loopback endpoint. See `Plans/LLM_RESEARCH.md` for design, `SAFETY_CHECKLIST.md` ("LLM secondary validation") for the enable flow, and `bun cli/PrivacyScreen.ts install-judge --runtime` to start.

## Modes

| Mode | Behavior | When to use |
|---|---|---|
| `disabled` | No-op; hook returns immediately. | Emergency bypass without unregistering the hook. |
| `observe` | Detect + log to stderr/redaction_log; nothing blocks, nothing mutates. | **Recommended for initial rollout.** Measure false-positive rate against real PAI work. |
| `enforce` | Full block + mutation behavior. | After observe-mode soak confirms low FP rate. |

Set in `PRIVACY_CONFIG.yaml` (`mode: observe`) or per-run via env (`PRIVACY_SCREEN_MODE=observe`).

## Setup

### 1. Install

```bash
cd ~/code/privacy-screen
bun install
```

### 2. Configure

```bash
cp privacy-config.example.yaml PRIVACY_CONFIG.yaml
# Edit PRIVACY_CONFIG.yaml — add customer names, set mode: observe initially
```

### 3. Verify before registering

```bash
bun test                # Expect 339+ passing (regex layer + LLM judge unit tests)
bun cli/PrivacyScreen.ts scrub <<< 'Customer Acme Corp at 10.0.5.3 emailed me'
# Inspect the scrubbed output + token map; confirm it matches expectation.
```

Walk through `SAFETY_CHECKLIST.md` before adding to settings.json.

### 4. Register the hook (after safety checklist clears)

Add to your Claude Code `settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bun /Users/adam.congdon/code/privacy-screen/hooks/PrivacyScreen.hook.ts", "timeout": 8 }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "bun /Users/adam.congdon/code/privacy-screen/hooks/PrivacyScreen.hook.ts", "timeout": 8 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "bun /Users/adam.congdon/code/privacy-screen/hooks/PrivacyScreen.hook.ts", "timeout": 8 }] }
    ]
  }
}
```

## CLI

```bash
bun cli/PrivacyScreen.ts stats              # daily redaction counts
bun cli/PrivacyScreen.ts vocab list         # all known tokens
bun cli/PrivacyScreen.ts vocab list -c ip   # filter by category
bun cli/PrivacyScreen.ts vocab forget <val> # remove an entry
bun cli/PrivacyScreen.ts allowlist add <pat>          # never tokenize this
bun cli/PrivacyScreen.ts allowlist add <pat> --regex
bun cli/PrivacyScreen.ts review             # triage corp-entity review queue
echo "server at 10.0.0.1" | bun cli/PrivacyScreen.ts scrub
```

## Optional: LLM secondary validator

Adds a small local LLM as a second-line **JUDGE** that reads the *already-scrubbed* text and flags PII the regex layer missed — multilingual names, regional address formats, novel credential patterns. The judge cannot mutate scrub output; it only adds spans to the existing review queue for operator triage. Disabled by default. See `Plans/LLM_RESEARCH.md` for the design rationale and `SAFETY_CHECKLIST.md` → "LLM secondary validation (opt-in)" for the full safety review.

### Setup (GUI — recommended)

1. Install `llama-server`:
   ```bash
   brew install llama.cpp        # macOS
   # Linux / Windows: see https://github.com/ggml-org/llama.cpp
   ```
2. `bun run start` and open `http://127.0.0.1:31338`.
3. Click the **settings** button (top of the page).
4. In the **LLM judge** panel:
   - First time: click **Install qwen2.5-1.5b** to download the model (~1 GB, Apache 2.0, 29 languages). A progress bar shows live download status.
   - Once the runtime and model both show ✅, flip the **Enable judge** toggle.

No CLI, no YAML editing, no restart. The toggle takes effect on the next hook invocation.

### Setup (CLI — alternative)

```bash
# 1. Install runtime + model
brew install llama.cpp
bun cli/PrivacyScreen.ts install-judge --model qwen2.5-1.5b --allow-network

# 2. Either click "Enable judge" in the settings drawer, OR add to PRIVACY_CONFIG.yaml:
#      llm_validate:
#        enabled: true
#        model_path: /Users/<you>/.privacy-screen/models/qwen2.5-1.5b.gguf

# 3. Start the server (the judge runs inside it)
bun run start
```

For dry-run + custom destinations + SHA-256 verification, see `bun cli/PrivacyScreen.ts install-judge --help`.

### What you see at runtime

Nothing user-visible during the call itself. The judge is a quiet background auditor — Claude Code receives the scrubbed input on the regex layer's normal timeline, and the judge writes its findings to the existing review queue.

The server logs one line per call to stderr:
```
[privacy-screen] judge.completed: 2 spans
```

### Where flagged spans show up

In the web UI's **Review queue** panel on `http://127.0.0.1:31338` (the same panel that already shows corp-entity heuristics), with `source_event` prefixed `judge:`. Each flagged span gets the same triage flow as regex-layer detections:

- **Confirm** → mints a permanent token, future runs auto-scrub it
- **Allowlist** → never flag this string again
- **Ignore** → one-time pass

CLI alternative: `bun cli/PrivacyScreen.ts review`.

### Disable

Either flip the **Enable judge** toggle off in the settings drawer, OR set `llm_validate.enabled: false` in `PRIVACY_CONFIG.yaml`. No restart needed — the hook reads the flag on every invocation.

### Constraints

- Requires the `bun run start` server to be up. If it's down, the hook silently skips the judge call — privacy gating still works via the regex layer.
- The hook *only* fires the judge on `PreToolUse` events that actually scrubbed something. Short or unmodified inputs are skipped.
- On M1 MacBook Air with 8 GB RAM, expect ~3–6 s per judge call (well-tolerated because it's async-out-of-band). M2/M3 closer to 1–2 s.
- The model file is ~1 GB on disk and ~1.5 GB RSS when loaded.

## Architecture

- **Layer A (UserPromptSubmit):** Detects PII → blocks with scrubbed suggestion. You copy + resubmit the clean version.
- **Layer B (PreToolUse):** Mutates tool input in-place via `hookSpecificOutput.updatedInput`. Bash/Write/WebFetch get scrubbed args. **Edit/MultiEdit/Grep/Glob pattern fields are preserved** (string-match would fail otherwise).
- **Layer C (PostToolUse):** Scans tool output. Credentials → block (exit 2). PII → stderr warning. Cannot rewrite the result (hook contract limit).
- **Layer D (display reversal):** Not yet built (M3). `cli/PrivacyScreen.ts scrub` can be used for spot-check reversal.
- **Layer E (LLM judge — opt-in):** Out-of-band local LLM reads scrubbed text after Layer B fires and writes new candidate spans to the review queue. Never mutates hot-path output. See "Optional: LLM secondary validator" above.

### Skipped fields by tool

Some tool inputs MUST round-trip unmodified or the tool fails. PrivacyScreen scans them for credentials (still blocks if a secret is in there) but does NOT scrub PII out of them:

| Tool | Skipped fields |
|---|---|
| Edit, NotebookEdit | `old_string`, `new_string` |
| MultiEdit | `edits` |
| Grep, Glob | `pattern` |

Add your own via `skip_scrub_fields:` in `PRIVACY_CONFIG.yaml`.

## Verification

- **Unit + integration:** `bun test` — 339+ tests across patterns, scrubber, vocab, config, hook contract, LLM judge unit tests, install-judge CLI.
- **Hook contract:** `tests/hook-contract.test.ts` spawns the real hook binary and pipes synthetic Claude Code event payloads through stdin, verifying decision/updatedInput/exit-code shapes.
- **Hook → judge handoff:** `tests/hook-judge-handoff.test.ts` spawns the hook with a tiny Hono receiver listening on a loopback ephemeral port, verifies the POST body shape, and asserts stdout is byte-identical whether the receiver succeeds, hangs (150 ms abort), or refuses.
- **Live spot-check:** `bun cli/PrivacyScreen.ts scrub <<< 'test text'`.
- **LLM judge golden tests (opt-in, slow):** `LLM_TESTS=1 LLM_JUDGE_ENDPOINT=http://127.0.0.1:8080 bun test tests/judge-golden.test.ts` — exercises the real model end-to-end against a small set of multilingual / regional cases. Skipped silently when `LLM_TESTS` is unset.

## CI

Workflows live in [`.github/workflows/`](.github/workflows/) .

- [`ci.yml`](.github/workflows/ci.yml) — lint + test on push to ac-build / beta / main and all PRs. Also enforces two `main`-targeting rules as required status checks:
  - Only PRs **from `beta`** are allowed to target `main` (hard fail otherwise).
  - PRs to `main` require an approving review **from the repo owner** (`@adamcongdon`).
- [`release.yml`](.github/workflows/release.yml) — **beta builds** are auto-deployed when PRs land on the `beta` branch (as GitHub prereleases, with `channel: "beta"` in the manifest and `release-manifest-beta.json` committed to the `beta` branch). **Full stable releases** are generated on merges from `beta` to `main` (regular GitHub releases + `release-manifest.json` on `main`). Also runs VirusTotal scans on the built platform binaries (when `VT_API_KEY` secret is set).
- [`gitleaks.yml`](.github/workflows/gitleaks.yml) — git history secret scan via gitleaks, configured by [`.gitleaks.toml`](.gitleaks.toml). Catches accidentally committed credentials. Fake fixtures under `tests/` are allowlisted.
- [`semgrep.yml`](.github/workflows/semgrep.yml) — static application security testing (SAST) using Semgrep with `p/ci`, `p/security`, and `p/secrets` rule packs. Runs on push + PRs. No GitHub Advanced Security required.

See [`.github/workflows/README.md`](.github/workflows/README.md) for the full list of workflows, branch protection requirements on `main`, and notes on disabled scans (CodeQL, OSV, dependency-review) that need GHAS or a public repo.

All workflows use least-privilege `permissions:` blocks. The release workflow requires `contents: write` to create releases and push manifest updates.

## Updates

PrivacyScreen ships an **opt-in** update check. There is no auto-install, no telemetry, and the check is off by default. When enabled, the app makes one HTTPS GET per start against a static release manifest you control — that's the entire network footprint.

```yaml
# PRIVACY_CONFIG.yaml
update_channel: off               # off | stable | beta. Default off.
update_manifest_url: https://raw.githubusercontent.com/adamcongdon/privacy-screen/main/release-manifest.json
```

### Channels & manifests (auto-published by CI)

- `stable` (most users): points at `main/release-manifest.json`. Full releases are generated only when a PR from `beta` lands on `main`.
- `beta`: set `update_channel: beta` and point the manifest at the `beta` branch:
  ```yaml
  update_channel: beta
  update_manifest_url: https://raw.githubusercontent.com/adamcongdon/privacy-screen/beta/release-manifest-beta.json
  ```
  Every time a PR lands on the `beta` branch (typically merged from your primary `ac-build` branch), it triggers an automatic beta build (GitHub prerelease + updated beta manifest). Beta manifests use qualified versions like `1.2.3-beta.42` (based on workflow run number) so the update check can offer newer betas.

Branch flow:
- `ac-build` — your primary day-to-day branch.
- `beta` — PR into `beta` deploys beta.
- `main` — PR from `beta` to `main` deploys stable release (protected, only you approve).

See `privacy-config.example.yaml` for the commented examples and [`Plans/INSTALLER.md`](Plans/INSTALLER.md) for design rationale.

When `update_channel` is `stable` or `beta`, hit `GET /api/version` to see whether a newer release is available:

```json
{
  "version": "1.0.0",
  "channel": "stable",
  "updateAvailable": true,
  "latestKnown": "1.0.1",
  "updateInfo": {
    "version": "1.0.1",
    "channel": "stable",
    "url": "https://github.com/.../privacy-screen-darwin-arm64",
    "sha256": "0000…",
    "releasedAt": "2026-06-02T00:00:00Z"
  }
}
```

The check is *informational only* — downloading and installing the new binary is still a manual step. Beta users get the latest dev bits via the beta manifest after merges to `dev`.

## What's gitignored

- `*.db` / `*.db-shm` / `*.db-wal` — your vocab database contains real customer names
- `PRIVACY_CONFIG.yaml` — your personal customer name list

Never commit either. The `.example` template is safe to share.
