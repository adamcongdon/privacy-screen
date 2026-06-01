/**
 * Global app state — Zustand.
 *
 * Architectural rule (privacy-critical): the *content* fields hold tokenized
 * text. Real PII is only ever materialized at render time via deanonymize().
 * That means:
 *   - composerText is plain user input (pre-scrub) — never sent to a provider.
 *   - scrubbed is post-scrub text — what we display in the preview pane.
 *   - messages[*].content_tokens is what we sent to the server (tokenized).
 *   - assistantText is what the SSE stream returned — still tokenized.
 *
 * Tokens accumulate across the session. We merge new tokens into the union so
 * de-anonymization can resolve a token even if it was minted in a prior turn.
 */

import { create } from 'zustand';
import {
  api,
  type Token,
  type UnsureSpan,
  type ReviewItem,
  type VocabRow,
  type SettingsView,
  type SettingsPatch,
  type UploadedFile,
  type ChatMessage,
  type InducedPatternDto,
} from './api';

export type FileChip = {
  id: string;
  name: string;
  size: number;
  mime: string;
  scrubbed?: string;
  tokens?: Token[];
  hasCredentials?: boolean;
  credentialSnippets?: string[];
  error?: string;
};

export type SessionMessage = {
  role: 'user' | 'assistant';
  /** Always-tokenized content. Real values never live here. */
  content_tokens: string;
};

export type ToastEntry = {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
};

export type PreviewMode = 'source' | 'rendered';

const LS_PREVIEW_MODE = 'ps.preview-mode';
const LS_TOKENMAP_OPEN = 'ps.tokenmap-open';

function readLsPreviewMode(): PreviewMode {
  try {
    const v = globalThis.localStorage?.getItem(LS_PREVIEW_MODE);
    return v === 'rendered' ? 'rendered' : 'source';
  } catch {
    return 'source';
  }
}

function readLsTokenMapOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LS_TOKENMAP_OPEN) === '1';
  } catch {
    return false;
  }
}

function writeLs(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // ignore quota/availability errors
  }
}

type State = {
  // Composer
  composerText: string;
  // Files
  files: FileChip[];

  // Scrub preview state (always reflects the *current* composer + file payload)
  scrubbed: string;
  tokens: Token[];
  unsureSpans: UnsureSpan[];
  hasCredentials: boolean;
  credentialSnippets: string[];
  isScrubbing: boolean;
  scrubError: string | null;

  // Conversation
  messages: SessionMessage[];
  /** Live assistant chunk currently being streamed (tokenized). */
  assistantStreaming: string;
  isStreaming: boolean;
  streamError: string | null;

  // Token union — every token we've ever seen this session, for deanon lookups
  tokenUnion: Map<string, Token>;

  // UI flags
  showRawTokens: boolean;
  settingsOpen: boolean;
  /** Preview pane mode — source view (current behavior) or rendered HTML view. */
  previewMode: PreviewMode;
  /** True once the user has manually picked a preview mode this session; gates auto-default. */
  previewModeUserOverrode: boolean;
  /** Token Map slide-in drawer open/closed. Persisted to localStorage. */
  tokenMapOpen: boolean;

  // Server data
  vocab: VocabRow[];
  reviewItems: ReviewItem[];
  patterns: InducedPatternDto[];
  settings: SettingsView | null;
  health: { ok: boolean; version: string } | null;

  // Toasts
  toasts: ToastEntry[];

  // ── actions ──────────────────────────────────────────────────────────────
  setComposerText: (t: string) => void;
  setShowRawTokens: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  /** Explicit user pick — flips previewModeUserOverrode so auto-default stops fighting. */
  setPreviewMode: (m: PreviewMode) => void;
  /** Auto-default flip from payload kind. Does NOT set previewModeUserOverrode. */
  autoSetPreviewMode: (m: PreviewMode) => void;
  resetPreviewModeOverride: () => void;
  setTokenMapOpen: (o: boolean) => void;
  resetConversation: () => void;

  addFiles: (incoming: FileList | File[]) => Promise<void>;
  removeFile: (id: string) => void;

  /** Build the payload string that gets sent to the model (composer + files). */
  buildPayload: () => string;

  refreshScrub: () => Promise<void>;
  refreshVocab: () => Promise<void>;
  refreshReview: () => Promise<void>;
  refreshPatterns: () => Promise<void>;
  suggestPatterns: (category?: string) => Promise<void>;
  patternAction: (id: number, action: 'activate' | 'reject' | 'edit', regex?: string) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshHealth: () => Promise<void>;

  saveSettings: (partial: SettingsPatch) => Promise<void>;
  reviewAction: (
    id: number,
    action: 'confirm' | 'allowlist' | 'ignore',
    type?: string,
  ) => Promise<void>;
  addCustomerName: (name: string) => Promise<void>;
  forgetVocab: (realValue: string) => Promise<void>;
  /** Mint a selected span as a specific category — drives the context-menu UX. */
  mintSelection: (value: string, category: string) => Promise<void>;

  send: () => Promise<void>;
  abortSend: () => void;

  pushToast: (kind: ToastEntry['kind'], message: string) => void;
  dismissToast: (id: number) => void;
};

