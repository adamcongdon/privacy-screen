/**
 * Judge module tests — pure logic with mocked LLM client.
 * Covers happy path, error paths, filtering rules, category normalization,
 * and the loopback-only guard on `LlamaServerClient`.
 */
import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';
import { runJudge, type JudgeOptions, validateAndShape } from '../src/judge/judge';
import {
  MockLlmClient,
  LlamaServerClient,
  type LlmCompletionRequest,
  type LlmClient,
} from '../src/judge/llm-client';
import {
  normalizeCategory,
  LLM_TO_REVIEW_CATEGORY,
} from '../src/judge/normalize';
import {
  buildJudgePrompt,
  PROMPT_VERSION,
  JUDGE_SCHEMA,
} from '../src/judge/prompt';

// Namespace import for accessing exported internals (validateAndShape) in TDD tests without
// polluting main imports or requiring type declaration changes. Used only for JDG-06 direct unit tests.
import * as judgeInternals from '../src/judge/judge';

const LONG_INPUT =
  'Please ping Aanya about the Korean migration scheduled for next quarter.';

function makeOpts(
  client: MockLlmClient,
  over: Partial<JudgeOptions> = {},
): JudgeOptions {
  return {
    client,
    timeoutMs: 2500,
    maxTokens: 256,
    maxSpans: 16,
    minConfidence: 0.6,
    ...over,
  };
}

function llmJson(
  spans: Array<{
    text: string;
    category: string;
    confidence: number;
    reason: string;
  }>,
): string {
  return JSON.stringify({ suspicious_spans: spans });
}

describe('prompt', () => {
  test('PROMPT_VERSION is pinned to 3', () => {
    expect(PROMPT_VERSION).toBe('3');
  });

  test('buildJudgePrompt embeds maxSpans cap and the scrubbed text', () => {
    const { system, user } = buildJudgePrompt('the quick brown fox', 7);
    expect(system.length).toBeGreaterThan(100);
    expect(user).toContain('AT MOST 7');
    expect(user).toContain('the quick brown fox');
  });

  test('system prompt explains [*] placeholder semantics', () => {
    const { system } = buildJudgePrompt('x', 1);
    expect(system).toContain('[*]');
  });

  test('JUDGE_SCHEMA shape is sane', () => {
    const s = JUDGE_SCHEMA as { type: string; properties: { suspicious_spans: { type: string } } };
    expect(s.type).toBe('object');
    expect(s.properties.suspicious_spans.type).toBe('array');
  });
});

describe('normalize', () => {
  test('LLM_TO_REVIEW_CATEGORY maps every LLM category', () => {
    expect(LLM_TO_REVIEW_CATEGORY.person).toBe('person');
    expect(LLM_TO_REVIEW_CATEGORY.org).toBe('customer');
    expect(LLM_TO_REVIEW_CATEGORY.address).toBe('address');
    expect(LLM_TO_REVIEW_CATEGORY.credential).toBe('credential');
    expect(LLM_TO_REVIEW_CATEGORY.hostname).toBe('fqdn');
    expect(LLM_TO_REVIEW_CATEGORY.other).toBe('unsure');
  });

  test('normalizeCategory accepts known strings', () => {
    expect(normalizeCategory('person')).toBe('person');
    expect(normalizeCategory('hostname')).toBe('fqdn');
  });

  test('normalizeCategory returns unsure for unknown / non-string', () => {
    expect(normalizeCategory('random_thing')).toBe('unsure');
    expect(normalizeCategory(42)).toBe('unsure');
    expect(normalizeCategory(undefined)).toBe('unsure');
    expect(normalizeCategory(null)).toBe('unsure');
  });
});

