# Integrated Plan — Issues #20, #21, #22, #23

## Context

Four GitHub issues filed against the privacy-screen app over the last day. Treated separately they are four small patches; treated together they are **two structural defects repeated** plus one new file-type integration:

- **#20** (Settings drawer doesn't scroll) and **#21** (Feedback dialog shows diagnostics expanded by default, pushing the textarea below the fold) are the **same Radix `Dialog.Content` overflow trap** — `flex h-full` / `max-h-[85vh] flex-col` with no dedicated scroll region and children that take `flex-1 min-h-0`. Fix once, apply twice.
- **#22** (feedback submission "very slow, appears to be hanging, no UX feedback") is two problems stacked: the synchronous `claude -p` spawn that drafts the issue body (30–120s flat cost), and the absence of any progressive status in the UI while it runs. Root-cause fix is to drop the LLM from the hot path and make submission a background job.
- **#23** (xlsx support with column-based anonymization) is a new file-type ingestion path plus a new column-aware scrub mode. The scrubber today is whole-text regex (`src/scrubber.ts:78–210`); xlsx wants per-cell scrubbing keyed off the header row.

The user filed three of the four issues from the Send Feedback dialog itself, which means the slow/clunky feedback flow is friction they hit repeatedly — fixing #22 properly has compounding value.

---

## Issue #20 — Settings drawer doesn't scroll

**Root cause** — `web/src/components/SettingsDrawer.tsx:157`. `Dialog.Content` is `fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col gap-4 …`. `h-full` locks total height to viewport; no child has `overflow-y-auto`, so the Update channel section and Save/Cancel row (449–471) clip below the fold on shorter windows.

**Recommended fix** — split the drawer into three structural rows: sticky header, scrollable body, sticky footer.
- New shared component `web/src/components/ui/DialogScroll.tsx` exporting `DialogHeader`, `ScrollableDialogBody`, `DialogFooter`. `ScrollableDialogBody` is `flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-2` — `min-h-0` is the load-bearing class that lets `overflow-y-auto` actually engage inside a flex column.
- Refactor `SettingsDrawer.tsx` to use `<DialogHeader>` (title + close), `<ScrollableDialogBody>` wrapping sections 177–446, `<DialogFooter>` wrapping Save/Cancel (449–471).

**Cross-issue reuse** — `ScrollableDialogBody` is the substrate for #21 as well. Build once.

**Tests** — manual: shrink the dev window to 600px tall, open Settings, confirm scroll engages and Save/Cancel stay pinned. No new unit test (pure layout).

**Risks** — None significant. Tailwind change only.

---

## Issue #21 — Send Feedback: collapse diagnostics by default

**Root cause** — `web/src/components/FeedbackDialog.tsx:152` dialog is `max-h-[85vh] flex flex-col`; diagnostics wrapper (180–202) is `min-h-0 flex-1` with an inner `<pre className="max-h-56 overflow-auto">` (line 197). The `flex-1` makes diagnostics dominate; the textarea above gets compressed below the fold.

**Recommended fix** — two changes:
1. Wrap the diagnostics block in a native `<details>` element with `<summary>Diagnostics (click to expand)</summary>`. Native disclosure = no Radix dep, keyboard-accessible by default, copy-paste still works when expanded. Collapsed state shows only the summary line; expanded shows the existing `<pre>`.
2. Apply the same `ScrollableDialogBody` from #20 so the textarea has guaranteed minimum height and the (now collapsed by default) diagnostics never push it down.

**Cross-issue reuse** — `ScrollableDialogBody` from #20.

**Tests** — manual: open Send Feedback, confirm diagnostics is collapsed by default, expand and verify content matches today's preview, collapse again, confirm textarea regains space.

**Risks** — Power users / support flows that auto-screenshot the dialog now need an extra click. Acceptable given the body is already in the issue payload.

---

## Issue #22 — Feedback submission is slow with no UX feedback

