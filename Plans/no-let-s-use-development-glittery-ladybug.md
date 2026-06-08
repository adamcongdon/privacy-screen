# LLM Secondary-Validation Judge — Implementation Plan

> Executes the design in `Plans/LLM_RESEARCH.md`. Driven by the `/Development` pipeline (Architect → Engineer TDD → simplify → QATester → Pentester). No UI, so Designer and UIReviewer are skipped — the review-queue UI already exists.

## Context

`Plans/LLM_RESEARCH.md` proposes a small local LLM (Qwen2.5-1.5B Q4_K_M) as a **JUDGE** (read-only annotator) that runs after the regex+vocab scrubber, flags PII the rules missed (multilingual names, regional formats, novel patterns), and writes findings to the existing review queue. Privacy is preserved because the LLM only sees already-scrubbed text, runs fully local, and never mutates the hot-path output — it only enriches the operator's review queue for the next session.

**One critical correction to the research doc.** The doc's `queueMicrotask(...)` pseudocode does not work for privacy-screen: `hooks/PrivacyScreen.hook.ts` is a one-shot subprocess that exits as soon as `console.log` flushes. A microtask queued after `console.log` will not survive process exit on a hot-path subprocess. Solution: **hook fire-and-forget POSTs to the long-lived Hono server** at `127.0.0.1:31338`, which owns the LLM subprocess and writes to the review queue. Same privacy posture, correct runtime semantics.

**Server-dependency design decision.** The judge only runs when the Hono server is up. If the server is not running, the hook silently no-ops (zero new latency). Users opting into the judge accept "run `bun run start` once" as part of the opt-in. This avoids the much larger problem of the hook managing its own detached background daemon.

---

## Architecture Summary

```
Claude Code
   │
   ▼
[hook subprocess] ── scrubber.ts (regex + vocab) ── returns scrubbed text to Claude Code
   │                                                          (hot path complete)
   │  fire-and-forget POST (150 ms cap, loopback only)
   ▼
[Hono server, long-lived]
   │
   ├── routes/judge.ts  ─── runJudge() ─── LlmClient ──► llama-server (managed subprocess)
   │                              │
   │                              ▼
   └── vocab.addReviewItem()  ── SQLite review_queue (existing)
                                          │
                                          ▼
                                  Operator triages later
                                  (existing UI / CLI)
```

Three invariants:
1. **Regex remains the safety-critical synchronous gate.** Judge cannot mutate scrub output, only add review items.
2. **Hook hot path is unaffected when judge is disabled or server is down.** The POST is capped at 150 ms and wrapped in try/catch.
3. **Judge output flows through the existing review queue + vocab-induction loop.** Operator promotion to `customer_names`/`person_names` is unchanged.

---

## Phase 1 — Config plumbing (no behavior change)

- **Goal**: ship `llm_validate` config surface; default disabled; no module reads it yet.
- **Modify**: `src/config.ts` — extend `PrivacyConfig` with:
  ```ts
  llm_validate: {
    enabled: boolean;            // default false
    model_path: string | null;   // GGUF path
    runtime: 'llama-server';     // only option in v1
    endpoint: string | null;     // null → managed subprocess; otherwise external URL (must be 127.0.0.1)
    max_tokens: number;          // default 256
    timeout_ms: number;          // default 2500
    min_confidence: number;      // default 0.6
  }
  ```
- **Modify**: `privacy-config.example.yaml` — add commented `llm_validate:` block linking to `SAFETY_CHECKLIST.md`.
- **Modify**: `SAFETY_CHECKLIST.md` — append "LLM secondary validation (opt-in)" section.
- **Test**: `tests/config.test.ts` — defaults give `llm_validate.enabled === false`; YAML round-trip.
- **Pipeline**: Architect (schema), Engineer (TDD).

## Phase 2 — Cross-platform homedir fix (drive-by)

- **Goal**: replace the Unix-only `process.env.HOME ?? '/Users/adam.congdon'` fallback so Windows install-judge works later.
- **Modify**: `src/vocab.ts` — swap to `homedir()` from `os`, matching the pattern already used in `server/secrets.ts`.
- **Test**: extend `tests/vocab.test.ts` to assert resolution under `homedir()`.
- **Pipeline**: Engineer.