// Module-level so the AbortController survives state recreations and store
// resets without becoming part of the React-reactive surface.
let activeAbort: AbortController | null = null;
let toastCounter = 1;

function mergeTokenUnion(prev: Map<string, Token>, incoming: Token[]): Map<string, Token> {
  if (incoming.length === 0) return prev;
  const next = new Map(prev);
  for (const tok of incoming) {
    if (!tok || !tok.token) continue;
    next.set(tok.token, tok);
  }
  return next;
}

function fileChipFromUploaded(u: UploadedFile, id: string): FileChip {
  return {
    id,
    name: u.name,
    size: u.size,
    mime: u.mime,
    scrubbed: u.scrubbed,
    tokens: u.tokens,
    hasCredentials: u.hasCredentials,
    credentialSnippets: u.credentialSnippets,
    error: u.error,
  };
}

export const useStore = create<State>((set, get) => ({
  composerText: '',
  files: [],

  scrubbed: '',
  tokens: [],
  unsureSpans: [],
  hasCredentials: false,
  credentialSnippets: [],
  isScrubbing: false,
  scrubError: null,

  messages: [],
  assistantStreaming: '',
  isStreaming: false,
  streamError: null,

  tokenUnion: new Map(),

  showRawTokens: true,
  settingsOpen: false,
  previewMode: readLsPreviewMode(),
  previewModeUserOverrode: false,
  tokenMapOpen: readLsTokenMapOpen(),

  vocab: [],
  reviewItems: [],
  patterns: [],
  settings: null,
  health: null,

  toasts: [],

  setComposerText: (t) => set({ composerText: t }),
  setShowRawTokens: (v) => set({ showRawTokens: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  setPreviewMode: (m) => {
    writeLs(LS_PREVIEW_MODE, m);
    set({ previewMode: m, previewModeUserOverrode: true });
  },
  autoSetPreviewMode: (m) => {
    const { previewMode, previewModeUserOverrode } = get();
    if (previewModeUserOverrode) return;
    if (previewMode === m) return;
    writeLs(LS_PREVIEW_MODE, m);
    set({ previewMode: m });
  },
  resetPreviewModeOverride: () => set({ previewModeUserOverrode: false }),

  setTokenMapOpen: (o) => {
    writeLs(LS_TOKENMAP_OPEN, o ? '1' : '0');
    set({ tokenMapOpen: o });
  },

  resetConversation: () =>
    set({
      messages: [],
      assistantStreaming: '',
      streamError: null,
      isStreaming: false,
    }),

  pushToast: (kind, message) => {
    const id = toastCounter++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    // Auto-dismiss errors after 6s, others after 3.5s.
    const ttl = kind === 'error' ? 6000 : 3500;
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  buildPayload: () => {
    const { composerText, files } = get();
    const parts: string[] = [];
    if (composerText.trim()) parts.push(composerText);
    for (const f of files) {
      if (f.error) continue;
      if (typeof f.scrubbed === 'string' && f.scrubbed.length > 0) {
        parts.push(`\n--- file: ${f.name} ---\n${f.scrubbed}`);
      }
    }
    return parts.join('\n');
  },

  addFiles: async (incoming) => {
    const list = Array.from(incoming as ArrayLike<File>);
    if (list.length === 0) return;
    try {
      const res = await api.uploadFiles(list);
      const chips: FileChip[] = [];
      const idBase = Date.now();
      let i = 0;
      const newTokens: Token[] = [];
      for (const u of res.files) {
        const id = `f${idBase}-${i++}`;
        chips.push(fileChipFromUploaded(u, id));
        if (u.tokens) newTokens.push(...u.tokens);
      }
      set((s) => ({
        files: [...s.files, ...chips],
        tokenUnion: mergeTokenUnion(s.tokenUnion, newTokens),
      }));
      // Refresh scrub so preview reflects any new tokens introduced by files.
      void get().refreshScrub();
      for (const chip of chips) {
        if (chip.error) get().pushToast('error', `${chip.name}: ${chip.error}`);
        else if (chip.hasCredentials)
          get().pushToast('error', `${chip.name}: credential detected — review before sending`);
        else get().pushToast('success', `${chip.name} scrubbed (${chip.size}B)`);
      }
    } catch (err) {
      get().pushToast('error', `upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  removeFile: (id) => {
    set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
    void get().refreshScrub();
  },

  refreshScrub: async () => {
    const payload = get().buildPayload();
    if (!payload.trim()) {
      set({
        scrubbed: '',
        tokens: [],
        unsureSpans: [],
        hasCredentials: false,
        credentialSnippets: [],
        isScrubbing: false,
        scrubError: null,
      });
      return;
    }
    set({ isScrubbing: true, scrubError: null });
    try {
      const r = await api.scrub(payload, false);
      set((s) => ({
        scrubbed: r.scrubbed,
        tokens: r.tokens,
        unsureSpans: r.unsureSpans,
        hasCredentials: r.hasCredentials,
        credentialSnippets: r.credentialSnippets,
        isScrubbing: false,
        tokenUnion: mergeTokenUnion(s.tokenUnion, r.tokens),
      }));
    } catch (err) {
      set({
        isScrubbing: false,
        scrubError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshVocab: async () => {
    try {
      const r = await api.vocab();
      set({ vocab: r.rows });
    } catch (err) {
      get().pushToast('error', `vocab fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  refreshReview: async () => {
    try {
      const r = await api.review();
      set({ reviewItems: r.items });
    } catch (err) {
      get().pushToast('error', `review fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  refreshPatterns: async () => {
    try {
      const r = await (api as typeof api & { listPatterns(s?: string): Promise<{ items: InducedPatternDto[] }> }).listPatterns();
      set({ patterns: r.items });
    } catch (err) {
      get().pushToast('error', `patterns fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  suggestPatterns: async (category?: string) => {
    try {
      const r = await (api as typeof api & { suggestPatterns(c?: string): Promise<{ items: InducedPatternDto[] }> }).suggestPatterns(category);
      set({ patterns: r.items });
      get().pushToast('success', `${r.items.length} pattern(s) suggested`);
    } catch (err) {
      get().pushToast('error', `suggest failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  patternAction: async (id, action, regex?) => {
    try {
      await (api as typeof api & { patternAction(id: number, a: string, r?: string): Promise<{ ok: true }> }).patternAction(id, action, regex);
      await get().refreshPatterns();
      if (action === 'activate') {
        await Promise.all([get().refreshVocab(), get().refreshScrub()]);
      }
      get().pushToast('success', `pattern ${action}d`);
    } catch (err) {
      get().pushToast('error', `pattern action failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  refreshSettings: async () => {
    try {
      const s = await api.settings();
      set({ settings: s });
    } catch (err) {
      get().pushToast('error', `settings fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  refreshHealth: async () => {
    try {
      const h = await api.health();
      set({ health: h });
    } catch (err) {
      get().pushToast('error', `server unreachable: ${err instanceof Error ? err.message : err}`);
    }
  },

  saveSettings: async (partial) => {
    try {
      const s = await api.saveSettings(partial);
      set({ settings: s });
      get().pushToast('success', 'settings saved');
    } catch (err) {
      get().pushToast('error', `settings save failed: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  },

  reviewAction: async (id, action, type) => {
    try {
      await api.reviewAction(id, action, type);
      await Promise.all([get().refreshReview(), get().refreshVocab(), get().refreshScrub()]);
      get().pushToast('success', `review item ${action}d`);
    } catch (err) {
      get().pushToast('error', `review action failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  addCustomerName: async (name) => {
    await get().mintSelection(name, 'customer');
  },

  mintSelection: async (value, category) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const cat = category.trim().toLowerCase();
    if (!cat) return;
    try {
      const res = await api.addVocab(trimmed, cat);
      get().pushToast('success', `Added '${trimmed}' as ${res.token}`);
      await Promise.all([get().refreshVocab(), get().refreshScrub()]);
    } catch (err) {
      get().pushToast(
        'error',
        `mint failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  forgetVocab: async (realValue) => {
    try {
      await api.forgetVocab(realValue);
      await Promise.all([get().refreshVocab(), get().refreshScrub()]);
      get().pushToast('success', `forgot "${realValue}"`);
    } catch (err) {
      get().pushToast(
        'error',
        `forget failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  send: async () => {
    const state = get();
    if (state.isStreaming) return;
    const payload = state.buildPayload();
    if (!payload.trim()) {
      get().pushToast('error', 'composer is empty');
      return;
    }
    if (state.hasCredentials) {
      get().pushToast('error', 'credential detected — cannot send');
      return;
    }

    // Step 1: persist-scrub the payload to lock in tokens for the conversation.
    let scrubbedPayload: string;
    let mintedTokens: Token[];
    try {
      const r = await api.scrub(payload, true);
      if (r.hasCredentials) {
        set({
          hasCredentials: true,
          credentialSnippets: r.credentialSnippets,
          scrubbed: r.scrubbed,
          tokens: r.tokens,
        });
        get().pushToast('error', 'credential detected during send — aborted');
        return;
      }
      scrubbedPayload = r.scrubbed;
      mintedTokens = r.tokens;
    } catch (err) {
      get().pushToast(
        'error',
        `scrub-before-send failed: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    // Step 2: append the user message to history (always tokenized).
    const history = [...state.messages];
    history.push({ role: 'user', content_tokens: scrubbedPayload });
    const wireMessages: ChatMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content_tokens,
    }));

    set((s) => ({
      messages: history,
      assistantStreaming: '',
      streamError: null,
      isStreaming: true,
      tokenUnion: mergeTokenUnion(s.tokenUnion, mintedTokens),
      composerText: '',
      files: [],
      scrubbed: '',
      tokens: [],
      unsureSpans: [],
      hasCredentials: false,
      credentialSnippets: [],
    }));

    // Step 3: open SSE.
    activeAbort = new AbortController();
    const model = state.settings?.model;

    await api.send(
      { messages: wireMessages, model, signal: activeAbort.signal },
      {
        onText: (delta) => {
          set((s) => ({ assistantStreaming: s.assistantStreaming + delta }));
        },
        onError: (message) => {
          set({ streamError: message, isStreaming: false });
          get().pushToast('error', `stream error: ${message}`);
        },
        onDone: () => {
          set((s) => ({
            messages: [...s.messages, { role: 'assistant', content_tokens: s.assistantStreaming }],
            assistantStreaming: '',
            isStreaming: false,
          }));
          // Pick up any tokens that the server might have minted during /api/send.
          void get().refreshReview();
          void get().refreshVocab();
        },
      },
    );
    activeAbort = null;
  },

  abortSend: () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    set({ isStreaming: false });
  },
}));
