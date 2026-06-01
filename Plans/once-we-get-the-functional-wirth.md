# Privacy-Screen as a Background PII Broker for Claude Desktop + Claude Code

> Feasibility sketch — not a build plan. The goal is to answer "yes/no, and roughly how" so we can decide whether to invest in this direction.

---

## Context

Privacy-screen today ships two visible surfaces that share one engine:

- **App** (`server/` + `web/` → `127.0.0.1:31338`) — paste-prompt-and-send UI that brokers chat through the local `claude --print` subprocess.
- **Hook** (`hooks/PrivacyScreen.hook.ts`) — Claude Code hook that scrubs `UserPromptSubmit` / `PreToolUse` / `PostToolUse` in-process. Built and tested; not yet registered in `settings.json`. Rollout protocol lives in `SAFETY_CHECKLIST.md`.

Both share the same SQLite vocab DB (`src/vocab.ts` via `defaultDbPath()`) and the same engine (`src/scrubber.ts`, `src/scrub-map.ts`, `src/patterns.ts`), so tokens are already consistent across them.

The strategic question: **once the privacy-screen App is "good enough," some users will still prefer the Claude desktop app (artifacts, projects, polished UX) and Claude Code (terminal flow). Can privacy-screen become a transparent background broker that protects PII for those two surfaces without making the user open the App at all?**

Short answer: **yes for Claude Code (essentially done), partially yes for Claude desktop (feasible but heavy UX cost).**

---

## TL;DR

| Surface | Path | Difficulty | Status |
|---|---|---|---|
| **Claude Code** (terminal) | Existing Hook — register in `~/.claude/settings.json` per `SAFETY_CHECKLIST.md` | Trivial | **Already built, awaiting registration** |
| **Claude desktop app** (Electron) | New `proxy` mode in the server: local TLS-terminating MITM proxy on a high port, per-app proxy routing for Claude.app, locally-trusted root CA installed in macOS keychain | Heavy (one-time setup) | **Not built — needs M2 work** |
| **Privacy-screen App** | Unchanged. Becomes optional — "control panel" UI for review queue + vocab management. Power users may still daily-drive it. | n/a | Shipping |

All three surfaces hit the **same SQLite vocab** → tokens stay consistent. A name redacted to `{CUSTOMER_3}` in Claude Code stays `{CUSTOMER_3}` in Claude desktop.

---

## Architecture — One Broker, Three Surfaces

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│   Claude Code (CLI)  │    │  Claude desktop.app  │    │   Browser → App UI   │
│      (terminal)      │    │     (Electron)       │    │  (127.0.0.1:31338)   │
└──────────┬───────────┘    └──────────┬───────────┘    └──────────┬───────────┘
           │ stdin/stdout              │ HTTPS to                  │ HTTP/SSE
           │ JSON events               │ api.claude.ai             │ /api/send
           ▼                           ▼                           ▼
   ┌───────────────┐         ┌──────────────────┐         ┌──────────────────┐
   │  Hook (in-    │         │  MITM proxy mode │         │  App server      │
   │  process,     │         │  (new) — TLS     │         │  (existing)      │
   │  no network)  │         │  termination on  │         │  /api/scrub      │
   │               │         │  local cert      │         │  /api/send       │
   └───────┬───────┘         └────────┬─────────┘         └────────┬─────────┘
           │                          │                            │
           └──────────────────────────┼────────────────────────────┘
                                      ▼
                     ┌────────────────────────────────┐
                     │   src/scrubber.ts (engine)     │
                     │   src/vocab.ts (SQLite, WAL)   │
                     │   src/scrub-map.ts (tokens)    │
                     │                                │
                     │   One vocab DB. One token      │
                     │   namespace. Three surfaces.   │
                     └────────────────────────────────┘