describe('runJudge — happy path', () => {
  test('returns one person span with normalized category', async () => {
    const client = new MockLlmClient([
      llmJson([
        {
          text: 'Aanya',
          category: 'person',
          confidence: 0.82,
          reason: 'common South Asian given name',
        },
      ]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text).toBe('Aanya');
    expect(res.spans[0].category).toBe('person');
    expect(res.spans[0].confidence).toBeCloseTo(0.82);
  });
});

describe('runJudge — no raw judge output on stderr by default (JDG-01 / #65)', () => {
  test('does not write verbatim model response (residual PII) to stderr', async () => {
    const secret = 'admin@acme.com';
    const client = new MockLlmClient([
      llmJson([
        { text: secret, category: 'other', confidence: 0.9, reason: 'looks like email' },
      ]),
    ]);
    const map = new ScrubMap();

    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: unknown) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const prevDebug = process.env.PRIVACY_SCREEN_DEBUG_JUDGE;
    delete process.env.PRIVACY_SCREEN_DEBUG_JUDGE;
    try {
      await runJudge('Please email admin@acme.com about the migration soon.', map, makeOpts(client));
    } finally {
      process.stderr.write = orig;
      if (prevDebug === undefined) delete process.env.PRIVACY_SCREEN_DEBUG_JUDGE;
      else process.env.PRIVACY_SCREEN_DEBUG_JUDGE = prevDebug;
    }

    expect(captured).not.toContain(secret);
    expect(captured).not.toContain('judge.raw');
  });
});

describe('runJudge — early exit', () => {
  test('input below 24 chars short-circuits and does NOT call the client', async () => {
    const client = new MockLlmClient([llmJson([])]); // would-be response
    const map = new ScrubMap();
    const res = await runJudge('too short', map, makeOpts(client));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).toBe('input_too_short');
    // Critical: client was never consulted.
    expect(client.pending).toBe(1);
  });
});

describe('runJudge — error paths', () => {
  test('client throw → spans=[] with llm_failed errorReason (taxonomy JDG-05)', async () => {
    // TDD RED updated before judge edit + re-applied; expects distinct llm_failed for client errors
    const client = new MockLlmClient([new Error('aborted')]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('llm_failed:')).toBe(true);
    expect(res.errorReason!).toContain('aborted');
  });

  test('non-JSON response → spans=[] with parse_failed errorReason', async () => {
    const client = new MockLlmClient(['not json at all']);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('parse_failed: ')).toBe(true);
  });

  test('malformed entry shape is dropped silently, valid entries kept', async () => {
    const client = new MockLlmClient([
      JSON.stringify({
        suspicious_spans: [
          { text: 'OK Name', category: 'person', confidence: 0.9, reason: 'r' },
          { text: 'Bad', category: 'person', confidence: 'high', reason: 'r' }, // bad type
          { category: 'person', confidence: 0.9, reason: 'r' }, // missing text
          null,
        ],
      }),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text).toBe('OK Name');
  });
});