**Root cause** — `server/routes/feedback.ts:170–203` spawns `claude -p` to compose the GitHub issue body, then shells `gh issue create`. The LLM step is the latency dominator (30–120s flat); the spawn timeout is 60s but the actual wait is the synchronous fetch in `FeedbackDialog.tsx:110–145`. Frontend shows a spinner + "Sending…" with no progress text and no cancel.

**Recommended fix — three coordinated changes, smallest first:**

1. **L3: Drop the LLM from the hot path.** The `claude -p` step adds minimal value over a deterministic template: title = first 60 chars of user summary, body = `{user summary}\n\n<details><summary>Diagnostics</summary>\n\n\`\`\`json\n{scrubbed diagnostics}\n\`\`\`\n\n</details>`. Render this server-side and pipe straight to `gh issue create --body-file -`. Removes the largest latency source entirely.

2. **L2: Make submission a background job.** New `server/lib/feedback-jobs.ts` — in-memory `Map<jobId, JobState>` where `JobState = { status: 'queued' | 'drafting' | 'filing' | 'done' | 'error', issueNumber?: number, error?: string, startedAt: number }`. `POST /api/feedback` enqueues, returns `{ jobId }` with HTTP 202 immediately. New `GET /api/feedback/:jobId` returns current state. Worker function runs the `gh issue create` step out-of-band.

3. **L1: Progressive UX.** `FeedbackDialog.onSend()` posts, gets `jobId`, closes the dialog within 500ms, and triggers a topbar toast/pill with a polling hook that shows `Drafting… → Filing on GitHub… → Filed as #N` (or red error state with retry). New `web/src/hooks/useFeedbackJob.ts` polls `GET /api/feedback/:jobId` at 500ms intervals.

**Tests** —
- New `tests/feedback-jobs.test.ts` — exercise the in-memory job store: enqueue, transition, fetch, prune stale jobs.
- Update `tests/feedback-route.test.ts` — assert `POST` returns 202 + jobId, `GET` returns expected shape, end-to-end with mocked `gh` returns `done` + issueNumber.
- Manual: file a feedback, confirm dialog closes in <1s, watch topbar pill progress, confirm issue lands on GitHub.

**Risks** —
- In-memory job store evaporates on server restart. Acceptable for personal-use tool; document the limit. If persistence becomes needed, swap to a JSON file at `MEMORY/feedback-jobs.json`.
- Dropping the LLM may produce uglier titles. Mitigation: trim+clean the summary heuristically; if the title is empty/short, fall back to `"Feedback: " + first verb` or just `"Feedback"` and let the body carry detail.

---

## Issue #23 — Xlsx support with column-based anonymization

**Root cause** — `server/routes/files.ts:18–22` `TEXT_EXTENSIONS` does not include `xlsx`; the route rejects binary. `src/scrubber.ts:78–210` only knows `string → string`. No xlsx parser in `package.json`.

**Recommended fix:**

1. **Add `exceljs` to `package.json`.** Actively maintained, MIT, read + write, streaming-capable. Picked over `xlsx` (SheetJS Pro pressure + npm advisories) and `read-excel-file` (read-only).

2. **New module `src/xlsx-scrubber.ts`** exporting `scrubXlsx(buffer: Buffer, map: ScrubMap, config: XlsxConfig) → Promise<{ scrubbedBuffer: Buffer, summary: { sheets: number, rows: number, cellsScrubbed: number, columnsResolved: Record<string, string> } }>`. Flow:
   - Load workbook → for each sheet → read header row (row 1) → for each header, resolve a pattern category via `resolveColumn(headerName, config)`:
     - Explicit rule in `XlsxConfig.columnRules` (e.g., `{ header: 'Email', pattern: 'Email' }` or `{ headerRegex: '/email/i', pattern: 'Email' }`).
     - Heuristic from header name: `email|e-mail` → Email, `phone|tel|mobile` → Phone, `ssn` → SSN, `ip` → IPv4, `name` → PersonName, `address|street` → StreetAddress, `domain|fqdn` → FQDN.
     - Otherwise: unresolved, fall back to whole-text regex scrubbing on the cell value.
   - For each data row, walk cells: if column resolved, mint a token via the chosen pattern's `replace` factory regardless of cell-text shape (force-mint). If unresolved, run the cell value through `scrubText()`.
   - Skip non-string cells (numbers, dates, booleans) unless a column rule forces them — numbers can leak account IDs etc., so column rules win.
   - Write back to a new workbook buffer and return.

