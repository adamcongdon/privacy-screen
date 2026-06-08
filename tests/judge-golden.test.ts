/**
 * Golden integration tests for the LLM judge.
 *
 * SKIPPED unless LLM_TESTS=1. These hit a real llama-server with a real
 * model loaded — they exist to verify the prompt + schema actually elicit
 * the multilingual / regional detections the regex layer can't reach.
 *
 * To run locally:
 *   1. Install the model: bun cli/PrivacyScreen.ts install-judge \
 *        --model qwen2.5-1.5b --allow-network
 *   2. Start llama-server pointed at the GGUF (on any loopback port).
 *   3. LLM_TESTS=1 LLM_JUDGE_ENDPOINT=http://127.0.0.1:8080 bun test \
 *        tests/judge-golden.test.ts
 *
 * Tolerant by design: the judge is a model, not arithmetic. Each test
 * asserts the *category* of the finding (person / address / etc.) but
 * not the exact reason text, and accepts a min-confidence floor rather
 * than a tight value.
 */
import { describe, test, expect } from 'bun:test';

import { LlamaServerClient } from '../src/judge/llm-client';
import { ScrubMap } from '../src/scrub-map';
import { runJudge, type SuspiciousSpan } from '../src/judge/judge';

const LLM_TESTS = process.env.LLM_TESTS === '1';
const ENDPOINT = process.env.LLM_JUDGE_ENDPOINT ?? 'http://127.0.0.1:8080';

const conditional = LLM_TESTS ? test : test.skip;

function newJudgeOpts(): Parameters<typeof runJudge>[2] {
  return {
    client: new LlamaServerClient({ endpoint: ENDPOINT }),
    timeoutMs: 30_000, // generous for slow Macs / cold model
    maxTokens: 256,
    maxSpans: 16,
    minConfidence: 0.4, // lower floor than production — we want to see what the model emits
  };
}

function spanFor(
  result: { spans: SuspiciousSpan[] },
  needle: string,
): SuspiciousSpan | undefined {
  return result.spans.find((s) => s.text.includes(needle) || needle.includes(s.text));
}

describe('judge golden — multilingual person names', () => {
  conditional('flags Korean name `김민준`', async () => {
    const scrubbed = 'Send the migration plan to 김민준 by Friday.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    const span = spanFor(result, '김민준');
    expect(span).toBeDefined();
    expect(span?.category).toBe('person');
  });

  conditional('flags Arabic name `أحمد عبد الله`', async () => {
    const scrubbed = 'CC أحمد عبد الله on the next status update please.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    const span = spanFor(result, 'أحمد');
    expect(span).toBeDefined();
    expect(span?.category).toBe('person');
  });

  conditional('flags Vietnamese name `Nguyễn Thị Hương`', async () => {
    const scrubbed = 'Nguyễn Thị Hương led the rollout — please thank her.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    const span = spanFor(result, 'Nguyễn');
    expect(span).toBeDefined();
    expect(span?.category).toBe('person');
  });
});

describe('judge golden — regional address formats', () => {
  conditional('flags Indian PIN code `560034`', async () => {
    const scrubbed = 'Ship the dev kit to the Bangalore office, PIN 560034.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    const span = spanFor(result, '560034');
    expect(span).toBeDefined();
    // Either address or other is acceptable here — the prompt allows both.
    if (span) expect(['address', 'unsure']).toContain(span.category);
  });
});

describe('judge golden — novel credentials', () => {
  conditional('flags vendor-shaped API token', async () => {
    // A made-up token shape regex won't match.
    const scrubbed =
      'Use the vendor token: vnd_ak_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 to authenticate.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    const span = result.spans.find((s) => s.text.includes('vnd_ak_'));
    expect(span).toBeDefined();
    expect(span?.category).toBe('credential');
  });
});

describe('judge golden — control', () => {
  conditional('returns zero spans on plain English with no PII', async () => {
    const scrubbed =
      'Thanks for the review notes. I will address the architectural concern about the cache layer next week and circle back.';
    const result = await runJudge(scrubbed, new ScrubMap(), newJudgeOpts());
    expect(result.errorReason).toBeNull();
    expect(result.spans.length).toBe(0);
  });
});
