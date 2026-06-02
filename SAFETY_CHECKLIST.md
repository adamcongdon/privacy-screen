# PrivacyScreen — Pre-Enable Safety Checklist

> Walk this list **before** adding the hook block to `settings.json`. The hook
> is currently UNREGISTERED — Claude Code will not invoke it until that block
> is added. M1 code is shipped + tested, but enable-readiness needs the rollout
> protocol below.

## 1. Test gate (automated)

```bash
cd ~/code/privacy-screen
bun install
bun test
# Expect: 110 pass, 0 fail
bunx tsc --noEmit
# Expect: clean
```

Block on any failure.

## 2. Live spot-check (manual)

Pick a representative paragraph from a recent customer conversation, paste it
through the CLI:

```bash
bun cli/PrivacyScreen.ts scrub <<EOF
Hi team,

We're seeing problems at Contoso Bank — their server contoso-bak-01.contoso.local
at 10.55.66.77 is throwing GUID 7d4f8a12-2c31-4d92-9f48-12cdf6789012 errors.
The admin (CONTOSO\jsmith) has tried restarting. Email me back at
admin@contoso.com or call (555) 123-4567.

PRIVATE KEY: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx_y
EOF
```

Manually verify the scrubbed output:
- [ ] Customer name `Contoso Bank` → `{CUSTOMER}` (after first `vocab` mint) OR in review queue
- [ ] FQDN `contoso-bak-01.contoso.local` → `{HOST}`
- [ ] IP `10.55.66.77` → `{IP}`
- [ ] GUID `7d4f8a12-…` → `{GUID}`
- [ ] Domain user `CONTOSO\jsmith` → `{USER}`
- [ ] Email `admin@contoso.com` → `{EMAIL}`
- [ ] Phone `(555) 123-4567` → `{PHONE}`
- [ ] Credential `sk-ant-…` → `[CREDENTIAL-REDACTED]` + hasCredentials=true

If anything leaks through, file a regression test before continuing.

## 3. Populate customer names

Edit `PRIVACY_CONFIG.yaml`:

```yaml
mode: observe          # <— Start here. Switch to enforce after step 6.
customer_names:
  - "Acme Corp"
  - "Contoso Bank"
  - <every customer you actively work with>
fqdn_allowlist_extra:
  - .your-internal-domain.com
```

## 4. Register the hook in **observe mode**

In `~/.claude/settings.json` add (or merge):

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

With `mode: observe` in PRIVACY_CONFIG.yaml, **nothing blocks, nothing mutates** —
the hook only logs detections to stderr and writes counts to `redaction_log`.
Claude Code will surface stderr lines in its tool-output display.

## 5. Soak in observe mode for ≥48 hours of typical PAI work

Daily checks:

```bash
bun cli/PrivacyScreen.ts stats              # how many tokens per day, blocked count
bun cli/PrivacyScreen.ts vocab list         # what's been minted
bun cli/PrivacyScreen.ts review             # triage corp-entity heuristic hits
```

Watch for:
- [ ] **False positives** — names/phrases that shouldn't have been flagged.
      Allowlist via `allowlist add` or remove from `customer_names`.
- [ ] **Missed PII** — anything you saw in your prompts that wasn't flagged.
      File a pattern issue; add a test case to `tests/patterns.test.ts`.
- [ ] **Latency** — every hook event prints a warning if scrub took >1500ms.
      None should appear during normal use.
- [ ] **Stderr noise** — observe mode prints `[PrivacyScreen:observe] …` for
      every event. Mute by raising the threshold or run in `disabled` between
      verification sessions.

## 6. Flip to enforce

When step 5 has run clean for ≥48h:

```yaml
# PRIVACY_CONFIG.yaml
mode: enforce
```

No settings.json change needed. The next hook invocation reads the new mode.

## 7. Post-enable monitoring

- `bun cli/PrivacyScreen.ts stats 30` — last 30 days of redaction activity.
- Look for spikes in `blocked` — a sudden jump suggests either an attack on a
  newly-shared customer file or a pattern false-positive flood.

## Emergency disable

```yaml
# PRIVACY_CONFIG.yaml
mode: disabled
```

The hook becomes a no-op until you re-enable. No settings.json edit required.

## Known limits (read before enabling)

1. **`PostToolUse` cannot rewrite tool output.** If you Read a file with raw
   customer data, the model SEES it in its context window — PrivacyScreen
   only warns. Mitigation: don't `Read` raw customer files; instead, run
   commands that emit summaries (`grep`, `awk`) where PreToolUse can scrub
   the command first.
2. **Reversal is local-only.** Claude responds in tokens (`{CUSTOMER} should
   restart {SERVER}`). The display-reversal CLI (Layer D, planned M3) is not
   yet built. For now, `bun cli/PrivacyScreen.ts vocab list` shows the map.
3. **Regex coverage is finite.** International phone, non-Latin names,
   regional address formats, novel credential formats — all missed. The
   review-queue heuristic catches some name patterns; the rest depends on
   you adding to `customer_names`.
4. **Edit/MultiEdit/Grep `pattern`/`old_string` fields are NOT scrubbed.**
   This is intentional — scrubbing them would make Edit fail to match the
   file. Implication: Claude can see real PII in those specific tool inputs
   because they came from earlier (un-scrubbed) Reads. This is the leak
   surface PostToolUse can't close.

## LLM secondary validation (opt-in, default off)

A small local LLM can act as a **JUDGE** that reads the already-scrubbed text
and flags PII the regex+vocab layer might have missed (multilingual names,
regional formats, novel patterns). The judge **never** mutates the hot-path
output — it only adds spans to the existing `review_queue` for operator
triage. Regex+vocab remains the safety-critical synchronous gate. See
`Plans/LLM_RESEARCH.md` for the design and `Plans/no-let-s-use-development-glittery-ladybug.md`
for the implementation map.

**Privacy posture (read before enabling):**

- The scrubbed text **does** flow into the LLM subprocess. The LLM must run
  fully local — the hook refuses to POST to any endpoint that is not
  `127.0.0.1` / `localhost`.
- The hook talks to the long-lived privacy-screen server at
  `http://127.0.0.1:31338/api/judge` via a fire-and-forget POST capped at
  150 ms. If the server is not running, the hook silently no-ops — the LLM
  judge requires `bun run start` in a separate terminal.
- The LLM subprocess (`llama-server`) binds to a random high port on
  `127.0.0.1` only. No external connection is ever opened during inference.
- Findings carry the model's `reason` text into the review queue. Treat the
  reason field as untrusted output and render it as plain text.

**Pre-enable checklist:**

```bash
# 1. Install the model (one-time, requires network consent)
bun cli/PrivacyScreen.ts install-judge --model qwen2.5-1.5b --allow-network

# 2. Confirm the runtime is on PATH
which llama-server   # or follow the install-judge --runtime output

# 3. Flip the switch in PRIVACY_CONFIG.yaml
#    llm_validate:
#      enabled: true

# 4. Start the server (the hook talks to it)
bun run start

# 5. Run a sanity prompt and watch the review queue grow
curl -s http://127.0.0.1:31338/api/review | jq '.items | length'
```

**Disable:** flip `llm_validate.enabled: false` in `PRIVACY_CONFIG.yaml`. The
hook reads the flag every invocation; no restart needed.

**Telemetry:** the judge writes to the same `review_queue` table the regex
layer uses, with `source_event` prefixed `judge:`. `bun cli/PrivacyScreen.ts
review` shows pending items regardless of source.
