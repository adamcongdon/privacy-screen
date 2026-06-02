/**
 * Typed API client for the privacy-screen backend.
 *
 * All requests are relative ("/api/...") — Vite dev proxies to :31338 and the
 * production bundle is served by the same Hono process, so same-origin always
 * holds. No CORS surprises, no hardcoded hosts.
 */

export type Token = {
  realValue: string;
  token: string;
  isNew: boolean;
  category: string;
  confidence?: number | null;
};

export type UnsureSpan = {
  span: string;
  surrounding: string;
  suggestedCategory: string;
  confidence: number;
};

export type ScrubResponse = {
  scrubbed: string;
  tokens: Token[];
  unsureSpans: UnsureSpan[];
  hasCredentials: boolean;
  credentialSnippets: string[];
  modified: boolean;
};

export type VocabRow = {
  real_value: string;
  token: string;
  category: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
  hit_count: number;
  confirmed_by: string | null;
};

export type ReviewItem = {
  id: number;
  span: string;
  surrounding: string;
  suggested_cat: string | null;
  confidence: number;
  source_event: string | null;
};

export type SettingsView = {
  model: string;
  system_prompt: string;
  claude_code: {
    found: boolean;
    version: string | null;
    error?: string;
  };
};

export type SettingsPatch = Partial<{
  model: string;
  system_prompt: string;
}>;

export type UploadedFile = {
  name: string;
  size: number;
  mime: string;
  original?: string;
  scrubbed?: string;
  tokens?: Token[];
  hasCredentials?: boolean;
  credentialSnippets?: string[];
  unsureSpans?: UnsureSpan[];
  error?: string;
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type SseHandlers = {
  onText: (delta: string) => void;
  onDone: (usage: unknown) => void;
  onError: (message: string) => void;
};

export type SendOptions = {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — fall through to error.
    }
  }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed as T;
}

