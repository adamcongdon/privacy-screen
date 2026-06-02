# LLM Secondary Validation Layer — Research

> Research doc for [Issue #5]. Can a small local LLM act as a **secondary** validator that double-checks the regex+vocab scrubber for PII it missed (novel name formats, regional naming conventions, multilingual text)? Constraints: must run on an 8GB MacBook Air (M1/M2) and a modest Windows laptop (8–16GB, integrated graphics). Regex stays primary; LLM is opt-in.

## Problem Framing

The README is explicit about where the rules-based scrubber falls down:

> **Honest limits** (per OpenAI's own framing): PrivacyScreen is one layer of defense, not a blanket anonymization guarantee. It uses regex, not ML — it will miss novel name formats, regional naming conventions, multilingual text, and any pattern not enumerated above. Treat it as a high-floor first line of defense, not a ceiling. Tune through `customer_names` + the review queue.
> — [README.md:52](../README.md#L52)

The categories where a small LLM offers genuine lift over regex+vocab:

1. **Multilingual person names** — `أحمد عبد الله`, `김민준`, `Søren Kierkegaard`, `Nguyễn Thị Hương`. The current detector is anglocentric: PascalCase + a names DB. A model with multilingual pretraining sees these as obvious people-names even without seeing them before.
2. **Contextual people-names** — "ping Aanya about the migration" looks like noise to regex (no email header, not in DB), but is clearly a person name in context.
3. **Novel address formats** — Indian PIN codes, UK postcodes embedded in prose, addresses written in non-Western order (province → city → street). Regex enumerates US/CA formats; everything else slips.
4. **Idiomatic credentials** — secrets disguised as prose ("the password is correcthorsebatterystaple"), API tokens with non-standard prefixes from minor vendors, JWT-shaped strings in odd contexts.
5. **Rare org names** — "we lost a deal with Strzelecki Logistik" — neither matches `customer_names:` nor a known regex.

**What the LLM is asked to do.** The LLM is a **JUDGE, not an editor**. It receives the *already-scrubbed* text (tokens like `{EMAIL}`, `{PERSON_1}` already substituted) plus the token map, and emits structured JSON:

```json
{
  "suspicious_spans": [
    { "text": "Aanya",    "category": "person",     "confidence": 0.82, "reason": "South Asian given name, used as subject of ping" },
    { "text": "560034",   "category": "postcode",   "confidence": 0.71, "reason": "looks like Indian PIN" },
    { "text": "kuku-prod","category": "hostname",   "confidence": 0.55, "reason": "looks like a service name; not in allowlist" }
  ]
}
```

The judgment is then handed back to the existing scrubber/vocab system, which decides whether to mint new tokens, push to the review queue, or ignore. The LLM **never** writes the final output. This containment is what makes the privacy posture acceptable: hallucinations cost a false-positive token, not a leak.

## Performance Constraints

**MacBook Air M1/M2 (target floor):**
- 8GB unified memory (worst case — most current Airs ship 8–16GB).
- Integrated GPU via Metal; no discrete GPU.
- Memory bandwidth: 68.25 GB/s (M1) → 100 GB/s (M2). [Apple Silicon spec sheets via [llmcheck.net methodology](https://llmcheck.net/benchmarks)]
- Inference is **memory-bandwidth-bound** on this hardware for sub-7B models — quantization choice dominates speed.

**Windows laptop (target floor):**
- 8–16GB system RAM.
- Integrated Intel Iris Xe or AMD Radeon (no CUDA).
- llama.cpp Vulkan backend is the lingua franca; SYCL works on Intel but is more fragile. [[llama.cpp Vulkan discussion #10879](https://github.com/ggml-org/llama.cpp/discussions/10879)]

**Hard RAM ceiling math for the 8GB Air.**
After macOS + browser + Claude Code + privacy-screen's Hono server + Vite artifacts, working memory available to the LLM is roughly **3–4 GB**. That is the binding constraint. Anything above ~3.5 GB resident risks swap, which obliterates throughput on the Air's SSD.

For a Q4_K_M GGUF, runtime resident set ≈ `file_size + KV_cache + activation_buffers`. Rule of thumb: model file × 1.3 at small context (≤2K). So:

| Model file size on disk | Approx runtime RSS (Q4_K_M, 2K ctx) | Fits in 3.5GB headroom? |
|---|---|---|
| 0.4 GB (Qwen2.5-0.5B) | ~0.6 GB | yes, comfortably |
| 1.0 GB (Llama 3.2 1B) | ~1.4 GB | yes |
| 1.1 GB (Qwen2.5-1.5B) | ~1.5 GB | yes |
| 1.7 GB (Gemma 2 2B) | ~2.4 GB | yes, tight |
| 2.0 GB (Llama 3.2 3B) | ~2.8 GB | yes, very tight |
| 2.4 GB (Phi-3 Mini 3.8B) | ~3.4 GB | borderline; risky on 8GB Air with other apps |
| 4.7 GB (Llama 3.1 8B Q4_K_M) | ~6 GB | **no** — fails the Air constraint |

**Published throughput numbers for the candidates** (all Q4_K_M unless noted):

- **Llama 3.2 1B via MLX on M3**: ~250 tok/s with structured JSON enabled. [[LM Studio 0.3.4 release post](https://lmstudio.ai/blog/lmstudio-v0.3.4)] M1/M2 Air will be slower (memory-bandwidth-bound) — estimate 80–150 tok/s.
- **Qwen2 1.5B on M1 Mac**: 30–60 tok/s depending on quantization and backend. [[Apple Silicon benchmarks methodology, llmcheck.net](https://llmcheck.net/benchmarks); corroborated by community reports]
- **Phi-3 / Phi-4 Mini (3.8B) Q4_K_M on M1 MacBook Air**: ~15–20 tok/s. [[Local AI Master — Phi-4-mini benchmarks](https://localaimaster.com/models/phi-4-mini)]
- **Small (3–9B) models on M1 16GB**: 40–80 tok/s general range. [[llmcheck.net](https://llmcheck.net/benchmarks)]
- **M2 Air, Llama 3.1 8B**: 18 tok/s; M2 Air, Qwen 0.8B: 55 tok/s. [[Local AI Master — Apple Silicon AI buying guide](https://localaimaster.com/blog/apple-silicon-ai-buying-guide)]
- **Iris Xe (Windows integrated GPU), Phi-3.5 Mini via Vulkan**: 15–25 tok/s; 3B-class models 30–50 tok/s. [[zenvanriel.com — Vulkan offload on iGPU](https://zenvanriel.com/ai-engineer-blog/local-ai-integrated-graphics-vulkan-offload/)]

Exact M1-Air-specific numbers for every model were not published; the figures above triangulate from the closest public benchmarks. Where I lacked a hard number I marked the range conservatively (e.g. "estimate 80–150" for MLX on M1 vs the M3's 250).

## Model Candidates

All sizes assume Q4_K_M GGUF (the de-facto small-model quant; ~4.5 bits/weight effective, k-quant medium). License column matters because privacy-screen is distributable.

| Model | Params | Q4_K_M size | RSS @ 2K ctx | License | Multilingual? |
|---|---|---|---|---|---|
| **Qwen2.5-0.5B-Instruct** | 0.49B | ~0.4 GB | ~0.6 GB | Apache 2.0 | yes (29 langs) |
| **Qwen2.5-1.5B-Instruct** | 1.54B | ~1.0 GB | ~1.4 GB | Apache 2.0 | yes (29 langs) |
| **Llama 3.2 1B Instruct** | 1.24B | ~0.8 GB | ~1.1 GB | Llama 3 Community | English-heavy; 8 official langs |
| **Llama 3.2 3B Instruct** | 3.21B | ~2.0 GB | ~2.8 GB | Llama 3 Community | same |
| **Gemma 2 2B Instruct** | 2.6B | ~1.6 GB | ~2.3 GB | Gemma terms (≈Apache-like, with use restrictions) | multilingual training |
| **Phi-3 Mini 4K Instruct** | 3.82B | ~2.4 GB | ~3.4 GB | MIT | English-dominant |
| **Phi-3.5 Mini Instruct** | 3.82B | ~2.4 GB | ~3.4 GB | MIT | improved multilingual vs Phi-3 |

Sources: [Qwen2.5 blog](https://qwenlm.github.io/blog/qwen2.5/), [Qwen2.5 HF license](https://huggingface.co/Qwen/Qwen2.5-7B/blob/main/LICENSE), [Local AI Master — Phi-3 Mini](https://localaimaster.com/models/phi-3-mini-3.8b), [llmcheck.net methodology](https://llmcheck.net/benchmarks).

**Strategic notes per candidate:**

- **Qwen2.5-0.5B** — outperforms Gemma2-2.6B on math and coding per the [Qwen2.5 release post](https://qwenlm.github.io/blog/qwen2.5/), and is multilingual across 29 languages. Apache 2.0 = no commercial friction. The smallest competent model for structured JSON output. JSON-mode reliability on instruction-tuned 0.5B class is the open question — for our judge task (extract suspicious spans, no creative writing) it should be sufficient, but worth golden-test verifying.
- **Qwen2.5-1.5B** — Apache 2.0. Strongest 1B-class multilingual. Substantially better JSON-mode reliability than 0.5B per the [Qwen2.5 technical report](https://arxiv.org/pdf/2412.15115). My center-of-gravity recommendation.
- **Llama 3.2 1B/3B** — fastest published structured-JSON numbers on Apple Silicon (250 tok/s on M3 via MLX). License is the Llama 3 Community License — fine for our use, but restricts certain commercial scenarios.
- **Gemma 2 2B** — solid multilingual base, but Gemma's use restrictions ([Gemma Prohibited Use Policy](https://ai.google.dev/gemma/terms)) are louder than Apache 2.0. Acceptable but not preferred.
- **Phi-3 Mini / Phi-3.5 Mini** — MIT licensed, strong reasoning, but 3.8B is right at the 8GB Air ceiling. Phi-3.5 Mini is the better choice if you go this route (improved multilingual).

## Runtime Candidates

| Runtime | Install footprint | Platforms | Small-model throughput | Bundling story | Notes |
|---|---|---|---|---|---|
| **Ollama** | ~150MB CLI + per-model GGUF; daemon | macOS, Linux, Windows | Behind MLX by 20–30% for sub-14B; CLI wraps llama.cpp by default | Separate user install. Cannot legally bundle inside our installer at scale. | Best DX. Out-of-process daemon. |
| **llama.cpp** | ~10MB single binary + GGUF | macOS (Metal), Linux, Windows (CUDA/Vulkan/SYCL) | Reference implementation; Metal & Vulkan backends | Can bundle the static binary or use bindings | Most portable C++. MIT. |
| **llamafile** | Single executable, weights+runtime in one file | All major OSes via Cosmopolitan Libc | Same as llama.cpp under the hood | **Ship as one file** — drop into installer | [mozilla-ai/llamafile](https://github.com/mozilla-ai/llamafile). Most-elegant packaging story. |
| **MLX / mlx-lm** | Python wheel + Metal kernels | **macOS only** | Fastest on Apple Silicon — 15–30% over llama.cpp for sub-14B | Mac-only; complicates Windows parity | [ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm) |
| **Candle (Rust)** | Rust crate, compiled into your binary | macOS (Metal), Linux (CUDA), Windows | Generation: roughly between llama.cpp and MLX per [Medium comparison](https://medium.com/@zaiinn440/apple-mlx-vs-llama-cpp-vs-hugging-face-candle-rust-for-lightning-fast-llms-locally-5447f6e9255a) | Compiled into a single Rust binary | Best for pure-Rust ecosystems. We're TypeScript. |
| **MLC LLM** | Per-model compiled artifacts | macOS, Linux, Windows, mobile | Competitive on Metal; ahead on some mobile NPUs | Each model compiled separately; heavier ops burden | TVM-compiled; impressive but adds ops complexity. |

Sources: [Ollama MLX blog](https://ollama.com/blog/mlx), [Ante Kapetanovic benchmarks](https://antekapetanovic.com/blog/qwen3.5-apple-silicon-benchmark/), [Contra Collective comparison](https://contracollective.com/blog/llama-cpp-vs-mlx-ollama-vllm-apple-silicon-2026), [llama.cpp Vulkan discussion](https://github.com/ggml-org/llama.cpp/discussions/10879), [arXiv comparative study (2511.05502)](https://arxiv.org/pdf/2511.05502).

**Key runtime insight:** privacy-screen ships as a `bun`-managed TS project across Mac and Windows. We need a runtime that works identically on both, with one model file, no per-platform compilation, no Python. **llama.cpp via its prebuilt binaries (or llamafile) is the only candidate that hits all of those.** MLX is mac-only and out. Candle wants Rust. MLC requires per-model compile. Ollama requires the user to install a separate daemon (which most won't).

## Integration Shape

```ts
// server/lib/llm-judge.ts
//
// LLM secondary validation. NEVER runs unless cfg.llm_validate === true.
// NEVER replaces the regex+vocab scrubber. Only annotates suspicious spans
// in already-scrubbed text for the review queue / vocab-induction loop.

import type { TokenMap } from "../../src/scrub-map";

export type SuspiciousSpan = {
  text: string;
  category: "person" | "org" | "address" | "credential" | "hostname" | "other";
  confidence: number; // 0..1
  reason: string;
};

export type LLMConfig = {
  llm_validate: boolean;          // default false
  runtime: "llamafile" | "llamacpp" | "ollama";
  model_path: string;             // GGUF path or llamafile path
  budget_ms: number;              // hard wall-clock cap; default 1500
  max_spans: number;              // truncate output; default 16
};

const DEFAULT_BUDGET_MS = 1500;

// Hot-path entry. Returns [] on disable, timeout, or any error.
// The hook MUST remain within its 8s budget when this returns [].
export async function secondPassValidate(
  scrubbed: string,
  tokenMap: TokenMap,
  cfg: LLMConfig,
): Promise<SuspiciousSpan[]> {
  if (!cfg.llm_validate) return [];                       // feature flag off
  if (!scrubbed || scrubbed.length < 24) return [];        // not worth the call

  const budget = cfg.budget_ms ?? DEFAULT_BUDGET_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), budget);

  try {
    // Tight prompt — model is a JUDGE, not an editor.
    const prompt = buildJudgePrompt(scrubbed, tokenMap);
    const raw = await callRuntime(prompt, cfg, controller.signal);
    return parseJudgement(raw, cfg.max_spans ?? 16);
  } catch (err) {
    // Any failure = silent no-op. Regex+vocab already ran.
    // We log to stderr but never block.
    process.stderr.write(`[llm-judge] skipped: ${(err as Error).message}\n`);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// Hook integration (pseudocode in hooks/pre-tool-use.ts):
//
//   const scrubbed = scrubber.run(input);
//   sendUpdatedInput(scrubbed.text);               // <-- hot path returns NOW
//
//   // LLM runs AFTER the hook has answered the model.
//   // Findings feed the review queue / vocab induction on the next session.
//   queueMicrotask(async () => {
//     const spans = await secondPassValidate(scrubbed.text, scrubbed.map, cfg);
//     if (spans.length) reviewQueue.add(spans, { source: "llm-judge" });
//   });
```

**Three invariants this enforces:**

1. **LLM runs AFTER regex.** Never before, never instead of. The `scrubbed` input was already produced by `src/scrubber.ts`.
2. **Hot path stays within its 8s budget when LLM is OFF.** With `llm_validate: false` the function returns synchronously in microseconds.
3. **LLM runs OUT-OF-BAND when ON.** The hook returns the scrubbed text, then `queueMicrotask` runs the LLM. Its findings land in the review queue for the next session — they cannot retroactively change a tool call that already shipped. This eliminates the latency-vs-safety tradeoff entirely.

## Recommended Choice

**Qwen2.5-1.5B-Instruct Q4_K_M via llama.cpp Metal (macOS) / Vulkan (Windows), packaged as a `llamafile` for distribution.**

Rationale tied to constraints:

- **RAM ceiling:** ~1.5 GB RSS at 2K context — comfortable inside the 3.5 GB Air budget with multiple apps open. Has headroom Phi-3 Mini doesn't.
- **Latency budget:** 30–60 tok/s on M1 means a 500-token prompt + ~64-token JSON judgment finishes well under 1.5 s on Air; closer to 0.5–1.0 s on M2/M3. On Iris Xe via Vulkan: estimate 1.5–2.5 s wall-clock — still inside the queued out-of-band budget. The queue runs *after* the hook returns, so user-visible latency is zero.
- **Multilingual:** Qwen2.5's 29-language pretraining directly addresses README's "multilingual text" gap. The 1.5B variant is the smallest with reliable JSON-mode output.
- **License:** Apache 2.0. No clauses to negotiate, no acceptable-use policy to police.
- **Packaging:** llamafile lets us ship one `.llamafile` per platform (or one cross-platform Cosmopolitan binary) — privacy-screen's installer can drop it into `~/.privacy-screen/judge/` and call it via subprocess. No separate Ollama daemon, no Python, no per-model compile.
- **Fallback runtime:** if a user already has Ollama installed, our config supports `runtime: "ollama"` and calls its HTTP API instead. The model file is the same GGUF; only the transport differs.

**Anti-recommendation guardrail:** Qwen2.5-1.5B is 1.54B parameters — below the 4B ceiling. Apache 2.0 license imposes no platform restriction. Runs on Apple Silicon GPU (Metal) and Windows integrated GPU (Vulkan). Satisfies all anti-recommendations.

## Latency Expectations

For the recommended Qwen2.5-1.5B Q4_K_M / llama.cpp Metal stack on M1 MacBook Air:

- **Generation rate:** 30–60 tok/s on M1, 50–90 tok/s on M2 (extrapolated from [llmcheck.net](https://llmcheck.net/benchmarks) and the Qwen2 1.5B M1 community numbers; exact M1-Air-with-Q4_K_M-llama.cpp number not separately published, estimated from bandwidth-bound scaling).
- **Prompt processing:** typically 2–3× generation rate, so ~100–150 tok/s prompt-eval.
- **Wall-clock for a representative call** (500-token scrubbed input + ~64-token JSON judgment):
  - Prompt eval: 500 / 120 ≈ **4.2 s** — this is the binding term.
  - Generation: 64 / 45 ≈ **1.4 s**.
  - **Total: ~5.6 s on M1 Air**, ~3.5 s on M2 Air, ~1.5 s on M3+ (per MLX numbers above).

This is **why the integration is async/out-of-band, not inline.** Even the fastest local model is too slow to wedge into a synchronous hook on a constrained Air. The design embraces this — the LLM is a slow secondary auditor whose findings improve the *next* session, not block the current one.

For Windows Iris Xe via Vulkan, the [zenvanriel.com Vulkan offload analysis](https://zenvanriel.com/ai-engineer-blog/local-ai-integrated-graphics-vulkan-offload/) implies 1.5B-class models will hit ~25–40 tok/s — call it 8–10 s wall-clock for the same prompt. Still fine for out-of-band.

## Rejected Options

1. **Llama 3.1 8B Q4_K_M** — ~4.7 GB on disk, ~6 GB resident. **Exceeds the 8GB Air's safe working budget.** Even though it's smarter, it would push the Air into swap with normal background apps open. Local users could opt in, but it cannot be the default recommendation while the Air is in the supported floor.
2. **Cloud-hosted small LLMs (OpenAI gpt-4o-mini, Anthropic Haiku, etc. via API)** — violates the **local-first** principle. PrivacyScreen exists because text shouldn't leave the box; routing the scrubbed text to a cloud judge would re-export potentially-identifying context to a third party. Hard pass.
3. **Fine-tuned NER models requiring CUDA** (e.g., distilled PII-NER variants based on RoBERTa with CUDA-only kernels) — Air has no CUDA. Windows target laptop has integrated graphics, also no CUDA. Even where the model is small, the runtime requirement breaks portability.
4. **MLX as the primary runtime** — fastest on Mac, but **macOS-only**. Privacy-screen must run identically on the Windows laptop. Using MLX only on Mac and llama.cpp on Windows would mean two model paths, two prompts to tune, two sets of golden tests. Not worth the perf delta for a queued out-of-band audit.
5. **MLC LLM** — strong runtime but requires per-model TVM compilation. Adds ops burden for a feature that may be off by default for most users.

## Cross-Reference to Regex Limits

From [README.md:52](../README.md#L52):

> ...it will miss **novel name formats, regional naming conventions, multilingual text**, and any pattern not enumerated above.

Mapping the recommended model directly to each named gap:

| README gap | How Qwen2.5-1.5B closes it |
|---|---|
| Novel name formats | LLM recognizes capitalization-free / single-name / unfamiliar-surname people-references from sentence context. |
| Regional naming conventions | Multilingual pretraining sees `Müller`, `张伟`, `Joško Gvardiol`, `Adebayo` as people-names without the names DB. |
| Multilingual text | 29-language coverage means an Arabic, Japanese, or Vietnamese name in otherwise-English prose is flagged. |
| "Any pattern not enumerated" | The judge prompt asks the model to flag *anything that looks like PII the rules might have missed* — it generalizes beyond enumeration. |

The README's framing also matters: "high-floor first line of defense, not a ceiling." The LLM judge is an explicit **second** line — it does not raise the floor, it raises the ceiling. Regex remains the safety-critical synchronous gate.

## Next Steps

Concrete follow-up issues to implement this research:

- **(a) Config plumbing.** Add `llm_validate: false` (default) and the `LLMConfig` block to `privacy-config.example.yaml`. Wire it through `src/config.ts`. Ship as one PR with no runtime behavior change.
- **(b) Judge module.** Ship `server/lib/llm-judge.ts` implementing `secondPassValidate()` against the llamafile / llama.cpp HTTP-server transport. Subprocess management lives in `server/lib/llm-process.ts` (spawn, health-check, lazy-start, graceful shutdown on `SIGTERM`).
- **(c) Golden tests.** Ship `tests/llm-judge.test.ts` with curated multilingual cases regex provably misses today: `أحمد عبد الله`, `김민준`, `Nguyễn Thị Hương`, `Müller`, `560034` (Indian PIN), `SW1A 1AA` (UK postcode), `Aanya` (single-name context). Each case asserts the judge returns a `suspicious_span` for it. Use a deterministic seed and `temperature: 0` so tests are reproducible. Treat occasional model misses as flaky-tolerant (`retry: 2`) — this is judgment, not arithmetic.
- **(d) Opt-in flow + safety doc.** Document the opt-in in `SAFETY_CHECKLIST.md`: how to install (`bun run privacy-screen install-judge`), where the model lives, how to disable, what privacy properties hold (the scrubbed text *does* flow into the LLM subprocess, so the LLM must run fully local — re-state this guarantee).
- **(e) Review-queue integration.** Findings from the judge land in the same review queue today's low-confidence detections use. Operator sees a list of LLM-flagged spans with the model's `reason` text, can promote any to `customer_names:`/`person_names:` with one keystroke. This closes the induction loop without auto-mutating future runs.
- **(f) Telemetry.** Per-call counters: `judge.calls_total`, `judge.timeouts_total`, `judge.spans_found`, `judge.latency_ms_p50/p95`. Surface in the existing observe-mode log so users can decide whether to keep it on.
- **(g) Windows packaging.** Verify the `.llamafile` runs on Windows 10/11 with Vulkan offload and that the existing privacy-screen installer can drop it into `%APPDATA%\privacy-screen\judge\`.

## Anti-Recommendations

- **Do NOT recommend a model >4B params.** Verified: Qwen2.5-1.5B = 1.54B parameters. Pass.
- **Do NOT recommend a model that requires CUDA.** Verified: llama.cpp Metal backend (Mac) + Vulkan backend (Windows) are both CUDA-free. The model itself (GGUF) is hardware-agnostic. Pass.
- **Do NOT recommend a cloud API.** Verified: stack is local-first via llamafile/llama.cpp running in-process or as a localhost subprocess. Pass.
- **Do NOT recommend a runtime that requires a separate daemon as the default.** Verified: llamafile is a single executable. Optional Ollama support is *opt-in fallback*, not required. Pass.
- **Do NOT let the LLM mutate hot-path output.** Verified: integration is `queueMicrotask`'d *after* the hook returns the scrubbed text. Judge findings can only inform the *next* session's vocab/review queue. Pass.

---

**Sources cited inline:**
- [llama.cpp Apple Silicon performance discussion #4167](https://github.com/ggml-org/llama.cpp/discussions/4167)
- [llama.cpp Vulkan performance discussion #10879](https://github.com/ggml-org/llama.cpp/discussions/10879)
- [Apple Silicon LLM Benchmarks — llmcheck.net](https://llmcheck.net/benchmarks)
- [LM Studio 0.3.4 (MLX, Llama 3.2 1B at ~250 tok/s)](https://lmstudio.ai/blog/lmstudio-v0.3.4)
- [Local AI Master — Phi-3 Mini benchmarks](https://localaimaster.com/models/phi-3-mini-3.8b)
- [Local AI Master — Phi-4 Mini benchmarks](https://localaimaster.com/models/phi-4-mini)
- [Local AI Master — Apple Silicon buying guide](https://localaimaster.com/blog/apple-silicon-ai-buying-guide)
- [Qwen2.5 release blog](https://qwenlm.github.io/blog/qwen2.5/)
- [Qwen2.5 technical report (arXiv 2412.15115)](https://arxiv.org/pdf/2412.15115)
- [Qwen2.5-7B LICENSE (Apache 2.0)](https://huggingface.co/Qwen/Qwen2.5-7B/blob/main/LICENSE)
- [Ollama MLX backend blog](https://ollama.com/blog/mlx)
- [Ante Kapetanovic — Qwen3.5 Apple Silicon benchmark](https://antekapetanovic.com/blog/qwen3.5-apple-silicon-benchmark/)
- [Contra Collective — llama.cpp vs MLX vs Ollama vs vLLM 2026](https://contracollective.com/blog/llama-cpp-vs-mlx-ollama-vllm-apple-silicon-2026)
- [arXiv 2511.05502 — Comparative study of MLX/MLC/Ollama/llama.cpp](https://arxiv.org/pdf/2511.05502)
- [Mozilla AI — llamafile](https://github.com/mozilla-ai/llamafile)
- [mlx-lm](https://github.com/ml-explore/mlx-lm)
- [Candle vs MLX vs llama.cpp comparison (Medium)](https://medium.com/@zaiinn440/apple-mlx-vs-llama-cpp-vs-hugging-face-candle-rust-for-lightning-fast-llms-locally-5447f6e9255a)
- [zenvanriel.com — Vulkan offload on integrated GPUs](https://zenvanriel.com/ai-engineer-blog/local-ai-integrated-graphics-vulkan-offload/)
