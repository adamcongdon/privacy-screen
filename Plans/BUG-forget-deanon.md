---
type: bug
status: open
component: vocab / forget flow
filed: 2026-05-29
filed_by: Adam
---

# [Bug] "forget" button doesn't actually forget — item still gets de-anonymized

## Summary

Clicking the per-row **forget** button in the Token Map UI removes the vocab
entry on the server, but the affected real value continues to be
de-anonymized on screen. The expected behavior is that after forgetting an
entry, the real value should no longer surface anywhere in the current view —
neither in the token map list nor inside rendered messages.

## Repro

1. Run the server + web app (`bun run dev` / however it's started).
2. Send a message containing a piece of PII so that a token is minted
   (e.g. a customer name or IP).
3. Open the Token Map panel — verify the entry is listed with its real
   value and its token.
4. Click the **forget** button on that row (`aria-label="forget <value>"`).
5. Observe: the success toast fires (`forgot "<value>"`), the row may
   disappear from the vocab table, **but** the prior de-anonymized text in
   the transcript still shows the real value, and/or refreshing the view
   still resolves the token back to the real value.

## Expected

After forget:
- The vocab row is gone (✅ this part appears to work).
- The token → real value mapping is unreachable for **any** subsequent
  deanonymize() call — including for tokens already rendered in the
  current session view.
- The UI shows the tokenized form (or a "[forgotten]" placeholder) where
  the real value previously appeared, not the real value.

## Actual

- The server-side row deletion fires
  (`DELETE /api/vocab/:realValue` → `forgetReal()` →
  `DELETE FROM vocab WHERE real_value = ? COLLATE NOCASE`).
- The `resetVocab()` singleton reset runs after the delete.
- However, the real value still appears de-anonymized in the UI, meaning
  the deanon lookup path is still finding the mapping somewhere.

## Suspect surfaces (starting points for triage — not a verified diagnosis)

- **web/src/store.ts:75** — comment says
  *"Token union — every token we've ever seen this session, for deanon
  lookups"*. This session-scoped client-side map is the most likely place
  the mapping is surviving a server-side forget. `forgetVocab()` in
  `store.ts:366-378` calls `refreshVocab()` + `refreshScrub()` but does
  **not** appear to evict the forgotten real value from the session token
  union.
- **web/src/components/TokenMap.tsx:156-159** — the forget button only
  invokes `forgetVocab(r.realValue)`; there is no follow-up that clears
  any client-side deanon cache for that value.
- **server/routes/vocab.ts:32-38** — `DELETE /api/vocab/:realValue` only
  deletes from the `vocab` table and resets the in-memory singletons. If
  the real value lives in any other persisted table (redaction_log,
  token-map persistence, etc.) it may be re-hydrated on the next
  `loadIntoMap()`.
- **src/vocab.ts:187-192** — `forgetReal()` deletes from `vocab` only,
  using `COLLATE NOCASE` on `real_value`. If the same real value was
  inserted with a different casing/category, or under a separate
  token-map table, it survives.

## Hypothesis (to confirm during triage)

The server forgets the vocab row, but the client retains the
token → real-value mapping in its session "Token union" (and/or in any
already-rendered message buffers). Deanonymization happens client-side at
render time, so the row deletion is invisible until a full session reload.

If confirmed, the fix likely needs to:
1. Have `forgetVocab()` in `web/src/store.ts` also evict every
   token → real-value pair for the forgotten value from the session
   token union, and
2. Re-render (or scrub) any already-rendered transcript text so the
   real value disappears from view, not just from the vocab list.

## Out of scope for this ticket

- Whether forget should also purge `redaction_log` history rows for
  audit / compliance — separate decision.
- UX: confirm-before-forget dialog — separate ticket.

## Acceptance for "fixed"

- After clicking forget, deanonymize() returns the token (or
  `[forgotten]`), not the real value, for that entry — verified by
  inspecting the rendered transcript and by re-fetching the token map.
- A regression test exercises: mint → render (deanon shows real) →
  forget → render (deanon does NOT show real), in both the same view
  and after a full reload.
