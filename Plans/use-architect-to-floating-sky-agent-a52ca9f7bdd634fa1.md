# Plan — Issues #20 / #21 / #22 / #23 (integrated)

Single change-set. Two of the four issues (#20, #21) are the same structural defect — modal `Dialog.Content` panels that don't manage their overflow correctly — so they share substrate. #22 and #23 are independent but both touch the file-handling / async-job surface that will outlive them; design them so they don't pre-empt one another.

Branch: `fix/dialog-overflow-feedback-async-xlsx`.

---

## Issue #20 — Settings drawer doesn't scroll, options get clipped

### Root cause
`web/src/components/SettingsDrawer.tsx:157` — `Dialog.Content` is `flex h-full w-full max-w-md flex-col gap-4 … p-5` with **no overflow handling**. Children stack via `gap-4` until they exceed `100vh` and silently clip below the viewport. The Save/Cancel footer (lines 449–471) is just another stacked child, so it gets clipped along with the last sections (LLM Judge 503–669, Update channel 239–446).

### Recommended fix
Restructure `Dialog.Content` into three vertical regions — sticky header, scrollable body, sticky footer — so the scroll happens inside the drawer, not the document:

1. Add a `ScrollableDrawerBody` wrapper (see **Shared Substrate**) used here and in #21.
2. In `SettingsDrawer.tsx`:
   - Keep the title row (158–171) and `Dialog.Description` (172–175) outside the scroll region as the header.
   - Wrap sections 177–446 (Claude Code status, Model, System prompt, JudgePanel, Update channel) in `<ScrollableDrawerBody>`.
   - Move Save/Cancel (449–471) into a sticky footer `<div className="shrink-0 border-t border-zinc-800 pt-3 flex justify-end gap-2">`.
   - Change `Dialog.Content` to `flex h-full w-full max-w-md flex-col` (drop `gap-4` — gap interferes with the sticky footer; restore vertical rhythm with `space-y-4` on the body wrapper).

No prop/type changes. Visual rhythm preserved by `space-y-4` inside the body.

### Cross-issue reuse
See **Shared Substrate** — same wrapper resolves #21.

### Tests
Manual:
1. Launch Vite + Hono. Open Settings. Resize browser height to 600px.
2. Confirm: title + description visible at top, Save/Cancel always visible at bottom, body scrolls smoothly through all sections including LLM Judge and Update channel.
3. Verify focus order is preserved (Tab from title → first form control → … → Save → Cancel → close).

No new automated test — Radix layout behavior under arbitrary heights is verified by humans; we don't have jsdom viewport sizing in this repo.

### Risks / open decisions
- Tailwind's `gap-4` removal could shift spacing on long viewports. Spot-check at ≥900px.
- The Update channel section contains its own `<section>` with `flex-col gap-2` — leave intact; the outer scroll handles the rest.

---

## Issue #21 — Feedback diagnostics expanded by default, pushes textarea below the fold

### Root cause
`web/src/components/FeedbackDialog.tsx:180–202`. The wrapping `<section>` has `flex min-h-0 flex-col` and the inner div has `min-h-0 flex-1 overflow-auto`. `flex-1` makes diagnostics greedy, eating all remaining height inside `max-h-[85vh]`. The `max-h-56` on `<pre>` is a *secondary* cap; the wrapper still expanded under flex pressure and pushed the textarea (205–222) below the visible area on shorter viewports.

### Recommended fix
Two changes, both in `FeedbackDialog.tsx`:

1. **Collapse diagnostics by default** — replace the `<section>` at 180–202 with a `<details>` disclosure:
   ```tsx
   <details className="rounded-md border border-zinc-800 bg-zinc-900/60">
     <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
       Diagnostics (scrubbed) — click to inspect before sending
     </summary>
     <div className="border-t border-zinc-800">
       {/* same three preview.kind branches; drop the outer flex-1 wrapper */}
       {preview.kind === 'ready' && (
         <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200">
           {preview.json}
         </pre>
       )}
     </div>
   </details>
   ```
   `<details>` is keyboard-accessible by default; no Radix dependency needed.

2. **Remove the layout trap on the parent** — `Dialog.Content` (line 152) keeps `flex max-h-[85vh] flex-col`, but the children no longer compete for `flex-1` height. Drop `min-h-0 flex-1` everywhere in this dialog. If the user expands `<details>` past viewport height, the parent's `max-h-[85vh]` + a single `overflow-y-auto` on `Dialog.Content` produces graceful scroll — apply the **ShrinkableDialogBody** pattern (see Shared Substrate).

3. Update the existing `useEffect` that focuses the textarea (lines 101–105) — still fires on `preview.kind === 'ready'`. No behavioral change.

### Cross-issue reuse
See **Shared Substrate**.

### Tests
- New test `tests/feedback-dialog.test.tsx` (happy-dom env, mirrors `update-banner.test.ts` pattern):
  - `renders with diagnostics collapsed by default` — assert `<details>` is present and `open === false`.
  - `expanding diagnostics reveals scrubbed JSON` — fire click on `<summary>`, assert `<pre>` is in the tree.
- Manual: open Send Feedback at 700px tall window. Confirm textarea + Send button visible without scrolling. Click "Diagnostics" — JSON expands inline, scrolls internally at 56-line cap.

### Risks / open decisions
- `<details>` styling varies per browser for the disclosure triangle. Acceptable — we're using a custom summary. Decide: hide the native triangle (`details > summary::-webkit-details-marker { display: none; }`)? Recommend: keep visible, it's the clearest affordance.

---

## Issue #22 — Feedback submission appears to hang (minutes, no progress)

### Root cause (three layers, stacked)
1. **Synchronous wall-clock model.** `server/routes/feedback.ts:170–203` spawns `claude -p <prompt>` and awaits `proc.exited` inside the HTTP handler. The user's browser holds the connection for the full duration. The 60s `SPAWN_TIMEOUT_MS` is **not the cause** — the user reports "minutes," which is the actual `claude` + `gh` runtime, well under timeout but well over UX tolerance.
2. **Zero progress signal.** `FeedbackDialog.tsx:248–249` shows `<Loader2 />` + "Sending…" — a binary state. The user can't tell whether the system is alive, mid-LLM, mid-`gh`, or hung.
3. **Marginal LLM value.** `claude -p` is asked to (a) pick a title from the summary, (b) wrap body in `<details>`, (c) shell out to `gh issue create`. The user already typed the summary. The LLM's contribution is ~1 line of title rephrasing — a flat cost (30–120s of `claude` startup + inference) for cosmetic gain. Diagnostics shape is already fixed and machine-formattable.

### Recommended fix — L2 + L3 combined (skip LLM, async job)

**Rationale:** L1 (progress text) is band-aid; L2 (background job) is required regardless to unblock the browser; L3 (drop LLM) directly removes the latency source. Doing L3 alone shrinks p50 from minutes to <2s — but L2 is still cheap and future-proofs if the LLM ever comes back. User filed 3 feedback issues in a row — friction is real, lean toward the largest cut.

#### Backend — `server/routes/feedback.ts`
1. **Add a tiny in-process job store** at `server/lib/feedback-jobs.ts`:
   ```ts
   export type JobState = 'queued' | 'drafting' | 'filing' | 'done' | 'error';
   export interface FeedbackJob {
     id: string;            // crypto.randomUUID()
     state: JobState;
     startedAt: number;
     updatedAt: number;
     stage: string;         // human-readable, e.g. "Filing on GitHub…"
     url?: string;          // populated when state==='done'
     error?: string;        // populated when state==='error'
   }
   // Map<jobId, FeedbackJob>, capped at 32 entries, 1h TTL, FIFO eviction.
   ```
   Single-process Bun server, so an in-memory `Map` is fine. No persistence needed — feedback jobs are short-lived; restart loses pending jobs (acceptable, document in route header).

2. **Rewrite POST `/api/feedback`** (`feedback.ts:77–204`) to enqueue + return 202 immediately:
   - Run validation, claude-presence gate, scrub, credential check **synchronously** (these are fast and need the request body anyway).
   - Create job, kick off `fileFeedbackJob(jobId, prompt or rendered-issue-payload)` as `void`-returning async (not awaited).
   - Return `c.json({ ok: true, jobId, accepted: true }, 202)`.

3. **Add GET `/api/feedback/:jobId`** that returns the `FeedbackJob` as JSON, or 404 if unknown.

4. **Replace the LLM step (L3)** — `fileFeedbackJob` skips `claude -p` entirely:
   - Build a deterministic title from the first 80 chars of the scrubbed summary (strip newlines, ellipsize). Example: `"[feedback] " + summary.split('\n')[0].slice(0,72)`.
   - Render the body as:
     ```
     <user summary, scrubbed>

     <details><summary>Diagnostics</summary>

     ```json
     <diagnostics JSON>
     ```
     </details>
     ```
   - Spawn `gh issue create --repo adamcongdon/privacy-screen --title <title> --body-file <tmpfile>` via `Bun.spawn`. Body via `--body-file` avoids argv length limits.
   - Update `job.stage` at each step: `"drafting" → "filing" → "done"`.
   - On success: parse the URL `gh` prints on stdout, set `job.url`, `state='done'`.
   - On failure: capture `stderr`, set `job.error`, `state='error'`.

5. **Delete** `buildPrompt()`, `resolveClaudeBin()` (the binary check moves to feedback boot diagnostics, not per-request), and the `SPAWN_TIMEOUT_MS` constant. Replace with `GH_SPAWN_TIMEOUT_MS = 30_000` for the `gh` spawn. Keep `assertRedacted` and the credential guard — they remain mandatory.

   The Claude Code presence check stays in the boot path / diagnostics — feedback no longer depends on it, but the rest of the app does, so don't remove the check itself.

#### Frontend — `web/src/components/FeedbackDialog.tsx`
1. `onSend()` (lines 110–145):
   - POST as today, expect `{ jobId }` in the 202 response.
   - On success: `pushToast('success', 'feedback submitted — filing in background')`, `setSummary('')`, `onOpenChange(false)`, then start a poll loop.
2. **New module** `web/src/lib/feedback-job-poller.ts`:
   ```ts
   export function pollFeedbackJob(jobId: string, onUpdate: (job) => void): () => void
   ```
   - Polls `GET /api/feedback/:jobId` every 1500ms with exponential backoff capped at 5000ms.
   - Calls `onUpdate(job)` on every poll.
   - Stops on terminal state (`done` | `error`) or 5min wall-clock.
   - Returns an `unsubscribe` function.
3. In the Zustand store (`web/src/store.ts`), add `activeFeedbackJob: { id; stage; state } | null` and reducers `setActiveFeedbackJob`, `clearActiveFeedbackJob`. Render a tiny status pill in the topbar (next to the existing toast surface) that updates as `stage` changes: "Drafting…" → "Filing on GitHub…" → click-to-open toast with the issue URL when done.
4. On `done`: push toast `"feedback filed: #N"` linking to `job.url`. On `error`: push error toast with `job.error`.

This means the dialog closes in <500ms (POST returns 202 fast) and the user keeps working while filing happens.

### Tests
- `tests/feedback-route.test.ts` — extend:
  - `POST /api/feedback returns 202 with jobId synchronously` — assert response time <500ms, body has `jobId`.
  - `GET /api/feedback/:jobId returns job state` — stub `gh` via existing `__PRIVACY_SCREEN_TEST_CLAUDE_BIN` mechanism (rename to `__PRIVACY_SCREEN_TEST_GH_BIN`), assert job transitions queued→filing→done.
  - `anti-leak: gh argv contains no raw customer name` — recreate the existing capture pattern (`feedback-route.test.ts:30–55`) but for the new `gh` spawn argv.
- New `tests/feedback-jobs.test.ts` — pure unit tests for the job store: TTL eviction, cap at 32, unknown jobId returns null.
- Manual: send feedback, dialog closes immediately, topbar pill shows "Filing on GitHub…", success toast with issue URL appears within ~5s.

### Risks / open decisions
- **Do we keep the `claude -p` path as a fallback** when `gh` is missing/unauthed? Recommend: no — `gh` not configured is a hard error with a clear remediation message. Adding LLM fallback re-introduces the latency we're killing.
- **Title quality.** Deterministic-from-summary may produce duplicate-shaped titles. Acceptable — the user can rename in GitHub. If this becomes a real problem, add a small client-side title field (1 textarea row) so the user provides it; still no LLM.
- **Process restart drops in-flight jobs.** Document in `feedback.ts` header. If we want durability later, persist to vocab.db (a `feedback_jobs` table) — out of scope for v1.

---

## Issue #23 — xlsx support with column-based anonymization

### Root cause
`server/routes/files.ts:18–22` whitelist excludes `.xlsx`. Underlying issue: `scrubText()` (`src/scrubber.ts:78`) operates on a single flat string — no structural awareness, so even if we converted xlsx to text we'd lose the column→pattern mapping the user wants.

### Recommended fix
Three-layer change. Treat xlsx as the **first structural format**; design the column-pattern primitive so future formats (csv, parquet later) can reuse it.

#### 1. Parser choice — `exceljs`
- `xlsx` (SheetJS) — most popular but the maintained version is now CDN-only / paid; community npm is stale.
- `read-excel-file` — read-only, no write path. Bad fit since we may want xlsx-out later.
- **`exceljs`** — actively maintained, MIT, supports both read and write, streams large workbooks, types are decent. **Pick this.** Add via `bun add exceljs`.

#### 2. Column-pattern data shape
Add to `PrivacyConfig` (extend `src/config.ts` interface + `DEFAULTS`):
```ts
export interface ColumnPatternRule {
  /** Match by exact header name (case-insensitive) OR regex if prefixed with `re:`. */
  header: string;
  /** Pattern category to apply to every cell in this column. Must be a known scrubber category. */
  category: 'email' | 'phone' | 'ip' | 'fqdn' | 'person' | 'customer' | 'account_number' | 'address' | 'url' | 'guid' | 'mac' | 'path' | 'domain_user';
  /** If true, the cell value is tokenized even if it doesn't match the corresponding regex (forced). Default true. */
  force: boolean;
}

export interface XlsxConfig {
  /** Default per-column rules applied to every uploaded xlsx. */
  column_rules: ColumnPatternRule[];
  /** If true, auto-detect category from header name (email→Email, ssn→Account, etc) when no explicit rule matches. Default true. */
  auto_detect_headers: boolean;
}
```
Add `xlsx: XlsxConfig` to `PrivacyConfig`. Defaults: `auto_detect_headers: true`, `column_rules: []`. Example block added to `privacy-config.example.yaml`.

#### 3. xlsx pipeline end-to-end
New module `src/xlsx-scrubber.ts`:
```ts
export interface XlsxScrubResult {
  /** Re-serialized .xlsx bytes (Buffer) — same shape as input, cells anonymized. */
  scrubbedBytes: Buffer;
  /** Per-sheet plaintext preview, joined with sheet headers. UI shows this. */
  textPreview: string;
  /** Flattened scrub result (tokens minted, credentials, unsure spans). */
  scrub: ScrubResult;
  /** Per-column resolution: which rule fired, which auto-detect kicked in. */
  columnResolutions: Array<{ sheet: string; col: number; header: string; category: string | null; source: 'rule' | 'autodetect' | 'fallback' }>;
}

export async function scrubXlsx(
  bytes: ArrayBuffer,
  map: ScrubMap,
  vocab: VocabStore | null,
  ctx: ScrubContext,
): Promise<XlsxScrubResult>
```

Pipeline:
1. Load workbook via `new ExcelJS.Workbook().xlsx.load(bytes)`.
2. For each worksheet:
   - Read row 1 as headers. For each column index, resolve a category:
     a. Exact/regex match against `cfg.xlsx.column_rules` → use that category.
     b. Else if `auto_detect_headers`, run a small header-name classifier (substring rules: `/email/i → email`, `/phone|tel/i → phone`, `/ssn|tax\s?id/i → account_number`, `/ip[_\s]?addr/i → ip`, `/host|fqdn|server/i → fqdn`, `/name|owner|contact/i → person`, `/customer|client|account\s+name/i → customer`, `/url/i → url`, `/mac/i → mac`). No match → null (fallback to regex pass).
     c. Record the resolution.
   - For each data row, for each cell:
     - **String cells with a resolved category**: call `scrubText(stringValue, …)` — but force-mint by running a single-line helper `forceMintAs(category, value, map, vocab)` that bypasses regex and tokenizes the entire cell value. New helper in `src/scrubber.ts`; reuses `recordMint` internals.
     - **String cells without a resolved category**: pass through `scrubText()` as today (whole-text regex).
     - **Number / Date / Boolean cells**: pass through unmodified UNLESS the column category is `account_number` / `phone` / `ip` — in those cases stringify, scrub, write back as string. Document in `XlsxConfig` comment.
     - **Formula cells**: scrub the `result` value, drop the formula (set cell value to scrubbed result string). Comment block at module top explains why — formulas can leak ranges that reference identifying columns.
3. Re-serialize via `workbook.xlsx.writeBuffer()` → returned as `scrubbedBytes`.
4. Build `textPreview` for the UI (each sheet: header row + first 20 data rows, tab-separated). This is what the user sees in `PreviewPane`.

#### 4. Wire into `server/routes/files.ts`
- Add `.xlsx` to `TEXT_EXTENSIONS` (rename const to `SUPPORTED_EXTENSIONS`).
- Branch: if extension is `.xlsx`, call `scrubXlsx(await entry.arrayBuffer(), …)` instead of `entry.text() + scrubText()`.
- Response shape for xlsx: add `kind: 'xlsx'`, `scrubbedBytes: <base64>`, `textPreview: <string>`, `columnResolutions: […]`. Existing fields (`tokens`, `hasCredentials`, etc.) come from the flattened `scrub` result.
- For text files, response gets `kind: 'text'` and is otherwise unchanged.

#### 5. Frontend — `web/src/components/FileDropZone.tsx` + `PreviewPane.tsx`
- Accept `.xlsx` in the picker (file input `accept` attribute) and in the size-check copy.
- When an xlsx chip is selected, `PreviewPane` shows `textPreview`; add a "Download scrubbed .xlsx" button that base64-decodes `scrubbedBytes` and triggers a download (Blob + anchor click — no server roundtrip).
- Show the `columnResolutions` as a small badge row above the preview: `Email (auto) · Customer (rule) · Notes (regex)` — gives the user immediate feedback that column inference worked.

#### v1 cut (recommend)
- Ship: parser, auto-detect from header name, force-mint per column, regex fallback for unresolved columns, xlsx-out + text preview.
- Defer: per-upload UI to override column→category (would need a "preview headers → assign category" step before scrubbing). Document in plan; revisit when users actually request it.

### Tests
- `tests/xlsx-scrubber.test.ts` (new, mirrors `tests/scrubber.test.ts` style):
  - `header "Email" with email-shaped cell → tokenized as {EMAIL}`
  - `header "Email" with non-email string ("n/a") → still force-tokenized when force=true`
  - `regex match for unresolved column "Notes" with embedded IP → IP tokenized`
  - `header "Phone" with numeric cell → stringified, scrubbed`
  - `formula cell → result scrubbed, formula dropped`
  - `multiple sheets → per-sheet resolutions returned independently`
  - `roundtrip: scrub → load result bytes → headers preserved, cell values are tokens`
- `tests/files-route.test.ts` (new — repo has none today for files route): upload a fixture xlsx via `app.fetch(new Request)`, assert response has `kind: 'xlsx'`, `scrubbedBytes`, valid base64.
- Fixture: `tests/fixtures/sample.xlsx` — small 2-sheet workbook with Email/Phone/Notes columns, generated via a one-shot `bun` script committed alongside.
- Manual: drop a real xlsx into the dropzone, confirm preview renders, click Download, open in Excel/Numbers — values are tokens, structure intact.

### Risks / open decisions
- **Output format.** Recommend xlsx-out (preserves user's downstream workflow). Alternative: csv-only — simpler but breaks anyone who needs the spreadsheet back. **Decide before EXECUTE.**
- **Header row assumption.** Some xlsx files have no header (data row 1). v1: assume row 1 = header. If row 1 doesn't look header-shaped (all numeric, etc.), fall back to whole-cell regex on every column. Add a future `cfg.xlsx.header_row: number | 'auto'` knob.
- **Large workbooks.** `MAX_FILE_BYTES = 5MB` (line 17) covers most cases. ExcelJS streams; we currently buffer. Acceptable for v1; raise the cap if users complain.
- **Auto-detect false positives.** A column called "Name" might be a product name, not a person. Auto-detect is opt-out via `auto_detect_headers: false`. Document in example yaml.

---

## Shared Substrate

### `ScrollableDrawerBody` / `ShrinkableDialogBody` — new wrapper
Both #20 and #21 are symptoms of Tailwind flex children competing for height inside a `Dialog.Content` with a height ceiling. Solve once.

New file: `web/src/components/ui/DialogScroll.tsx`:
```tsx
/** Body region for Radix Dialog.Content. Sticky header/footer siblings stay
 *  visible; this region scrolls when content exceeds the dialog's max height. */
export function ScrollableDrawerBody({ children, className }: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto pr-1 space-y-4', className)}>
      {children}
    </div>
  );
}
```

Pattern for both dialogs:
```tsx
<Dialog.Content className="flex max-h-[Xvh] flex-col …">
  <Header />              {/* shrink-0 by default */}
  <ScrollableDrawerBody>
    {/* sections */}
  </ScrollableDrawerBody>
  <Footer />              {/* shrink-0 by default */}
</Dialog.Content>
```

This is the only mutual code. #21's `<details>` collapse is dialog-local — don't try to genericize "collapse-by-default" until a third caller exists.

### Diagnostics object reuse
The L3 backend rewrite in #22 still needs the scrubbed diagnostics JSON — same `collectDiagnostics()` + `scrubDiagnostics()` + `assertRedacted()` helpers in `server/lib/feedback-diagnostics.ts`. Don't duplicate. The job worker calls these synchronously before kicking off `gh` so the redaction check still gates the request.

### Test seam rename
`__PRIVACY_SCREEN_TEST_CLAUDE_BIN` becomes `__PRIVACY_SCREEN_TEST_GH_BIN` after #22's LLM removal. Update `tests/feedback-route.test.ts` and the docstring in `resolveClaudeBin()` accordingly (or delete `resolveClaudeBin` outright).

---

## Open Decisions (resolve before EXECUTE)

1. **#22 — Kill the LLM entirely (recommended L2+L3) or keep `claude -p` as opt-in fallback?** Recommendation: kill it. Add back later if title quality becomes a real complaint.
2. **#22 — Persist feedback jobs to vocab.db, or accept that server restart drops in-flight jobs?** Recommendation: accept v1 loss, document.
3. **#22 — Add a 1-line "title" field in the FeedbackDialog so the user provides the title?** Recommendation: no for v1 — first 80 chars of summary is fine; revisit if duplicates pile up.
4. **#23 — Parser: `exceljs` confirmed?** Yes unless you have a license/footprint objection.
5. **#23 — Output: xlsx-out (preserves structure) or csv-only (simpler)?** Recommendation: xlsx-out. Same parser handles read + write, no extra work.
6. **#23 — Ship per-upload column override UI in v1, or auto-detect only?** Recommendation: auto-detect + yaml rules in v1; UI in v2.
7. **#23 — `MAX_FILE_BYTES` raise from 5MB?** Defer until a user hits it.
8. **#20/#21 — Keep `gap-4` somewhere on `Dialog.Content`, or rely entirely on `space-y-4` inside `ScrollableDrawerBody`?** Recommendation: `space-y-4` inside body, sticky header/footer manage their own margins.

---

## Execution order (when you're ready)

1. Shared substrate first: `web/src/components/ui/DialogScroll.tsx`. Tiny, no test surface, unblocks #20 + #21.
2. #20 + #21 in one commit each — small, low-risk, immediate UX wins.
3. #22 next — backend job store + route changes + frontend poller. Bigger surface; do it before #23 so any new file-handling patterns in #23 can reuse the async-job model if needed (probably not, but design hygiene).
4. #23 last — largest surface, only one with a new dependency (`exceljs`), and not blocking the other three.