export const api = {
  async health(): Promise<{ ok: boolean; version: string }> {
    return json(await fetch('/api/health'));
  },

  async scrub(text: string, persist = false): Promise<ScrubResponse> {
    const res = await fetch('/api/scrub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, persist }),
    });
    return json<ScrubResponse>(res);
  },

  async vocab(category?: string): Promise<{ rows: VocabRow[] }> {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return json(await fetch(`/api/vocab${q}`));
  },

  async addVocab(
    realValue: string,
    category = 'customer',
  ): Promise<{ realValue: string; token: string; isNew: boolean }> {
    const res = await fetch('/api/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realValue, category }),
    });
    return json(res);
  },

  async forgetVocab(realValue: string): Promise<{ ok: boolean }> {
    return json(
      await fetch(`/api/vocab/${encodeURIComponent(realValue)}`, { method: 'DELETE' }),
    );
  },

  async allowlist(pattern: string, isRegex = false): Promise<{ ok: true }> {
    const res = await fetch('/api/vocab/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, isRegex }),
    });
    return json(res);
  },

  async review(): Promise<{ items: ReviewItem[] }> {
    return json(await fetch('/api/review'));
  },

  async reviewAction(
    id: number,
    action: 'confirm' | 'allowlist' | 'ignore',
    type?: string,
  ): Promise<{ ok: true; token?: string }> {
    const res = await fetch(`/api/review/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, type }),
    });
    return json(res);
  },

  async settings(): Promise<SettingsView> {
    return json(await fetch('/api/settings'));
  },

  async saveSettings(patch: SettingsPatch): Promise<SettingsView> {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return json(res);
  },

  async uploadFiles(files: File[]): Promise<{ files: UploadedFile[] }> {
    const form = new FormData();
    for (const f of files) form.append('file', f);
    const res = await fetch('/api/files', { method: 'POST', body: form });
    return json(res);
  },

  /**
   * Stream the Anthropic response via SSE.
   *
   * Uses fetch + ReadableStream because EventSource cannot send a POST body.
   * Frames are parsed by splitting on blank lines, then matching `event:` and
   * `data:` lines per the SSE spec. Each frame's data is JSON-parsed, then
   * routed to the appropriate handler. Returns when the stream closes.
   */
  async send(opts: SendOptions, handlers: SseHandlers): Promise<void> {
    const { messages, model, maxTokens, signal } = opts;
    let res: Response;
    try {
      res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages, model, maxTokens }),
        signal,
      });
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!res.ok) {
      // Try to surface server JSON error message.
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body === 'object') {
          if ('message' in body && typeof body.message === 'string') msg = body.message;
          else if ('error' in body && typeof body.error === 'string') msg = body.error;
        }
      } catch {
        // Non-JSON; keep the status code message.
      }
      handlers.onError(msg);
      return;
    }

    if (!res.body) {
      handlers.onError('no response body');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const flushFrame = (rawFrame: string): boolean => {
      // Returns false if the frame signaled done/error and the caller should stop.
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of rawFrame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length === 0) return true;
      const dataStr = dataLines.join('\n');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        // Server promises JSON; if we get garbage we surface it as error and stop.
        handlers.onError(`malformed SSE data: ${dataStr.slice(0, 80)}`);
        return false;
      }
      if (event === 'text' && parsed && typeof parsed === 'object' && 'delta' in parsed) {
        const delta = (parsed as { delta: unknown }).delta;
        if (typeof delta === 'string') handlers.onText(delta);
        return true;
      }
      if (event === 'done') {
        handlers.onDone(parsed);
        return false;
      }
      if (event === 'error' && parsed && typeof parsed === 'object' && 'message' in parsed) {
        handlers.onError(String((parsed as { message: unknown }).message));
        return false;
      }
      return true;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
        let sepIdx: number;
        while (
          (sepIdx = buffer.indexOf('\n\n')) !== -1 ||
          (sepIdx = buffer.indexOf('\r\n\r\n')) !== -1
        ) {
          const isCrlf = buffer.startsWith('\r\n\r\n', sepIdx);
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + (isCrlf ? 4 : 2));
          const keepGoing = flushFrame(frame);
          if (!keepGoing) {
            try {
              await reader.cancel();
            } catch {
              // Ignore — stream already closed.
            }
            return;
          }
        }
      }
      // Drain any final frame missing trailing blank line.
      const tail = buffer.trim();
      if (tail) flushFrame(tail);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      handlers.onError(err instanceof Error ? err.message : String(err));
    }
  },

  async listPatterns(status?: string): Promise<{ items: InducedPatternDto[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return json(await fetch(`/api/patterns${q}`));
  },

  async suggestPatterns(category?: string): Promise<{ items: InducedPatternDto[] }> {
    const res = await fetch('/api/patterns/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(category ? { category } : {}),
    });
    return json(res);
  },

  async patternAction(
    id: number,
    action: 'activate' | 'reject' | 'edit',
    regex?: string,
  ): Promise<{ ok: true }> {
    const res = await fetch(`/api/patterns/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regex !== undefined ? { action, regex } : { action }),
    });
    return json(res);
  },

  async deletePattern(id: number): Promise<{ ok: true }> {
    return json(await fetch(`/api/patterns/${id}`, { method: 'DELETE' }));
  },
};

export type InducedPatternDto = {
  id: number;
  category: string;
  regex_source: string;
  skeleton: string;
  source_examples: string[];
  example_count: number;
  confidence: number;
  status: string;
  hit_count: number;
  first_seen: number;
  last_seen: number;
};

// ─── LLM judge control ────────────────────────────────────────────────────────

export type JudgeStatus = {
  config: {
    enabled: boolean;
    model_path: string | null;
    endpoint: string | null;
    runtime: string;
    max_tokens: number;
    timeout_ms: number;
    min_confidence: number;
  };
  runtime: { installed: boolean; path: string | null };
  model: { installed: boolean; path: string | null; bytes: number | null };
  available_models: Array<{
    name: string;
    url: string;
    expected_size_bytes: number;
    description: string;
  }>;
  process: { state: string; detail: string | null };
  install: {
    active: boolean;
    modelName: string | null;
    bytesDownloaded: number;
    totalBytes: number;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    destPath: string | null;
  };
};

export const judgeApi = {
  async status(): Promise<JudgeStatus> {
    return json(await fetch('/api/judge-control/status'));
  },
  async setEnabled(enabled: boolean): Promise<{ ok: boolean }> {
    const res = await fetch('/api/judge-control/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return json(res);
  },
  async install(model: string): Promise<{ ok: boolean }> {
    const res = await fetch('/api/judge-control/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    return json(res);
  },
};

export { ApiError };
