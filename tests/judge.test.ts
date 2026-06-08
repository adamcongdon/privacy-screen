/**
 * Judge module tests — pure logic with mocked LLM client.
 * Covers happy path, error paths, filtering rules, category normalization,
 * and the loopback-only guard on `LlamaServerClient`.
 */
import { describe, test, expect } from 'bun:test';
import { ScrubMap } from '../src/scrub-map';
import { runJudge, type JudgeOptions } from '../src/judge/judge';
import {
  MockLlmClient,
  LlamaServerClient,
  type LlmCompletionRequest,
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
  test('client throw → spans=[] with parse_failed errorReason', async () => {
    const client = new MockLlmClient([new Error('aborted')]);
    const map = new ScrubMap();
    const res = await runJudge(LONG_INPUT, map, makeOpts(client));
    expect(res.spans).toEqual([]);
    expect(res.errorReason).not.toBeNull();
    expect(res.errorReason!.startsWith('parse_failed')).toBe(true);
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
