# privacy-screen feedback relay

A tiny Cloudflare Worker that lets **any** privacy-screen user submit feedback
that posts to GitHub Issues — no GitHub account, no `gh` CLI on their machine.

The desktop app scrubs the report locally, then `POST`s it here. This Worker
holds a GitHub fine-grained PAT (a Worker secret) and files the issue on
`adamcongdon/privacy-screen`. The credential never ships in the app.

```
privacy-screen app ──HTTPS POST /feedback (HMAC-signed)──▶ this Worker ──▶ GitHub Issues API
```

## Request contract

```
POST /feedback
Content-Type: application/json
X-PS-Sig: <lowercase hex HMAC-SHA256 of the exact raw body, key = APP_HMAC_KEY>
{ "title": string, "body": string, "type": "bug" | "enhancement" | "question" }
```

- Success → `200 { "ok": true, "issueNumber": <n>, "issueUrl": "<url>" }`
- Failure → non-2xx `{ "ok": false, "error": "<generic message>" }`

Every issue is labeled `feedback`, `feedback/unverified`, and the type. The
`feedback/unverified` label is the triage backstop — treat those issues as
untrusted until a human reviews them.

## Abuse protection (moderate)

- **HMAC app-key gate** (`X-PS-Sig`) — blocks casual scripting. This is
  obfuscation, not a true secret (the key is embedded in the distributed app).
- **Per-IP rate limit** (KV fixed window) — default 10 requests / hour. Tune via
  the `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` vars in `wrangler.toml`.
- **32 KB body cap**.

To harden further later: add a Cloudflare Turnstile challenge or swap the PAT for
a GitHub App installation token — neither requires changing the app↔relay
contract.

## Deploy runbook

All commands use `bunx` (not npx).

1. **Create the GitHub token.** A *fine-grained* PAT scoped to **only**
   `adamcongdon/privacy-screen`, with **Issues: Read and write**. Copy it.

2. **Create the KV namespace** and paste the returned id into `wrangler.toml`
   (`[[kv_namespaces]] id = "..."`):
   ```sh
   cd relay
   bunx wrangler kv namespace create RATE_LIMIT
   ```

3. **Set the secrets:**
   ```sh
   bunx wrangler secret put GH_TOKEN        # paste the fine-grained PAT
   bunx wrangler secret put APP_HMAC_KEY     # see the next step
   ```

4. **APP_HMAC_KEY must match the app.** The value you set above MUST equal the
   key the app signs with — the default constant in
   `server/lib/feedback-relay.ts` (`FEEDBACK_APP_KEY_DEFAULT`), or whatever you
   override it to via the app's `PRIVACY_SCREEN_FEEDBACK_APP_KEY` env var. If
   they differ, every request returns `401 unauthorized`.

5. **Deploy:**
   ```sh
   bunx wrangler deploy
   ```
   Note the `*.workers.dev` URL it prints, and set it as the app's relay URL:
   update `FEEDBACK_RELAY_DEFAULT_URL` in `src/config.ts` (and rebuild), or set
   `PRIVACY_SCREEN_FEEDBACK_RELAY_URL` at runtime.

6. **Maintenance:** the PAT does not auto-rotate. Note its expiry and re-run
   `bunx wrangler secret put GH_TOKEN` before it lapses.

## Test + smoke

```sh
cd relay
bun install
bun test
```

Local smoke test against a deployed relay (computes the HMAC with the same key):

```sh
RELAY_URL="https://privacy-screen-feedback.<acct>.workers.dev"
KEY="<your real APP_HMAC_KEY>"   # must match the deployed secret; the relay
                                 # refuses the placeholder default with 503
BODY='{"title":"smoke test","body":"hello from curl","type":"bug"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | sed 's/^.*= //')
curl -sS -X POST "$RELAY_URL/feedback" \
  -H "Content-Type: application/json" \
  -H "X-PS-Sig: $SIG" \
  -d "$BODY"
```
