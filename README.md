# privacy-screen

PII anonymization hook for Claude Code. Intercepts every prompt and tool call — customer names, IPs, hostnames, emails, credentials — and replaces them with stable tokens (`{CUST_1}`, `{IP_2}`, `{HOST_3}`) before anything leaves the machine.

Tokens are stored locally in SQLite. The scrubber is fully reversible: `{CUST_1}` → `"Acme Corp"` in your local terminal. Anthropic's API only ever sees tokens.

## What it blocks

| Category | Example | Token |
|---|---|---|
| Credentials | `sk-ant-…`, `ghp_…`, `PRIVATE KEY` | **BLOCKED** (never tokenized) |
| IPv4 / IPv6 | `10.0.5.3` | `{IP_1}` |
| Email | `user@customer.local` | `{EMAIL_1}` |
| FQDN | `server.customer.com` | `{HOST_1}` |
| UNC path | `\\server\share` | `{PATH_1}` |
| Domain user | `DOMAIN\user` | `{DOMAIN_1\USER_1}` |
| MAC address | `aa:bb:cc:dd:ee:ff` | `{MAC_1}` |
| GUID | `550e8400-…` | `{GUID_1}` |
| Customer names | from `PRIVACY_CONFIG.yaml` | `{CUST_1}` |

## Setup

### 1. Install

```bash
cd ~/code/privacy-screen
bun install
```

### 2. Configure

```bash
cp privacy-config.example.yaml PRIVACY_CONFIG.yaml
# Edit PRIVACY_CONFIG.yaml — add customer names, adjust allowlist
```

### 3. Register the hook

Add to your Claude Code `settings.json` (or merge the block below):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/privacy-screen/hooks/PrivacyScreen.hook.ts",
            "timeout": 8
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/privacy-screen/hooks/PrivacyScreen.hook.ts",
            "timeout": 8
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/privacy-screen/hooks/PrivacyScreen.hook.ts",
            "timeout": 8,
            "async": true
          }
        ]
      }
    ]
  }
}
```

### 4. Run tests

```bash
bun test
# Expected: 39 tests passing
```

## CLI

```bash
bun cli/PrivacyScreen.ts stats              # daily redaction counts
bun cli/PrivacyScreen.ts vocab list         # all known tokens
bun cli/PrivacyScreen.ts vocab list -c ip   # filter by category
bun cli/PrivacyScreen.ts vocab forget <val> # remove an entry
bun cli/PrivacyScreen.ts allowlist add <pat>        # never tokenize this
bun cli/PrivacyScreen.ts allowlist add <pat> --regex
bun cli/PrivacyScreen.ts review             # triage review queue
echo "server at 10.0.0.1" | bun cli/PrivacyScreen.ts scrub
```

## Architecture

- **Layer A (UserPromptSubmit):** Detects PII → blocks with scrubbed suggestion. You copy + resubmit the clean version.
- **Layer B (PreToolUse):** Mutates tool input in-place via `hookSpecificOutput.updatedInput`. Bash/Write/Edit/WebFetch all get scrubbed args.
- **Layer C (PostToolUse):** Scans tool output. Credentials → block. PII → stderr warning.
- **Layer D (display reversal):** Planned (M3) — `pai-deanon` CLI rewrites tokens back to real names in your local transcript.

## What's gitignored

- `*.db` / `*.db-shm` / `*.db-wal` — your vocab database contains real customer names
- `PRIVACY_CONFIG.yaml` — your personal customer name list

Never commit either. The `.example` template is safe to share.
