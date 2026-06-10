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
  judgeApi,
  type Token,
  type UnsureSpan,
  type ReviewItem,
  type VocabRow,
  type SettingsView,
  type SettingsPatch,
  type UploadedFile,
  type ChatMessage,
  type InducedPatternDto,
  type JudgeStatus,
  type XlsxInspectionEntry,
  type XlsxSheetInspection,
  type XlsxCommitOverrides,
} from './api';

export type FileChip = {
  id: string;
  name: string;
  size: number;
  mime: string;
  original?: string;
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

/**
 * Pending xlsx review state — #23 Segment 3C3.
 *
 * Set by `addFiles` when the server returns an `XlsxInspectionEntry`. The
 * `XlsxColumnReview` modal renders iff this is non-null. Cleared on commit
 * success or explicit cancel.
 *
 * **Concurrency policy**: only one review may be active at a time. If a
 * user drops multiple xlsx files, the first becomes the active review and
 * the rest are toasted as "ignored — review the current one first". This
 * keeps the UX linear and avoids juggling staged uploads in the store; a
 * dropped xlsx that wasn't shown is also dropped server-side once the
 * staging TTL expires (~5 min).
 */
export type PendingXlsx = {
  uploadId: string;
  fileName: string;
  size: number;
  sheets: XlsxSheetInspection[];
};

export type PendingXlsxPayload = PendingXlsx;

// Async feedback job types — polled by the UI to surface filing progress.
export type JobStatus = 'queued' | 'drafting' | 'filing' | 'done' | 'error';
export type FeedbackJobState = {
  jobId: string;
  status: JobStatus;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
};

export type PreviewMode = 'source' | 'rendered';

const LS_PREVIEW_MODE = 'ps.preview-mode';
const LS_TOKENMAP_OPEN = 'ps.tokenmap-open';
const LS_DISMISSED_UPDATE = 'ps.dismissed-update-version';

/**
 * Periodic version-poll cadence. 4 hours — quiet enough to be invisible, frequent
 * enough that beta builds catch each other within a working session. Module-level
 * + greppable so tests and ops folks can find the knob fast.
 */
export const VERSION_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Test seam: lets the test suite shorten the interval to something measurable
 * (e.g. 10 ms) without bending the production cadence. Production code should
 * never call this — only tests/update-poll.test.ts via the `__test_` export.
 */
let versionPollIntervalMsOverride: number | null = null;
export function __test_setVersionPollIntervalMs(ms: number | null): void {
  versionPollIntervalMsOverride = ms;
}

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

function readLsDismissedUpdate(): string | null {
  try {
    return globalThis.localStorage?.getItem(LS_DISMISSED_UPDATE) ?? null;
  } catch {
    return null;
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
  /** Send-feedback dialog open/closed. Not persisted — ephemeral per session. */
  feedbackOpen: boolean;

  // Server data
  vocab: VocabRow[];
  reviewItems: ReviewItem[];
  patterns: InducedPatternDto[];
  settings: SettingsView | null;
  health: { ok: boolean; version: string } | null;
  judgeStatus: JudgeStatus | null;
  isJudging: boolean;

  // Update (beta/stable channel + download/apply)
  versionInfo: Awaited<ReturnType<typeof api.version>> | null;
  updateStatus: Awaited<ReturnType<typeof api.updateStatus>> | null;
  /**
   * Version string the user has explicitly dismissed for the update banner.
   * Hydrated from localStorage on init; persists across reloads so a "no thanks"
   * sticks until a NEWER version ships.
   */
  dismissedUpdateVersion: string | null;
  /**
   * Drives the SettingsDrawer to auto-scroll/highlight a specific section when
   * opened from a deep-link (e.g. the global UpdateAvailableBanner). The drawer
   * is responsible for consuming this and clearing it.
   */
  settingsDeepLink: 'update' | null;

  // Toasts
  toasts: ToastEntry[];

  // Active async feedback job (polled state from the backend)
  activeFeedbackJob: FeedbackJobState | null;

  /** Pending xlsx column review — null when no xlsx awaiting commit (#23). */
  pendingXlsx: PendingXlsx | null;

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
  setFeedbackOpen: (o: boolean) => void;
  resetConversation: () => void;

  addFiles: (incoming: FileList | File[]) => Promise<void>;
  removeFile: (id: string) => void;

  /** Build the payload string that gets sent to the model (composer + files). */
  buildPayload: (useOriginal?: boolean) => string;

  refreshScrub: (opts?: { skipJudge?: boolean }) => Promise<void>;
  refreshVocab: () => Promise<void>;
  refreshReview: () => Promise<void>;
  refreshPatterns: () => Promise<void>;
  suggestPatterns: (category?: string) => Promise<void>;
  patternAction: (id: number, action: 'activate' | 'reject' | 'edit', regex?: string) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshJudgeStatus: () => Promise<void>;
  setJudgeEnabled: (enabled: boolean) => Promise<void>;
  installJudgeModel: (model: string) => Promise<void>;

  refreshVersion: () => Promise<void>;
  refreshUpdateStatus: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;

  /**
   * Start the periodic version poller. No-op if already running OR if the
   * current update_channel is 'off' — defense in depth alongside the server's
   * channel=off short-circuit in routes/version.ts.
   */
  startVersionPoller: () => void;
  stopVersionPoller: () => void;
  dismissUpdate: (version: string) => void;
  setSettingsDeepLink: (target: 'update' | null) => void;

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

  // Async feedback job actions
  startFeedbackJob: (jobId: string) => void;
  setFeedbackJobState: (state: FeedbackJobState) => void;
  clearFeedbackJob: () => void;

  // Xlsx review actions (#23)
  startXlsxReview: (payload: PendingXlsxPayload) => void;
  clearXlsxReview: () => void;
  /**
   * POST /api/files/xlsx/commit using the active pendingXlsx.uploadId + the
   * caller-supplied overrides. On 200, triggers a browser download of the
   * scrubbed bytes via a synthetic anchor, toasts success, and clears the
   * review. On error: toasts and leaves pendingXlsx intact so the user can
   * adjust selections and retry.
   */
  commitXlsxReview: (overrides: XlsxCommitOverrides) => Promise<void>;
};

// Module-level so the AbortController survives state recreations and store
// resets without becoming part of the React-reactive surface.
let activeAbort: AbortController | null = null;
let toastCounter = 1;
let judgePollerRef: ReturnType<typeof setInterval> | null = null;
let updatePollerRef: ReturnType<typeof setInterval> | null = null;
let versionPollerRef: ReturnType<typeof setInterval> | null = null;
const MIN_JUDGE_PAYLOAD = 24;

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
    original: u.original,
    scrubbed: u.scrubbed,
    tokens: u.tokens,
    hasCredentials: u.hasCredentials,
    credentialSnippets: u.credentialSnippets,
    error: u.error,
  };
}