3. **New config types in `src/config.ts`:**
   ```ts
   type ColumnPatternRule = {
     header?: string;        // exact match, case-insensitive
     headerRegex?: string;   // alternative
     pattern: PatternName;   // 'Email' | 'Phone' | 'SSN' | …
   };
   type XlsxConfig = {
     columnRules: ColumnPatternRule[];
     autoDetect: boolean;    // default true
   };
   ```
   Add `xlsx?: XlsxConfig` to `PrivacyConfig`. Document defaults in `privacy-config.example.yaml`.

4. **Integrate at the upload route** — `server/routes/files.ts:31–88`. After the size check, dispatch by extension: `.xlsx` → `await entry.arrayBuffer()` → `scrubXlsx()` → return `{ name, size, mime, scrubbedBuffer: base64, summary, hasCredentials: false }`. Text files continue down the existing path.

5. **Frontend** — `web/src/components/FileDropZone.tsx:97` add `.xlsx` to `accept`. `store.ts:426–468` handle the new response shape: when an xlsx upload returns, store as `FileChip` with `kind: 'xlsx'`, the resolved column map from the server's dry-run, and a base64 scrubbed buffer once committed. Offer a "Download scrubbed.xlsx" action instead of inlining text.

6. **Column-override UI (v1 scope per user decision)** — xlsx upload becomes a two-step flow:
   - **Step A (dry-run)** — `POST /api/files` with the xlsx triggers `inspectXlsx(buffer)` (new) which returns sheet names, header row per sheet, the auto-resolved pattern per column (with provenance: `rule` | `heuristic` | `unresolved`), and a small sample value per column. NO scrubbing yet.
   - **Step B (review + commit)** — new `web/src/components/XlsxColumnReview.tsx` modal opens. Per sheet, a table: `Column header | Sample value | Detected pattern (dropdown) | Source badge`. User can change the pattern via dropdown (options: every PatternName + `<None / skip>` + `<Whole-text regex>`). Submitting calls `POST /api/files/xlsx/commit` with `{ uploadId, columnOverrides: Record<sheetName, Record<columnHeader, PatternName | 'skip' | 'regex'>> }`, server runs `scrubXlsx()` with the merged config, returns scrubbedBuffer + summary.
   - State management: extend Zustand store with `pendingXlsx: { uploadId, sheets: SheetInspection[] } | null`.
   - New server endpoints: `POST /api/files/xlsx/inspect` (returns inspection), `POST /api/files/xlsx/commit` (returns scrubbed buffer). Old `POST /api/files` route detects xlsx and 303-redirects clients to the new flow, or directly returns the inspection payload with a `kind: 'xlsx-inspection'` discriminator so the frontend opens the review modal.
   - Persistence: when user confirms a column-override that disagrees with auto-detect, offer "Remember this override" → write back to `privacy-config.yaml`'s `xlsx.columnRules` (new endpoint `POST /api/config/xlsx-rules`).

**Tests** —
- New `tests/xlsx-scrubber.test.ts` mirroring `tests/scrubber.test.ts` shape — fixtures: a 2-sheet workbook with Email/Phone/SSN columns + a free-text column + a numeric ID column. Assert per-cell tokens, header preservation, column resolution summary, round-trip buffer is valid xlsx.
- New `tests/xlsx-inspect.test.ts` — covers `inspectXlsx()`: returns correct sheet/header inventory, auto-resolved patterns with provenance, sample values, no side effects.
- New `tests/files-route-xlsx.test.ts` — multipart POST inspect + commit flow with mocked overrides. Assert: inspect returns inspection payload; commit with overrides applies them in preference to auto-detect; commit with `skip` leaves the column untouched; commit with `regex` falls back to whole-cell scrubText.
- Manual: upload a real xlsx, change one auto-detected mapping in the review modal, commit, download, verify the changed column was tokenized per the override.