## Phase 3 — Judge module (pure logic, mockable)

- **Goal**: a deterministic, testable judge with all I/O behind an interface.
- **Create**: `src/judge/judge.ts` — `runJudge(scrubbed, tokenMap, opts): Promise<JudgeResult>`. Builds prompt, calls `client.complete()`, validates JSON against schema, filters spans that overlap existing tokens via `tokenMap.tokenFor()`, drops below `minConfidence`, normalizes categories.
- **Create**: `src/judge/normalize.ts` — `LLM_TO_REVIEW_CATEGORY` map:
  - `person → person`
  - `org → customer`
  - `address → address`
  - `credential → credential`
  - `hostname → fqdn`
  - `other → unsure`
- **Create**: `src/judge/llm-client.ts` — `LlmClient` interface; `MockLlmClient` (scripted) and `LlamaServerClient` (fetch + `AbortSignal.timeout`).
- **Create**: `src/judge/prompt.ts` — pinned system + user prompt with `PROMPT_VERSION = '1'`.
- **Reused**: `src/scrub-map.ts` `ScrubMap.tokenFor()` for overlap filtering; `bun test`.
- **Test**: `tests/judge.test.ts` — multilingual happy path, JSON parse failure → `[]`, timeout → `[]`, overlap with `{EMAIL}` token → filtered, low confidence → dropped, unknown category → `unsure`.
- **Pipeline**: Architect (interface), Engineer (TDD).

## Phase 4 — Subprocess lifecycle (`server/lib/llm-process.ts`)

- **Goal**: one managed `llama-server` per Hono process, lazy-start, health-check, idle shutdown.
- **Create**: `server/lib/llm-process.ts` — module-level FSM `'idle' | 'starting' | 'ready' | 'failed'`. `getLlmClient(cfg): Promise<LlmClient | null>` returns the singleton client. Lazy `Bun.spawn` on first call. Health poll `GET http://127.0.0.1:<random-high-port>/health` until `{status:'ok'}` or 30 s. On failure → `state='failed'` permanently for this process; log once; return `null` for the session. Idle timer (10 min) sends SIGTERM and resets to `'idle'`.
- **Modify**: `server/server.ts` — register `process.on('SIGTERM'|'SIGINT')` to call `llmProcess.shutdown()`.
- **Reused**: `Bun.spawn`; `fetch` (already used in `server/lib/update-check.ts`).
- **Test**: `tests/llm-process.test.ts` — fake spawn via DI seam; covers start, health, idle shutdown, crash + permanent disable.
- **Pipeline**: Architect (FSM), Engineer (TDD), **Pentester** (spawn args, bind address must be 127.0.0.1, random port to avoid collisions).

## Phase 5 — `/api/judge` route + review-queue write

- **Goal**: server endpoint the hook fires into.
- **Create**: `server/routes/judge.ts` — `POST /api/judge` body `{ scrubbed: string, tokenMap: SerializedScrubMap, sourceEvent: string }`. Returns `202 Accepted` immediately. Schedules work via `queueMicrotask` *inside the server* (safe — Hono is long-lived). Handler: get `LlmClient`, run `runJudge`, write each surviving span via `vocab.addReviewItem({ span, surrounding, suggested_cat, confidence, source_event, detected_at, status: 'pending' })`.
- **Modify**: `server/server.ts` — register route; apply existing rate-limit (`server/lib/rate-limit.ts`) at 30/min; enforce 256 KB body cap.
- **Modify**: `src/scrub-map.ts` — add `serialize()`/`deserialize()` with a versioned envelope (`{v:1, entries:[…]}`).
- **Reused**: `server/lib/vocab-store.ts` `vocab.addReviewItem()`; existing Host-header guard; rate-limit middleware.
- **Test**: `tests/judge-route.test.ts` — POST with `PRIVACY_SCREEN_LLM_MOCK=1`, assert `202` within 50 ms, then assert `review_queue` row count grew after a short sleep.
- **Pipeline**: Engineer (TDD), **Pentester** (body schema, size cap, Host guard, rate-limit applied).