export const useStore = create<State>((set, get) => {
  // Start polling /api/judge-control/status every 2s until activeRequests drops
  // to 0. Only one poller runs at a time. Clears isJudging and refreshes the
  // review queue when the judge finishes.
  const startJudgePoller = () => {
    if (judgePollerRef !== null) return;
    const stopPoller = () => {
      clearInterval(judgePollerRef!);
      judgePollerRef = null;
      set({ isJudging: false });
    };
    let polls = 0;
    judgePollerRef = setInterval(() => {
      polls++;
      // 30 polls × 2 s = 60 s max — prevents stuck indicator if server crashes.
      if (polls > 30) { stopPoller(); return; }
      void judgeApi.status().then((status) => {
        // Only update store if activeRequests changed — avoids spurious re-renders.
        if (status.activeRequests !== get().judgeStatus?.activeRequests) {
          set({ judgeStatus: status });
        }
        if (status.activeRequests === 0) {
          stopPoller();
          void get().refreshReview();
        }
      }).catch(() => { /* ignore poll failures */ });
    }, 2000);
  };

  // Poll /api/update/status while a download is active. Stops when active goes false
  // or after a safety cap. Refreshes the versionInfo too so the UI can react.
  const startUpdatePoller = () => {
    if (updatePollerRef !== null) return;
    const stop = () => {
      if (updatePollerRef) clearInterval(updatePollerRef);
      updatePollerRef = null;
    };
    let polls = 0;
    updatePollerRef = setInterval(() => {
      polls++;
      if (polls > 120) { stop(); return; } // ~4 min max
      void get().refreshUpdateStatus().then(() => {
        const st = get().updateStatus;
        if (st && !st.download?.active) {
          stop();
          void get().refreshVersion();
        }
      }).catch(() => {});
    }, 1500);
  };

  return ({
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
  feedbackOpen: false,

  vocab: [],
  reviewItems: [],
  patterns: [],
  settings: null,
  health: null,
  judgeStatus: null,
  isJudging: false,

  versionInfo: null,
  updateStatus: null,
  dismissedUpdateVersion: readLsDismissedUpdate(),
  settingsDeepLink: null,

  toasts: [],

    // Active async feedback job, polled by useFeedbackJob
    activeFeedbackJob: null,

    // No xlsx awaiting column review at boot (#23).
    pendingXlsx: null,

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

  setFeedbackOpen: (o) => set({ feedbackOpen: o }),

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

  startFeedbackJob: (jobId) => set({ activeFeedbackJob: { jobId, status: 'queued' } }),
  setFeedbackJobState: (state) => set({ activeFeedbackJob: state }),
  clearFeedbackJob: () => set({ activeFeedbackJob: null }),

  buildPayload: (useOriginal = false) => {
    const { composerText, files } = get();
    const parts: string[] = [];
    if (composerText.trim()) parts.push(composerText);
    for (const f of files) {
      if (f.error) continue;
      const content = useOriginal && f.original ? f.original : f.scrubbed;
      if (typeof content === 'string' && content.length > 0) {
        parts.push(`\n--- file: ${f.name} ---\n${content}`);
      }
    }
    return parts.join('\n');
  },

  addFiles: async (incoming) => {
    const list = Array.from(incoming as ArrayLike<File>);
    if (list.length === 0) return;
    try {
      const res = await api.uploadFiles(list);

      // Partition: xlsx-inspection entries route to the review modal; everything
      // else (text + error rows) flows down the existing FileChip path.
      const xlsxEntries: XlsxInspectionEntry[] = [];
      const textEntries: UploadedFile[] = [];
      for (const entry of res.files) {
        if ('kind' in entry && entry.kind === 'xlsx-inspection') {
          xlsxEntries.push(entry);
        } else {
          // Discriminator absent → text-like UploadedFile (success or error row).
          textEntries.push(entry as UploadedFile);
        }
      }

      // ── Text path (unchanged behavior) ────────────────────────────────────
      const chips: FileChip[] = [];
      const idBase = Date.now();
      let i = 0;
      const newTokens: Token[] = [];
      for (const u of textEntries) {
        const id = `f${idBase}-${i++}`;
        chips.push(fileChipFromUploaded(u, id));
        if (u.tokens) newTokens.push(...u.tokens);
      }
      if (chips.length > 0) {
        set((s) => ({
          files: [...s.files, ...chips],
          tokenUnion: mergeTokenUnion(s.tokenUnion, newTokens),
        }));
        // Refresh scrub (skipJudge=true) so preview updates without double-firing
        // the judge — we fire it below using the upload response data directly.
        void get().refreshScrub({ skipJudge: true });
        // Fire judge for each clean file using the server's upload response data.
        const judgeChips = chips.filter(
          (c) => !c.error && !c.hasCredentials && c.scrubbed && c.scrubbed.length >= MIN_JUDGE_PAYLOAD,
        );
        for (const chip of judgeChips) {
          api.judgePost(chip.scrubbed!, chip.tokens ?? []);
        }
        if (judgeChips.length > 0) {
          set({ isJudging: true });
          startJudgePoller();
        }
        for (const chip of chips) {
          if (chip.error) get().pushToast('error', `${chip.name}: ${chip.error}`);
          else if (chip.hasCredentials)
            get().pushToast('error', `${chip.name}: credential detected — review before sending`);
          else get().pushToast('success', `${chip.name} scrubbed (${chip.size}B)`);
        }
      }

      // ── Xlsx path (#23 Segment 3C3) ───────────────────────────────────────
      // Surface the first xlsx as the active review. If the user already has a
      // pending review (e.g. they dropped xlsx files in back-to-back batches),
      // skip even the first of this batch — they need to resolve the in-flight
      // one first. Extras in either case get a toast so silence is impossible.
      if (xlsxEntries.length > 0) {
        const already = get().pendingXlsx !== null;
        if (already) {
          for (const x of xlsxEntries) {
            get().pushToast(
              'info',
              `${x.name}: xlsx queued — finish the current review first`,
            );
          }
        } else {
          const [first, ...rest] = xlsxEntries;
          if (first) {
            get().startXlsxReview({
              uploadId: first.uploadId,
              fileName: first.name,
              size: first.size,
              sheets: first.sheets,
            });
          }
          for (const x of rest) {
            get().pushToast(
              'info',
              `${x.name}: additional xlsx ignored — review the current one first`,
            );
          }
        }
      }
    } catch (err) {
      get().pushToast('error', `upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  removeFile: (id) => {
    set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
    void get().refreshScrub();
  },

  refreshScrub: async (opts) => {
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
      if (!opts?.skipJudge && r.scrubbed.length >= MIN_JUDGE_PAYLOAD) {
        api.judgePost(r.scrubbed, r.tokens);
        set({ isJudging: true });
        startJudgePoller();
      }
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
      const r = await api.listPatterns();
      set({ patterns: r.items });
    } catch (err) {
      get().pushToast('error', `patterns fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  suggestPatterns: async (category?: string) => {
    try {
      const r = await api.suggestPatterns(category);
      set({ patterns: r.items });
      get().pushToast('success', `${r.items.length} pattern(s) suggested`);
    } catch (err) {
      get().pushToast('error', `suggest failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  patternAction: async (id, action, regex?) => {
    try {
      await api.patternAction(id, action, regex);
      await get().refreshPatterns();
      if (action === 'activate') {
        // Re-scrub everything from raw content so the newly active pattern applies
        // immediately without requiring the user to re-upload or re-paste.
        const { composerText, files } = get();
        const newTokens: Token[] = [];

        // Re-scrub composer text
        let newScrubbed = get().scrubbed;
        if (composerText.trim()) {
          const r = await api.scrub(composerText, true);
          newScrubbed = r.scrubbed;
          newTokens.push(...r.tokens);
        }

        // Re-scrub each file from its original raw text
        const updatedFiles = await Promise.all(
          files.map(async (f) => {
            if (!f.original) return f;
            try {
              const r = await api.scrub(f.original, true);
              newTokens.push(...r.tokens);
              return { ...f, scrubbed: r.scrubbed };
            } catch {
              return f;
            }
          }),
        );

        set((s) => ({
          scrubbed: newScrubbed,
          files: updatedFiles,
          tokenUnion: mergeTokenUnion(s.tokenUnion, newTokens),
        }));
        await get().refreshVocab();
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

  refreshJudgeStatus: async () => {
    try {
      const s = await judgeApi.status();
      set({ judgeStatus: s });
    } catch (err) {
      // Don't toast on every poll failure — the drawer is hidden most of the
      // time, and stale state is fine. Log to console so debugging is possible.
      console.warn('judge status fetch failed:', err);
    }
  },

  setJudgeEnabled: async (enabled) => {
    try {
      await judgeApi.setEnabled(enabled);
      await get().refreshJudgeStatus();
      get().pushToast('success', `judge ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      get().pushToast('error', `judge toggle failed: ${msg}`);
      throw err;
    }
  },

  installJudgeModel: async (model) => {
    try {
      await judgeApi.install(model);
      await get().refreshJudgeStatus();
      get().pushToast('info', `installing ${model} — large download, please wait`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      get().pushToast('error', `install failed: ${msg}`);
      throw err;
    }
  },

  refreshVersion: async () => {
    try {
      const v = await api.version();
      set({ versionInfo: v });
    } catch (err) {
      // Non-fatal; the drawer check button surfaces toasts for the user.
      console.warn('version check failed:', err);
    }
  },

  refreshUpdateStatus: async () => {
    try {
      const s = await api.updateStatus();
      set({ updateStatus: s });
    } catch (err) {
      console.warn('update status fetch failed:', err);
    }
  },

  downloadUpdate: async () => {
    try {
      const r = await api.startUpdateDownload();
      if ('error' in r) {
        get().pushToast('error', r.error);
        return;
      }
      set({ updateStatus: r.status });
      get().pushToast('info', 'Downloading update in background…');
      // Start a short-lived poller while the download is active.
      startUpdatePoller();
    } catch (err) {
      get().pushToast('error', `download failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  startVersionPoller: () => {
    if (versionPollerRef !== null) return;
    // Channel gate — never set an interval if updates are off. This is the
    // client-side half of the defense; routes/version.ts enforces it again
    // on the server. Both must agree.
    const channel = get().settings?.update_channel;
    if (channel !== 'stable' && channel !== 'beta') return;
    const intervalMs = versionPollIntervalMsOverride ?? VERSION_POLL_INTERVAL_MS;
    versionPollerRef = setInterval(() => {
      // Skip while the tab is hidden — saves battery and avoids piling up
      // requests for a UI the user can't see. The next visible tick picks up.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void get().refreshVersion();
    }, intervalMs);
  },

  stopVersionPoller: () => {
    if (versionPollerRef !== null) {
      clearInterval(versionPollerRef);
      versionPollerRef = null;
    }
  },

  dismissUpdate: (version) => {
    writeLs(LS_DISMISSED_UPDATE, version);
    set({ dismissedUpdateVersion: version });
  },

  setSettingsDeepLink: (target) => set({ settingsDeepLink: target }),

  applyUpdate: async () => {
    try {
      const r = await api.applyUpdate();
      if (!r.ok) {
        get().pushToast('error', r.message || r.reason || 'apply failed');
        await get().refreshUpdateStatus();
        return;
      }
      get().pushToast('success', r.message || 'Restarting with new version…');
      // The server will exit shortly; the page will lose its connection.
      // Leave a hint in the UI (the caller in SettingsDrawer can also react).
    } catch (err) {
      get().pushToast('error', `apply failed: ${err instanceof Error ? err.message : err}`);
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

  // ── Xlsx review (#23 Segment 3C3) ─────────────────────────────────────────

  startXlsxReview: (payload) => set({ pendingXlsx: payload }),
  clearXlsxReview: () => set({ pendingXlsx: null }),

  commitXlsxReview: async (overrides) => {
    const pending = get().pendingXlsx;
    if (!pending) {
      // Defensive — UI should not call this without a pending review, but if
      // it does we surface it rather than silently dropping.
      get().pushToast('error', 'no xlsx pending review');
      return;
    }
    try {
      const r = await api.commitXlsx(pending.uploadId, overrides);
      triggerXlsxDownload(r.base64, r.fileName);
      get().pushToast(
        'success',
        `scrubbed ${pending.fileName} — ${r.summary.cellsScrubbed} cells`,
      );
      get().clearXlsxReview();
    } catch (err) {
      // Leave pendingXlsx intact so the user can adjust selections and retry.
      get().pushToast(
        'error',
        `xlsx commit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
}); });

/**
 * Browser-side download helper for the xlsx commit response.
 *
 * Decodes the base64 payload into a Uint8Array, wraps it in an OOXML-typed
 * Blob, and uses a synthetic `<a download>` click to surface the file in the
 * user's default download location. Revokes the object URL after the click
 * so we don't leak per-commit memory if the user processes many workbooks
 * in a single session.
 *
 * Kept module-private (not exported on the store) because it has no React
 * surface — pure DOM side effect.
 */
function triggerXlsxDownload(base64: string, fileName: string): void {
  // Defensive: skip in non-browser contexts (tests, SSR). The store actions
  // that call this only run in the browser, but a unit test that exercises
  // `commitXlsxReview` against a mocked api should not blow up on document.
  if (typeof document === 'undefined') return;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // Some browsers require the anchor to be in the DOM for `.click()` to fire
  // a download in restrictive contexts (Safari, some Chromium variants).
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
