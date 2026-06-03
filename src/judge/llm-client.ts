/**
 * LLM client abstraction for the judge.
 *
 * `LlmClient` is the I/O seam — everything in `judge.ts` runs against the
 * interface so the judge is unit-testable without spawning a model or hitting
 * the network. `MockLlmClient` scripts responses for tests. `LlamaServerClient`
 * talks to llama.cpp's OpenAI-compatible HTTP endpoint and is the real
 * production path.
 */

/** Single completion request — system prompt, user prompt, and budgets. */
export interface LlmCompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/** Minimal completion interface. Returns the raw JSON string from the model. */
export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<string>;
}

/**
 * Test double. Pops a response off the front of `responses` per call. If the
 * head is an `Error`, it's thrown. If the queue is empty, throws so tests fail
 * loudly rather than silently passing.
 */
export class MockLlmClient implements LlmClient {
  constructor(private responses: Array<string | Error>) {}

  /** Pop the next scripted response (or throw the scripted error). */
  complete(_req: LlmCompletionRequest): Promise<string> {
    const next = this.responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('MockLlmClient: response queue empty'));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }

  /** Test helper: how many scripted responses are still queued. */
  get pending(): number {
    return this.responses.length;
  }
}

/** Constructor options for `LlamaServerClient`. */
export interface LlamaServerOptions {
  /** Base URL of the llama-server, e.g. `http://127.0.0.1:8080`. Loopback only. */
  endpoint: string;
  /** Injectable fetch implementation for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Real client. POSTs to llama.cpp's OpenAI-compatible `/v1/chat/completions`
 * with structured JSON output enforced via `response_format`. Refuses any
 * non-loopback endpoint to prevent misconfig from leaking PII off-box.
 */
export class LlamaServerClient implements LlmClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LlamaServerOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Issue one chat-completion call. Throws on non-loopback endpoint, non-2xx
   * response, network failure, or malformed response shape.
   */
  async complete(req: LlmCompletionRequest): Promise<string> {
    this.assertLoopback(this.endpoint);

    const body = {
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: 0,
      frequency_penalty: 0.3,
      response_format: { type: 'json_object' },
    };

    const url = `${this.endpoint}/v1/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`llm-client: HTTP ${res.status} from llama-server`);
    }

    const json: unknown = await res.json();
    const content = extractChoiceContent(json);
    if (content === null) {
      throw new Error('llm-client: malformed response shape from llama-server');
    }
    return content;
  }

  /** Parse host from URL and refuse anything outside the loopback allowlist. */
  private assertLoopback(endpoint: string): void {
    let host: string;
    try {
      host = new URL(endpoint).hostname;
    } catch {
      throw new Error('llm-client: refusing non-loopback endpoint');
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error('llm-client: refusing non-loopback endpoint');
    }
  }
}

/**
 * Narrow `unknown` JSON down to `choices[0].message.content: string`, or null
 * if any step fails. Pure helper, no throwing.
 */
function extractChoiceContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}
