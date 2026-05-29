# PrivacyScreen App — Pre-Use Safety Checklist (M1-app)

> Walk this before sending real customer data through the app. The hook
> world had its own checklist (`SAFETY_CHECKLIST.md`); this is the analogue
> for the standalone app.

## 1. Test gate

```bash
cd ~/code/privacy-screen
bun install
bun test
# Expect: 129+ pass, 0 fail
bunx tsc --noEmit
# Expect: clean
```

Block on any failure.

## 2. Boot + binding check

```bash
bun run server &
sleep 2
# Confirm health
curl -s http://127.0.0.1:31338/api/health
#   {"ok":true,"version":"1.0.0-app-m1"}

# CRITICAL — confirm server is NOT reachable from the network
curl -s --max-time 2 http://<your-LAN-IP>:31338/api/health || echo "good: not reachable"
#   good: not reachable
```

If the LAN IP curl succeeds, abort and inspect `PRIVACY_SCREEN_BIND_ANY` — the
server must bind 127.0.0.1 only.

## 3. Live scrub spot-check via API

```bash
curl -s -X POST http://127.0.0.1:31338/api/scrub \
  -H "Content-Type: application/json" \
  -d '{"text":"Customer Acme Corp at 10.99.88.77 emailed admin@acme.com","persist":false}' \
  | jq
```

Manually verify:
- [ ] `scrubbed` contains `{IP_N}` (no real IP)
- [ ] `scrubbed` contains `{EMAIL_N}` (no real email)
- [ ] `tokens[]` includes the IP and email entries
- [ ] `unsureSpans[]` includes "Acme Corp" (heuristic match)
- [ ] `hasCredentials` is false

## 4. Verify Claude Code auth (no API key needed)

Inference goes through your local `claude` CLI. The app inherits its OAuth
session — there's no API key surface area anywhere in privacy-screen.

```bash
claude --version              # must be 2.x and on PATH
claude login                  # run if "Not logged in" — one-time browser OAuth
```

Verify settings:
```bash
curl -s http://127.0.0.1:31338/api/settings | jq
#   { "model": "sonnet", "system_prompt": "...",
#     "claude_code": { "found": true, "version": "2.1.145 (Claude Code)" } }
```

If `claude_code.found` is false, the server already refused to start. The
JSON should never contain secret-shaped strings:
```bash
curl -s http://127.0.0.1:31338/api/settings | grep -E "sk-ant-|ghp_|AKIA" && echo "LEAK" || echo "clean"
```

## 5. Send-path verification (the live wire test)

In a browser, open `http://127.0.0.1:31338` (after `bun run start` which
builds web/dist + launches server).

1. Type: `Customer Acme Corp at 10.99.88.77 is having issues. What should we check?`
2. In a separate terminal, watch what the spawned `claude` subprocess sees:
   ```bash
   # Each /api/send invocation spawns a `claude --print` subprocess. Run this
   # in another terminal to monitor what process arguments / stdin the CLI
   # actually gets fed:
   sudo dtrace -n 'proc:::exec-success /execname == "claude"/ { trace(curpsinfo->pr_psargs); }'
   #   (or on Linux: sudo execsnoop-bpfcc -n claude)
   ```
3. Click Send.
4. **Verify what claude sees**: the prompt fed in via stdin must contain ONLY
   tokens — `{CUSTOMER}`, `{IP_N}` — and no real "Acme Corp" / "10.99.88.77".
5. Verify the response in the UI shows real values (deanonymized in renderer).
6. Toggle "show tokens" — confirm response also viewable in tokenized form.

If any real string reaches the `claude` subprocess, **stop and file a regression test**.

## 6. File upload verification

1. Create a test file: `echo "Customer Acme has server at 10.5.5.5" > /tmp/test-notes.txt`
2. Drag-drop the file into the composer
3. Confirm the file chip shows ✓
4. Click Send
5. DevTools → confirm the file content was scrubbed before sending

## 7. Credential refusal

```bash
curl -s -X POST http://127.0.0.1:31338/api/send \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"my key is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12"}]}'
#   {"error":"credential detected", ...}
```

Server must refuse to relay; no `claude` subprocess should be spawned. Verify
with: `ps -ef | grep claude` immediately after the request — no child process
should appear for the rejected send.

## 8. Daily monitoring (post-enable)

```bash
bun cli/PrivacyScreen.ts stats          # daily redaction counts
bun cli/PrivacyScreen.ts vocab list     # current token map
bun cli/PrivacyScreen.ts review         # heuristic items awaiting triage
```

## Emergency disable

There is no kill switch — close the browser tab and stop the server (`Ctrl-C`
or `kill` the `bun run server` process). The next launch reads from a fresh
state; vocab persists but no automatic relay happens until you re-open the UI.

## Known limits (M1-app)

1. **Inference via `claude` CLI only** — requires Claude Code installed and
   logged in. No API key fallback (intentional — keeps the "no key" promise).
2. **Text-like files only** (`.txt .md .log .json .csv .yaml ...`). PDF/DOCX in M2.
3. **No conversation persistence across sessions** — refreshing the tab clears
   the visible history (vocab stays). Sessions list in M2.
4. **No system hotkey / clipboard mode** — copy-paste workflow only. M2.
5. **One profile** — single vocab DB, single customer_names list. M2 adds profiles.
6. **No image / OCR / voice** — text only.
7. **Single-user, single-machine**. No multi-device sync.
8. **PAI startup hooks fire on each spawned `claude`** — when your `~/.claude/`
   has SessionStart hooks, they run every `/api/send`. Adds latency. Acceptable
   for now; can switch to `--bare` if Anthropic ships OAuth support for it.