## Phase 6 — Hook integration (fire-and-forget)

- **Goal**: hook POSTs scrubbed text after returning its own response, capped at 150 ms.
- **Modify**: `hooks/PrivacyScreen.hook.ts` at line ~206 (after the `console.log` that returns `updatedInput`):
  - Read `cfg.llm_validate.enabled`; skip if false.
  - Build POST body from `scrubbedInput` + `map.serialize()` + `sourceEvent`.
  - `await fetch('http://127.0.0.1:31338/api/judge', { method: 'POST', body, signal: AbortSignal.timeout(150) })` wrapped in try/catch; any failure is silent.
  - Refuse to send if the configured endpoint host is not `127.0.0.1` / `localhost` (defense in depth against misconfig leaking to a remote URL).
- **Reused**: existing config loader; `SCRUB_BUDGET_MS` accounting pattern (line 43).
- **Test**: `tests/hook-judge-handoff.test.ts` — spin up a tiny Hono receiver on an ephemeral port, override endpoint via env, assert POST body shape; assert hook stdout JSON is byte-identical whether POST succeeds, times out, or refuses.
- **Pipeline**: Engineer (TDD), **Pentester** (hook latency unaffected when LLM disabled; loopback-only enforcement).

## Phase 7 — CLI installer (`privacy-screen install-judge`)

- **Goal**: one command to a working local model.
- **Modify**: `cli/PrivacyScreen.ts` — add `case 'install-judge':`. Subcommands:
  - `install-judge --model qwen2.5-1.5b --allow-network` downloads pinned HuggingFace GGUF to `${homedir()}/.privacy-screen/models/`, verifies SHA-256 against an embedded manifest, writes path to `PRIVACY_CONFIG.yaml` `llm_validate.model_path`.
  - `install-judge --runtime` prefers `which llama-server`; otherwise prints per-OS install instructions. **Does not auto-download the runtime binary in v1** (separate security review).
  - Refuse to run without `--allow-network` (user must explicitly consent to a network fetch).
- **Reused**: `homedir()`; YAML write pattern from `server/routes/settings.ts`.
- **Test**: `tests/cli-install-judge.test.ts` — dry-run prints planned actions; checksum mismatch aborts; path-traversal in model_path rejected.
- **Pipeline**: Engineer, **Pentester** (TOCTOU on checksum, path traversal, network-fetch hardening).

## Phase 8 — Golden integration tests (gated by `LLM_TESTS=1`)

- **Goal**: regression coverage against the real model; off by default in CI.
- **Create**: `tests/judge-golden.test.ts` — guarded `if (!process.env.LLM_TESTS) return test.skip(...)`. Six prompts: Korean name (`김민준`), Arabic name (`أحمد عبد الله`), Vietnamese name (`Nguyễn Thị Hương`), Indian PIN (`560034`), novel API token, plain English control (must return zero spans). Assert category + min confidence; tolerant of exact wording.
- **Modify**: `README.md` — note `LLM_TESTS=1 bun test` to run locally.
- **Pipeline**: **QATester**.

## Phase 9 — simplify + Pentester sweep

- **/simplify**: walk `src/judge/`, `server/lib/llm-process.ts`, `server/routes/judge.ts`; collapse dead branches; ensure category normalization has a single source of truth; kill duplicate config reads.
- **Pentester sweep**:
  1. `llama-server` binds 127.0.0.1 only on a random high port.
  2. Prompt-injection from model output writing into `review_queue` — confirm every field is treated as untrusted string and rendered safely in the existing UI.
  3. `/api/judge` request-size cap (256 KB) and rate-limit are enforced.
  4. Hook refuses non-loopback endpoints.
  5. Fail-closed categories from the regex layer cannot be overridden by judge output (judge can only *add* review items).
- **Modify**: `SAFETY_CHECKLIST.md` — record sweep date and findings.

---

## /Development pipeline mapping