describe('runJudge — filtering rules', () => {
  test('span overlapping an existing token is dropped', async () => {
    const map = new ScrubMap();
    map.mint('EMAIL', 'admin@acme.com');
    const client = new MockLlmClient([
      llmJson([
        {
          text: 'admin@acme.com',
          category: 'other',
          confidence: 0.9,
          reason: 'looks like email',
        },
      ]),
    ]);
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    expect(res.spans).toEqual([]);
  });

  test('low-confidence span is dropped under minConfidence', async () => {
    const client = new MockLlmClient([
      llmJson([
        { text: 'Maybe', category: 'person', confidence: 0.4, reason: 'r' },
      ]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client, { minConfidence: 0.6 }));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).toBeNull();
  });

  test('unknown category is normalized to unsure (span kept)', async () => {
    const client = new MockLlmClient([
      llmJson([
        { text: 'Mystery', category: 'random_thing', confidence: 0.9, reason: 'r' },
      ]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].category).toBe('unsure');
  });

  test('maxSpans hard-caps the returned list', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      text: `Name${i}`,
      category: 'person',
      confidence: 0.9,
      reason: 'r',
    }));
    const client = new MockLlmClient([llmJson(twenty)]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client, { maxSpans: 5 }));
    expect(res.spans).toHaveLength(5);
  });

  test('single-char text is dropped (length < 2)', async () => {
    const client = new MockLlmClient([
      llmJson([{ text: 'A', category: 'person', confidence: 0.9, reason: 'r' }]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]);
  });

  test('long text and reason fields are clipped', async () => {
    const longText = 'x'.repeat(500);
    const longReason = 'y'.repeat(500);
    const client = new MockLlmClient([
      llmJson([
        { text: longText, category: 'person', confidence: 0.9, reason: longReason },
      ]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text.length).toBe(200);
    expect(res.spans[0].reason.length).toBe(280);
  });

  test('TDD for #43: code-like false positives (Repository_2, Server_3) from LLM judge are filtered and never reach review queue', async () => {
    // Per fable-development-template.md TDD: this test is added and run (RED) BEFORE
    // editing src/judge/judge.ts validateAndShape. It reproduces the symptom from
    // issue #43 (LLM overflags code identifiers / token-like names as suspicious).
    const client = new MockLlmClient([
      llmJson([
        {
          text: 'Repository_2',
          category: 'other',
          confidence: 0.75,
          reason: 'looks like a resource name',
        },
        {
          text: 'Server_3',
          category: 'other',
          confidence: 0.8,
          reason: 'internal server identifier',
        },
        {
          text: 'Aanya',
          category: 'person',
          confidence: 0.9,
          reason: 'real person name missed by regex',
        },
      ]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    // The real PII name must still be reported (safety: do not regress recall)
    expect(res.spans.some((s) => s.text === 'Aanya')).toBe(true);
    // The code-identifier false positives from the judge must be dropped
    expect(res.spans.some((s) => s.text === 'Repository_2' || s.text === 'Server_3')).toBe(false);
    expect(res.spans).toHaveLength(1);
  });
});

/**
 * Wrap a minimal fetch-like async function so it satisfies Bun's `typeof fetch`
 * (which requires a `preconnect` property). Tests never invoke preconnect.
 */
function asFetch(fn: (input: unknown, init?: unknown) => Promise<Response>): typeof fetch {
  return Object.assign(fn as unknown as typeof fetch, { preconnect: () => {} });
}

describe('LlamaServerClient — loopback enforcement', () => {
  test('refuses non-loopback endpoint without calling fetch', async () => {
    let called = false;
    const stubFetch = asFetch(async () => {
      called = true;
      throw new Error('fetch should not be called');
    });
    const client = new LlamaServerClient({
      endpoint: 'http://example.com:8080',
      fetchImpl: stubFetch,
    });
    const req: LlmCompletionRequest = {
      system: 's',
      user: 'u',
      maxTokens: 8,
      timeoutMs: 100,
    };
    let threw: Error | null = null;
    try {
      await client.complete(req);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message).toContain('loopback');
    expect(called).toBe(false);
  });

  test('accepts 127.0.0.1 and returns choices[0].message.content', async () => {
    const payload = { choices: [{ message: { content: '{"suspicious_spans":[]}' } }] };
    const stubFetch = asFetch(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new LlamaServerClient({
      endpoint: 'http://127.0.0.1:8080',
      fetchImpl: stubFetch,
    });
    const out = await client.complete({
      system: 's',
      user: 'u',
      maxTokens: 8,
      timeoutMs: 100,
    });
    expect(out).toBe('{"suspicious_spans":[]}');
  });

  test('non-2xx response throws with HTTP status in message', async () => {
    const stubFetch = asFetch(async () => new Response('upstream down', { status: 503 }));
    const client = new LlamaServerClient({
      endpoint: 'http://localhost:9000',
      fetchImpl: stubFetch,
    });
    let threw: Error | null = null;
    try {
      await client.complete({
        system: 's',
        user: 'u',
          maxTokens: 8,
        timeoutMs: 100,
      });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message).toContain('503');
  });
});

/**
 * TDD tests for JDG-05 — written and executed for RED *before any edit* to
 * src/judge/judge.ts (or server/routes/judge.ts). Covers:
 * - Distinct error taxonomy: llm_failed: for client.complete failures (timeouts,
 *   network, llm errors), parse_failed: only for response parse/JSON/shape.
 * - chunksTotal / chunksFailed populated on JudgeResult.
 * - Partial chunk failure: even when good chunks produce spans, errorReason
 *   remains set (and chunksFailed>0) so that callers can log partials and
 *   the sync path stays fail-closed (503).
 */
describe('runJudge — error taxonomy and partial-chunk failure reporting (JDG-05) [TDD RED before judge edit]', () => {
  // NOTE: these tests MUST pass only after the fix. Run before touching judge.ts
  // to demonstrate RED state per fable-development-template.md.

  test('client/LLM throw uses distinct llm_failed: prefix + chunks counts', async () => {
    const client = new MockLlmClient([new Error('connection refused')]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('llm_failed:')).toBe(true);
    expect(res.errorReason!).toContain('connection refused');
    expect((res as any).chunksTotal).toBe(1);
    expect((res as any).chunksFailed).toBe(1);
  });

  test('parse error keeps parse_failed: (distinct from llm)', async () => {
    const client = new MockLlmClient(['this is not valid json {{{']);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('parse_failed:')).toBe(true);
    expect((res as any).chunksTotal).toBe(1);
    expect((res as any).chunksFailed).toBe(1);
  });

  test('mixed: one good chunk (yields span) + one error chunk -> spans kept, errorReason kept for partial, chunksTotal=2 chunksFailed=1', async () => {
    // Construct input that will be split into (at least) 2 chunks by chunkText.
    // MAX_CHUNK_CHARS=1800; use two ~950+ char segments joined by blank line to force >1800 total.
    const goodChunkContent = 'Please contact Aanya urgently. ' + 'A'.repeat(950);
    const badChunkContent = 'Also reach out to Bob at the office. ' + 'B'.repeat(950);
    const multiChunkInput = goodChunkContent + '\n\n' + badChunkContent;

    const client = new MockLlmClient([
      // first chunk succeeds with a span
      llmJson([
        { text: 'Aanya', category: 'person', confidence: 0.91, reason: 'given name in context' },
      ]),
      // second chunk fails (simulates llm error on that chunk)
      new Error('timeout on second chunk'),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(multiChunkInput, map, makeOpts(client));

    // Partial success: span from chunk 1 is reported
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text).toBe('Aanya');

    // But errorReason must remain (partial failure) — this is key for logging + sync fail-closed
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('llm_failed:')).toBe(true);
    expect(res.errorReason!).toContain('timeout on second chunk');

    expect((res as any).chunksTotal).toBe(2);
    expect((res as any).chunksFailed).toBe(1);
  });

  test('sync fail-closed contract preserved: good chunk + error chunk (even zero-span error) still produces errorReason (caller does 503)', async () => {
    // Mirrors the acceptance: "test: one ok + one error/zero-span chunk still 503"
    const good = 'Scrubbed text with Carol inside. ' + 'C'.repeat(950);
    const bad = 'More scrubbed text here for Bob. ' + 'D'.repeat(950);
    const input = good + '\n\n' + bad;

    const client = new MockLlmClient([
      llmJson([{ text: 'Carol', category: 'person', confidence: 0.88, reason: 'name' }]),
      new Error('zero-span error chunk'), // even if this chunk produced 0 spans before error
    ]);
    const map = new ScrubMap();
    const res = await runJudge(input, map, makeOpts(client));

    expect(res.spans.length).toBeGreaterThan(0); // from good chunk
    expect(res.errorReason).not.toBeNull(); // still truthy -> sync route will 503 fail-closed
    expect((res as any).chunksTotal).toBe(2);
    expect((res as any).chunksFailed).toBe(1);
  });
});

/**
 * TDD RED tests for JDG-06 (issue #70) — added to tests/judge.test.ts *before*
 * any changes to src/judge/llm-client.ts or src/judge/judge.ts per
 * Plans/fable-development-template.md.
 *
 * These must fail (RED) on current code:
 * - LlamaServerClient hardcodes json_object, does not send json_schema or JUDGE_SCHEMA
 * - validateAndShape (and thus runJudge) accepts NaN / >1 confidence (NaN < x is false; 1.5 < 0.6 is false)
 */
describe('LlamaServerClient — json_schema wiring (JDG-06 TDD RED before edit)', () => {
  test('LlamaServerClient serialises response_format.type === "json_schema" (strict) and includes full JUDGE_SCHEMA', async () => {
    let capturedBody: any = null;
    const stubFetch = asFetch(async (_input: unknown, init?: unknown) => {
      const initObj = (init ?? {}) as { body?: string };
      if (initObj.body) {
        capturedBody = JSON.parse(initObj.body);
      }
      const payload = { choices: [{ message: { content: '{"suspicious_spans":[]}' } }] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new LlamaServerClient({
      endpoint: 'http://127.0.0.1:8080',
      fetchImpl: stubFetch,
    });
    await client.complete({
      system: 's',
      user: 'u',
      maxTokens: 8,
      timeoutMs: 100,
    });
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.response_format).toBeDefined();
    expect(capturedBody.response_format.type).toBe('json_schema');
    expect(capturedBody.response_format.json_schema).toBeDefined();
    expect(capturedBody.response_format.json_schema.name).toBe('suspicious_spans');
    expect(capturedBody.response_format.json_schema.strict).toBe(true);
    // Full schema match (JUDGE_SCHEMA is the source of truth)
    expect(capturedBody.response_format.json_schema.schema).toEqual(JUDGE_SCHEMA);
  });
});

describe('validateAndShape / runJudge — NaN and range clamp for confidence (JDG-06 TDD RED before edit)', () => {
  test('validateAndShape rejects confidence: NaN', () => {
    const map = new ScrubMap();
    const candidate = { text: 'NaNName', category: 'person', confidence: NaN, reason: 'nan conf' };
    const shaped = judgeInternals.validateAndShape(candidate, map, 0.6);
    expect(shaped).toBeNull();
  });

  test('validateAndShape rejects confidence: 1.5 (out of [0,1])', () => {
    const map = new ScrubMap();
    const candidate = { text: 'HighConf', category: 'person', confidence: 1.5, reason: 'too high' };
    const shaped = judgeInternals.validateAndShape(candidate, map, 0.6);
    expect(shaped).toBeNull();
  });

  test('high confidence >1 span is dropped via runJudge (exercises clamp)', async () => {
    const client = new MockLlmClient([
      llmJson([{ text: 'OverConf', category: 'person', confidence: 1.5, reason: 'r' }]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]); // currently would be kept (RED)
    expect(res.errorReason).toBeNull();
  });

  test('NaN confidence (via direct candidate) is rejected (defensive)', () => {
    const map = new ScrubMap();
    // Even though JSON never produces NaN, the clamp must be robust if non-JSON path or future code injects it
    const candidate = { text: 'NaNish', category: 'person', confidence: NaN, reason: 'r' };
    expect(judgeInternals.validateAndShape(candidate, map, 0.6)).toBeNull();
  });
});

/**
 * TDD test for JDG-07 — written and executed for RED *before any edit* to
 * chunkText in src/judge/judge.ts. Demonstrates the exact defect from the
 * issue: zero-overlap chunking causes boundary-straddling PII to be split
 * across chunks and missed (under-flagged).
 *
 * The custom OverlapAwareMock only returns a span for a chunk whose *text*
 * contains the *full* contiguous PII (as would be required for the model to
 * recognize and emit it). With current chunkText, no chunk ever contains the
 * full PII string -> always [], RED failure.
 *
 * After overlap (~150 chars) is added, an overlapping chunk will contain the
 * full PII, the mock will emit it, dedup via existing `seen` still works,
 * test goes GREEN. Per fable-development-template.md and the JDG-05 TDD
 * precedent already in this file.
 */
describe('runJudge — JDG-07 overlap window for boundary PII (TDD RED before chunkText edit)', () => {
  // Local client that decides response based on whether the chunk presented
  // to the model contains the full straddling PII verbatim. This proves the
  // chunking/overlap behavior rather than hard-coded queue order.
  class OverlapAwareMock implements LlmClient {
    private readonly fullResponse: string;
    private readonly emptyResponse: string;
    public callCount = 0;

    constructor(fullResponse: string, emptyResponse: string) {
      this.fullResponse = fullResponse;
      this.emptyResponse = emptyResponse;
    }

    async complete(req: LlmCompletionRequest): Promise<string> {
      this.callCount++;
      // The chunk is embedded verbatim in the user prompt (see buildJudgePrompt).
      if (req.user.includes('AanyaBoundaryStraddlerXXX')) {
        return this.fullResponse;
      }
      return this.emptyResponse;
    }
  }

  test('boundary PII straddling the MAX_CHUNK_CHARS cut is detected thanks to overlap (RED without overlap)', async () => {
    // Construct input >1800 chars where the PII has no internal whitespace,
    // and the prefix forces the cut (which falls back to maxChars) to land
    // inside the PII. Without overlap, first chunk gets prefix+head, second
    // gets tail+ suffix; full PII string never present in any chunk.
    const MAX = 1800;
    const pii = 'AanyaBoundaryStraddlerXXX';
    // 1795 x's + pii => cut at 1800 eats only first 5 chars of 22-char pii.
    const prefix = 'x'.repeat(MAX - 5);
    // Suffix long enough to produce a second chunk and pass MIN_INPUT_LENGTH.
    const suffix =
      ' and the rest of the long input after the straddler to force a second chunk ' +
      'z'.repeat(300);
    const input = prefix + pii + suffix;

    expect(input.length).toBeGreaterThan(MAX); // will be chunked

    const fullSpanJson = llmJson([
      {
        text: pii,
        category: 'person',
        confidence: 0.93,
        reason: 'name straddling the 1800-char chunk boundary',
      },
    ]);
    const emptyJson = llmJson([]);

    const client = new OverlapAwareMock(fullSpanJson, emptyJson);
    const map = new ScrubMap();

    // Build opts manually (makeOpts is typed only for MockLlmClient).
    const opts: JudgeOptions = {
      client: client as any,
      timeoutMs: 2500,
      maxTokens: 256,
      maxSpans: 16,
      minConfidence: 0.6,
    };

    const res = await runJudge(input, map, opts);

    // With overlap impl this will find it; currently (no overlap) the mock
    // never sees the full PII in any chunk so returns [] always.
    expect(res.errorReason).toBeNull();
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text).toBe(pii);
    expect((res as any).chunksTotal).toBe(2);
    // The aware mock was consulted at least once (actually twice).
    expect(client.callCount).toBeGreaterThanOrEqual(1);
  });
});

/**
 * TDD tests for JDG-09: multi-chunk happy paths exercised via direct MockLlmClient arrays.
 * Written (and run for RED) *before* touching the route seam in server/routes/judge.ts.
 * These cover the chunking logic (accumulation, maxSpans early exit without consuming
 * extra responses, cross-chunk dedup via seen Set) that previously had no dedicated
 * happy-path coverage for multi-chunk inputs >1800 chars.
 */
describe('runJudge — multi-chunk happy paths (accumulation, maxSpans saturation, dedup) [TDD RED before seam edit for JDG-09]', () => {
  // ~950 + ~950 > 1800 forces exactly 2 chunks with \n\n separator (see chunkText).
  const chunk1 = 'Please contact Aanya about the Korean migration. ' + 'A'.repeat(900);
  const chunk2 = 'Also reach Bob for the follow-up. ' + 'B'.repeat(900);
  const multiChunkInput = chunk1 + '\n\n' + chunk2;

  test('accumulation: unique spans from chunk 1 and chunk 2 are both kept in final result', async () => {
    const client = new MockLlmClient([
      llmJson([{ text: 'Aanya', category: 'person', confidence: 0.91, reason: 'given name chunk1' }]),
      llmJson([{ text: 'Bob', category: 'person', confidence: 0.87, reason: 'given name chunk2' }]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(multiChunkInput, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    expect((res as any).chunksTotal).toBe(2);
    expect(res.spans).toHaveLength(2);
    expect(res.spans[0].text).toBe('Aanya');
    expect(res.spans[1].text).toBe('Bob');
  });

  test('maxSpans saturation: when first chunk supplies maxSpans, second chunk is never invoked (pending responses preserved)', async () => {
    const client = new MockLlmClient([
      // first chunk returns exactly 3 spans (we cap at 3)
      llmJson([
        { text: 'Name0', category: 'person', confidence: 0.9, reason: 'r0' },
        { text: 'Name1', category: 'person', confidence: 0.9, reason: 'r1' },
        { text: 'Name2', category: 'person', confidence: 0.9, reason: 'r2' },
      ]),
      // sentinel for chunk 2 — must remain unconsumed
      llmJson([{ text: 'ShouldNotAppear', category: 'person', confidence: 0.9, reason: 'r' }]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(multiChunkInput, map, makeOpts(client, { maxSpans: 3 }));
    expect(res.spans).toHaveLength(3);
    expect(res.spans.map(s => s.text)).toEqual(['Name0', 'Name1', 'Name2']);
    // second response was never popped because loop bailed on spans.length >= maxSpans before second runChunk
    expect(client.pending).toBe(1);
  });

  test('dedup across chunks: identical span.text from chunk1 + chunk2 is stored only once', async () => {
    const client = new MockLlmClient([
      llmJson([{ text: 'RepeatedPII', category: 'person', confidence: 0.95, reason: 'seen in chunk1' }]),
      llmJson([{ text: 'RepeatedPII', category: 'person', confidence: 0.8, reason: 'seen again in chunk2' }]),
    ]);
    const map = new ScrubMap();
    const res = await runJudge(multiChunkInput, map, makeOpts(client));
    expect(res.errorReason).toBeNull();
    expect((res as any).chunksTotal).toBe(2);
    expect(res.spans).toHaveLength(1);
    expect(res.spans[0].text).toBe('RepeatedPII');
    expect(res.spans[0].reason).toBe('seen in chunk1'); // first one wins
  });
});

describe('chunkText — no dropped tail (JDG-02 / #66)', () => {
  const MAX = 1800;

  test('single-pass short input is returned whole', () => {
    const text = 'a'.repeat(50);
    expect(judgeInternals.chunkText(text, MAX)).toEqual([text]);
  });

  test('a sub-MIN_INPUT_LENGTH trailing remainder is NOT dropped', () => {
    // Build word-separated input (so the word-boundary cut works) that splits
    // into one full chunk plus a short tail (< 24 chars) holding a full email.
    // The tail was previously silently dropped (JDG-02).
    const head = ('word '.repeat(380)).trim(); // ~1899 chars, well over MAX
    const tail = 'joe@acme.com'; // 12 chars, < MIN_INPUT_LENGTH (24)
    const text = `${head} ${tail}`;

    const chunks = judgeInternals.chunkText(text, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    // Every character of the tail must appear in some chunk.
    expect(chunks.some((c) => c.includes(tail))).toBe(true);
  });

  test('concatenated chunk content covers the whole input (no gaps from a short tail)', () => {
    const head = ('alpha '.repeat(320)).trim(); // ~1919 chars
    const tail = 'TAILMARKER'; // 10-char short tail
    const text = `${head} ${tail}`;
    const chunks = judgeInternals.chunkText(text, MAX);
    expect(chunks.length).toBeGreaterThan(1);
    // The entire short tail survives chunking.
    expect(chunks.join(' ')).toContain(tail);
  });
});