**Risks** —
- `exceljs` adds ~400KB to server deps. Acceptable; not bundled into the frontend.
- Auto-detect from header name will misfire on synonyms ("Mail", "Telephone"); document the column-rule override path.
- Force-mint on a resolved column will tokenize empty/null cells if the parser surfaces them. Skip empty cells.

---

## Shared Substrate

| Substrate | Used by | Description |
|---|---|---|
| `web/src/components/ui/DialogScroll.tsx` | #20, #21 | `DialogHeader`, `ScrollableDialogBody` (`flex-1 min-h-0 overflow-y-auto overscroll-contain`), `DialogFooter`. Fixes the Radix flex-overflow trap once for both dialogs and future ones. |
| `server/lib/feedback-jobs.ts` | #22 | In-memory job store; trivially repurposed for any future async server task. |
| `web/src/hooks/useFeedbackJob.ts` | #22 | Polling hook; pattern carries forward to any future job-status pill. |
| Column-aware scrub path in `src/xlsx-scrubber.ts` | #23, future CSV-aware | Header-row → category resolution is the blueprint for adding the same to CSV later. |

---

## Verification

End-to-end checks after EXECUTE:

1. **#20** — `bun run dev`, open the app, click Settings, shrink window to 600px tall, confirm scroll engages, Save/Cancel stays pinned at the bottom.
2. **#21** — Click Send Feedback, confirm diagnostics is collapsed under `<details>`, textarea is visible without scrolling. Expand diagnostics, confirm content matches today's preview.
3. **#22** — File a feedback submission. Dialog closes <1s. Topbar pill cycles through `Drafting → Filing → Filed as #NN` within ~10s (no LLM). `gh issue list -L 1` shows the new issue with the deterministic title + body.
4. **#23** — Drag a sample .xlsx with Email/Phone columns into the dropzone. `summary.columnsResolved` returns the expected mapping. Download the scrubbed workbook, open it, confirm tokens replaced cell values and the file is still valid xlsx.
5. **Regression** — Existing `bun test` passes, including `tests/scrubber.test.ts` (column-aware path must not change text-file scrubbing).

---

## Decisions (locked 2026-06-09)

1. **#22 — kill the LLM step.** Deterministic template + `gh issue create --body-file -`. `claude -p` removed from the feedback path.
2. **#23 — re-serialize to .xlsx.** User downloads scrubbed workbook; sheet/cell structure preserved via `exceljs` write path.
3. **#23 — column-override UI ships in v1.** Two-step upload flow (inspect → review → commit), per-column dropdown with auto-detect provenance, "Remember this override" writes back to `privacy-config.yaml`. This expands #23 scope materially — call it out in PR/commit messaging.

Defaults adopted unless overridden later:
4. **#22** — 60s timeout for the background job worker.
5. **#22** — Job records pruned after 10 minutes.
6. **#23** — `exceljs` library.
7. **#23** — Auto-detect heuristics: `email`, `phone|tel|mobile`, `ssn`, `ip`, `name`, `address|street`, `domain|fqdn` (extendable).
8. **#20/#21** — `DialogScroll.tsx` extracted as shared substrate (used by both immediately).

## Sequencing (proposed for EXECUTE)

1. **Foundation PR** — `DialogScroll.tsx` + apply to SettingsDrawer (#20) and FeedbackDialog (#21 collapse-by-default). Smallest, lowest-risk, ships UX wins immediately.
2. **Feedback async PR** (#22) — `feedback-jobs.ts` + deterministic template + new endpoints + `useFeedbackJob` + topbar pill. Self-contained backend + thin UI.
3. **Xlsx PR** (#23) — `exceljs` dep + `xlsx-scrubber.ts` + `inspectXlsx` + new endpoints + `XlsxColumnReview.tsx` + config schema + tests. Largest single change; ship last so the other two are already de-risked.