| Phase | Architect | Engineer (TDD) | /simplify | QATester | Pentester |
|---|---|---|---|---|---|
| 1 Config | ✓ | ✓ | — | unit | — |
| 2 Homedir | — | ✓ | — | unit | — |
| 3 Judge module | ✓ | ✓ | end | unit | — |
| 4 Subprocess | ✓ | ✓ | end | unit | ✓ |
| 5 Route | — | ✓ | end | route | ✓ |
| 6 Hook | — | ✓ | end | integration | ✓ |
| 7 CLI install | — | ✓ | end | CLI | ✓ |
| 8 Golden | — | — | — | ✓ | — |
| 9 Sweep | — | — | ✓ | — | ✓ |

Designer and UIReviewer skipped — no new UI surface; the review-queue UI already exists at `server/routes/review.ts` and consumes any new rows transparently.

---

## Critical Files

**Modified:**
- `src/config.ts` — Phase 1
- `src/vocab.ts` — Phase 2
- `src/scrub-map.ts` — Phase 5 (add `serialize`/`deserialize`)
- `server/server.ts` — Phases 4 + 5 (shutdown hook, route registration)
- `hooks/PrivacyScreen.hook.ts` — Phase 6 (fire-and-forget POST)
- `cli/PrivacyScreen.ts` — Phase 7 (`install-judge` case)
- `privacy-config.example.yaml` — Phase 1
- `SAFETY_CHECKLIST.md` — Phases 1 + 9
- `README.md` — Phase 8

**Created:**
- `src/judge/judge.ts`
- `src/judge/normalize.ts`
- `src/judge/llm-client.ts`
- `src/judge/prompt.ts`
- `server/lib/llm-process.ts`
- `server/routes/judge.ts`
- `tests/config.test.ts` (extends)
- `tests/judge.test.ts`
- `tests/llm-process.test.ts`
- `tests/judge-route.test.ts`
- `tests/hook-judge-handoff.test.ts`
- `tests/cli-install-judge.test.ts`
- `tests/judge-golden.test.ts`

**Reused existing utilities:**
- `src/scrub-map.ts` `ScrubMap.tokenFor()` — overlap filtering in judge.
- `server/lib/vocab-store.ts` `vocab.addReviewItem()` — review-queue write API.
- `server/lib/rate-limit.ts` — applied to `/api/judge`.
- `server/lib/update-check.ts` `fetch` pattern — model checks reuse this shape.
- `server/routes/review.ts` — existing UI/CLI consumers; no changes needed.

---

## Verification Recipe

1. **Install**: `bun run cli/PrivacyScreen.ts install-judge --model qwen2.5-1.5b --allow-network`. Expect a Qwen2.5-1.5B GGUF in `${homedir()}/.privacy-screen/models/` and `model_path` written to `PRIVACY_CONFIG.yaml`. Confirm `llama-server` is on `$PATH`.

2. **Enable**: edit `PRIVACY_CONFIG.yaml` to set `llm_validate.enabled: true`.

3. **Start the server**: `bun run start`. Expect "ready" log after lazy LLM start (~5–10 s on M1 Air).

4. **Fire a multilingual prompt through the hook**:
   ```sh
   echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ping Aanya about the 김민준 migration"}}' \
     | bun run hooks/PrivacyScreen.hook.ts
   ```
   - Expect: hook stdout returns scrubbed JSON within the existing 1500 ms soft budget (the regex layer misses both names, so output is essentially unchanged).
   - Within ~3 s: `curl -s http://127.0.0.1:31338/api/review | jq '.items'` should show two new pending rows — `Aanya` as `person`, `김민준` as `person`, each with `source_event` matching the hook invocation and `confidence ≥ 0.6`.

5. **Disable and re-test**: set `llm_validate.enabled: false`, repeat step 4. Review queue should not grow. No network traffic from the hook.

6. **Kill the Hono server mid-call**: re-enable, stop the server, send a prompt. Hook must still return within budget; Claude Code unaffected; no errors propagated to the user.

7. **Smoke the test suite**: `bun test` (all green without the LLM); `LLM_TESTS=1 bun test` (golden tests pass with model installed).
