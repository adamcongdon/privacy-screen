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
| UNC path | `\\server\share` | `{PATH}` | Custom (example-specific) |
| Domain user | `DOMAIN\user` | `{USER}` | Custom (example-specific) |
| MAC address | `aa:bb:cc:dd:ee:ff` | `{MAC}` | Custom |
| GUID | `550e8400-…` | `{GUID}` | Custom |
| Customer names | from `PRIVACY_CONFIG.yaml` | `{CUSTOMER}` | Custom |
| Corp entity heuristic | `Acme Corp`, `Contoso Inc` | **REVIEW QUEUE** (0.6 confidence) | Custom |

**Honest limits** (per OpenAI's own framing): PrivacyScreen is one layer of defense, not a blanket anonymization guarantee. It uses regex, not ML — it will miss novel name formats, regional naming conventions, multilingual text, and any pattern not enumerated above. Treat it as a high-floor first line of defense, not a ceiling. Tune through `customer_names` + the review queue.

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
bun test                # Expect 110 passing
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

## Architecture

- **Layer A (UserPromptSubmit):** Detects PII → blocks with scrubbed suggestion. You copy + resubmit the clean version.
- **Layer B (PreToolUse):** Mutates tool input in-place via `hookSpecificOutput.updatedInput`. Bash/Write/WebFetch get scrubbed args. **Edit/MultiEdit/Grep/Glob pattern fields are preserved** (string-match would fail otherwise).
- **Layer C (PostToolUse):** Scans tool output. Credentials → block (exit 2). PII → stderr warning. Cannot rewrite the result (hook contract limit).
- **Layer D (display reversal):** Not yet built (M3). `cli/PrivacyScreen.ts scrub` can be used for spot-check reversal.

### Skipped fields by tool

Some tool inputs MUST round-trip unmodified or the tool fails. PrivacyScreen scans them for credentials (still blocks if a secret is in there) but does NOT scrub PII out of them:

| Tool | Skipped fields |
|---|---|
| Edit, NotebookEdit | `old_string`, `new_string` |
| MultiEdit | `edits` |
| Grep, Glob | `pattern` |

Add your own via `skip_scrub_fields:` in `PRIVACY_CONFIG.yaml`.

## Verification

- **Unit + integration:** `bun test` — 110 tests across patterns, scrubber, vocab, config, hook contract.
- **Hook contract:** `tests/hook-contract.test.ts` spawns the real hook binary and pipes synthetic Claude Code event payloads through stdin, verifying decision/updatedInput/exit-code shapes.
- **Live spot-check:** `bun cli/PrivacyScreen.ts scrub <<< 'test text'`.

## What's gitignored

- `*.db` / `*.db-shm` / `*.db-wal` — your vocab database contains real customer names
- `PRIVACY_CONFIG.yaml` — your personal customer name list

Never commit either. The `.example` template is safe to share.