```

**Key design point:** the Hook keeps its current in-process model — no network dependency. SQLite WAL mode handles concurrent reads/writes from Hook + server. The "shared broker" is the **vocab + engine**, not a network endpoint that everything must dial.

---

## Path 1 — Claude Code (done)

The Hook IS the answer. The existing implementation in `hooks/PrivacyScreen.hook.ts`:

- `UserPromptSubmit` → block with scrubbed suggestion
- `PreToolUse` → mutate `tool_input` via `hookSpecificOutput.updatedInput`
- `PostToolUse` → scan-only (hook contract limit); credentials block, PII warns
- Fail-closed on any error
- 1500 ms soft budget, 8 s outer timeout

What's left: register in `~/.claude/settings.json` (recipe in `README.md:90-108`) after walking `SAFETY_CHECKLIST.md`. No new code required for this surface.

---

## Path 2 — Claude desktop (the interesting half)

Claude desktop is an Electron app that calls `api.claude.ai` over HTTPS. It is **not** trivially interceptable. Realistic options, ranked:

### Option A — Local MITM proxy with locally-trusted CA (recommended)

This is the same pattern as Proxyman, Charles, and mitmproxy.

- Add a `proxy` mode to the server (new file: `server/proxy.ts`). Listens on `127.0.0.1:31339`. Speaks HTTP CONNECT.
- Generate a per-install root CA on first run (`certs/ca.crt`, `certs/ca.key`). One-time install into macOS keychain: `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain ca.crt`.
- For each intercepted TLS connection to `api.claude.ai`, mint a per-host leaf cert signed by the CA on the fly. The Claude desktop app's TLS stack accepts it because the keychain trusts our CA.
- Route Claude desktop's traffic through the proxy. macOS options:
  - **Per-app**: use `pfctl` or `networksetup` to route only Claude.app's traffic. Cleanest.
  - **System-wide**: set `networksetup -setwebproxy / -setsecurewebproxy`. Heavy-handed but works.
  - **DNS hijack**: `/etc/hosts` → `api.claude.ai 127.0.0.1` + proxy listening on 443. Fragile, breaks other tools.
- Inside the proxy, on each upstream request to api.claude.ai's chat-completion endpoint:
  - Parse the JSON body, find the user message(s), pipe through `scrubText()`, mint tokens via the existing vocab.
  - On the SSE response stream, run incremental detokenize on each text delta before forwarding to the desktop app.

**What's reusable**: the entire engine. `scrubText()`, `VocabStore`, `ScrubMap` — no changes. The detokenize side already exists conceptually (the App's de-anonymization rendering); needs to be extracted into a pure function callable from the proxy.

**What's new**:
- `server/proxy.ts` — HTTP CONNECT handler + TLS termination + body rewriting
- `server/certs/` — CA generation + leaf cert minting (use `node-forge` or shell out to `openssl`)
- `cli/PrivacyScreen.ts proxy install-cert|uninstall-cert|start|stop` — UX for the one-time CA setup
- `src/detokenize.ts` — pure function: token-bearing string → real-value string, using vocab
- macOS launchd plist for autostart (optional, M3)

**UX cost**: user must (a) install a local root CA in their keychain, (b) trust that privacy-screen is benign software. Both are reasonable for a privacy tool but require clear, honest setup docs. This is essentially the same trust model as installing Proxyman or Little Snitch.

### Option B — Inject into Electron renderer

Modify the desktop app's `.asar` to inject a content script that monkey-patches `fetch` and `EventSource`. Same techniques as the browser-extension approach for claude.ai.

**Rejected.** Breaks code signing → blocks auto-updates → permanent maintenance burden → questionable under Anthropic's ToS. Don't go here.

### Option C — Wait for an official desktop plugin / MCP-for-prompts API

Out of our control. Worth a feature request to Anthropic, not a strategy.

### Option D — "Just use the App for sensitive sessions"

The user explicitly wanted to avoid this. Listed for completeness only.

---

## What's reusable (very little new code, structurally)

| Component | Source | Used by | Change needed |
|---|---|---|---|
| Pattern factories | `src/patterns.ts` | All surfaces | None |
| `scrubText`, `scrubToolInput` | `src/scrubber.ts` | All surfaces | None |
| `ScrubMap` + `VocabStore` | `src/scrub-map.ts`, `src/vocab.ts` | All surfaces | None — SQLite WAL handles concurrency |
| Detokenize (currently inline in App) | `web/src/store.ts` `tokenUnion` logic | New: proxy stream rewriter | **Extract to `src/detokenize.ts` as pure function** |
| Config loader | `src/config.ts` | All surfaces | Add `proxy:` section |
| Hook binary | `hooks/PrivacyScreen.hook.ts` | Claude Code | None |
| App server | `server/server.ts` | App | Mount `/proxy/*` admin routes |
| Proxy mode | **new** `server/proxy.ts` | Claude desktop | **New file** |
| Cert tooling | **new** `server/certs/` + CLI verb | Claude desktop install flow | **New** |

**The engine doesn't change.** Only the IO surfaces around it do.

---

## Trade-offs to weigh before committing

1. **Trust model escalation.** Today, privacy-screen is a passive tool — user copies/pastes or runs a hook. Adding a MITM proxy with a trusted root CA elevates it to "if compromised, can intercept arbitrary TLS." That's a stronger blast radius. Mitigation: per-install CA (not a global trusted root), proxy binds to loopback only, no remote access, code signed.
2. **Anthropic ToS / desktop app updates.** Proxy mode depends on the wire format of `api.claude.ai` chat completions. When Anthropic ships an update, the body schema could change. Mitigation: schema version detection + observe-mode fallback (passes traffic through unmodified if it can't parse, logs the new shape).
3. **Fail-mode philosophy.** Hook is fail-closed (block on error). What should the proxy do on parse failure or scrubber crash? Two honest options: (a) fail-closed — block the request, user sees an error in Claude desktop, knows something's wrong; (b) fail-open — pass through unmodified with loud stderr warning, accept that PII may leak. Both have legitimate use cases; should be a config toggle, default to fail-closed for parity with Hook.
4. **Token consistency across surfaces is now load-bearing.** Today vocab is shared but the consequences of inconsistency are mild (a token shown two ways in two tools). Once the proxy is rewriting live API traffic, vocab corruption is the difference between "PII protected" and "PII leaked." Need vocab integrity checks + backup tooling.
5. **Discoverability.** A transparent background broker is good for privacy but bad for confidence. Users want to *see* that scrubbing happened. Add a tray icon / menubar app that shows live redaction count and links to the review queue. This is what makes the broker model usable without forcing the App UI.

---

## Recommended sequence (rough — not a commitment)

1. **Now** — Register the Hook (existing work). This shipping immediately gives transparent protection to Claude Code with zero new code.
2. **M2** — Extract `src/detokenize.ts` as a pure function. Add CORS-restricted `/api/detokenize` endpoint. Refactor App to use it. Cheap, useful regardless of proxy direction.
3. **M3 — spike** — Throwaway prototype: bind a local TCP proxy, intercept ONE Claude desktop API call, log the wire format. Decide if Option A is worth committing to before building any cert tooling.
4. **M4** — If spike validates: build `server/proxy.ts` + cert tooling + CLI verbs. Ship in observe-mode first per `SAFETY_CHECKLIST.md` pattern.
5. **M5** — Menubar app (tiny SwiftUI or Electron tray) showing live status. This is what completes "background broker that doesn't need the App UI."

---

## Files of interest

- Engine (unchanged): `src/patterns.ts`, `src/scrubber.ts`, `src/scrub-map.ts`, `src/vocab.ts`, `src/config.ts`
- Hook (shipped, unregistered): `hooks/PrivacyScreen.hook.ts` + `tests/hook-contract.test.ts`
- Existing server: `server/server.ts`, `server/routes/send.ts`, `server/providers/claude-code.ts`
- Existing detokenize logic to extract: `web/src/store.ts` (look for `tokenUnion` + render-side reversal)
- Rollout doctrine: `SAFETY_CHECKLIST.md`, `SAFETY_CHECKLIST_APP.md`

---

## Verification approach

Whatever path we take, three gates:

1. **Hook gate (already exists):** `bun test` — 110 tests; `hook-contract.test.ts` spawns real binary with synthetic event payloads. Extend with proxy-stream test fixtures when the proxy lands.
2. **Live spot-check:** `bun cli/PrivacyScreen.ts scrub <<< 'real-looking text'` for any surface change.
3. **Wire-format soak (new for proxy):** record a week of observe-mode proxy logs against real Claude desktop usage. Confirm zero schema parse failures + zero false-positive blocks before flipping to enforce.

End-to-end manual test once the proxy ships:
- Install local CA, start proxy, route Claude desktop's traffic through it
- Open Claude desktop, send a message containing a known PII pattern (test customer name)
- Confirm via proxy logs that the outbound body contained `{CUSTOMER_N}`, not the real name
- Confirm the desktop UI renders the response with the real name de-tokenized (or, configurably, leaves the token visible — user preference)

---

## Out of scope / explicitly considered and rejected

- **MCP-as-scrubber** — Claude Code MCP servers can't intercept the user's outgoing prompt; wrong trust direction.
- **Electron `.asar` injection** — see Option B above.
- **System-wide Network Extension** — kernel-level intercept, requires Apple Developer ID + entitlements; overkill.
- **Forking Claude desktop** — out of scope; we want users to keep their normal Anthropic app.
- **Replacing the Hook with HTTP calls to the server** — needlessly couples Claude Code reliability to the server being up. Keep the Hook in-process.
