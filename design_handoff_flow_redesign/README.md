# Handoff: Privacy Screen — "Flow" UX redesign

## Overview
This is a full UX redesign of the **privacy-screen app UI** (the three-pane web client served on `127.0.0.1:31338`). It replaces the current dark-only, dense two-pane layout with **"Flow"**: a left icon **nav rail** + a focused, spacious workspace, a persistent **local-first trust band**, **light + dark themes**, and a token system reworked for **WCAG 2.1 AA** accessibility. The navigation is designed to scale to the roadmap (History, Chat-replacement, PWA) without another redesign.

Scope of the redesign:
- **Scrub & Send** (the compose → scrub → send → response loop) — replaces `Composer` + `PreviewPane` + `ResponseStream`.
- **Review queue** triage — re-skins `ReviewQueue` / `PatternSuggestions`.
- **Vocabulary** (token map) — promotes `TokenMap` / `TokenMapDrawer` to a full page.
- **Settings** — promotes `SettingsDrawer` to a full page (modes, LLM judge, updates, customer names, data).
- **Onboarding / first-run**, **empty & error states**, and a **PWA/mobile** layout.
- A theme system (dark default + light) and an accessible token-pill system.

---

## About the design files
The files in `reference/` are **design references authored in HTML/React-in-the-browser (Babel)** — they exist to show intended **look, layout, and behavior**. They are **not** production code to copy verbatim. Your job is to **recreate these designs inside the existing `web/` app** (React 18 + TypeScript + Vite + Tailwind + Zustand + lucide-react + Radix), reusing its established patterns, store, and API layer.

Two reference artifacts:
1. **`reference/Privacy Screen — Flow.html`** — the **interactive prototype** of the chosen direction. Open it and click around: rail nav, theme toggle, live tokenization as you type, gated Send with a streamed reply (Real ↔ Wire toggle), credential blocking, review actions, vocab search/reveal/forget, settings that feed back into the scrubber. This is the source of truth for **behavior**.
2. **`reference/Privacy Screen Redesign.html`** — a static design canvas showing **every screen in dark + light**, plus two alternative directions (Console, Chat) that were explored and set aside. Source of truth for **every screen's visual spec**, including states/onboarding/PWA.

How to read the reference source:
- **`kit.jsx`** — the design system: the full CSS (theme variables for both modes, components), the token-category map (`CATS`), the `Pill` and `Ic` (icon) components. **This is the single most important file to port** — it contains every token below.
- **`scrub-engine.jsx`** — a working reference tokenizer (regex layer mirroring your taxonomy). Your real backend already does this; use it only to understand the run/pill data shape the UI expects.
- **`flow-chrome.jsx`** (rail + shell), **`flow-app.jsx`** (Scrub screen + app state), **`flow-screens.jsx`** (Review / Vocab / Settings) — the Flow screens.
- `legend/console/flow/chat/screens/settings/onboarding/states.jsx` back the static canvas.

> Note: the references mount React via in-browser Babel and attach helpers to `window` — that's a prototyping convenience only. In `web/`, implement these as normal `.tsx` modules with imports.

---

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interactions are final. Recreate the UI pixel-accurately using the exact tokens in the **Design Tokens** section. Where the prototype fakes a backend (the regex scrubber, the streamed reply, the seeded review/vocab data), wire it to your real store/API instead — those are noted per screen.

---

## Design language at a glance
- **Type:** `IBM Plex Sans` (UI) + `IBM Plex Mono` (tokens, values, code). Add both via Google Fonts (weights 400/500/600/700 sans; 400/500/600 mono). Replace the current system-sans stack in `web/src/index.css`.
- **One accent per the chosen direction = Flow green.** Dark `#37d39a`, Light `#0a8f5f`.
- **Theme:** dark is default; light is fully supported. Driven by a `data-theme` / class on the root + CSS custom properties (see below). This replaces the hard-coded `bg-zinc-950 text-zinc-100` approach in `App.tsx`.
- **Accessibility is a feature, not a coat of paint** — this is a privacy/compliance tool. See the Accessibility section; it is a hard requirement, not optional polish.

---

## Theming architecture (do this first)
The current app hard-codes Tailwind `zinc-*` utilities and is dark-only. Move to **CSS custom properties** set by a root class, so both themes share one component layer.

**1. Add the variables.** Put this in `web/src/index.css` (`@layer base`). These are the exact values from `kit.jsx`:

```css
:root, .theme-dark {
  --bg:#0d1117; --surface:#151b23; --surface-2:#1b232e; --surface-3:#212b38;
  --border:#283140; --border-2:#374150; --hairline:rgba(255,255,255,.06);
  --text:#e9eef5; --text-dim:#aeb9c6; --text-faint:#7e8b9a;
  --shadow:0 1px 0 rgba(255,255,255,.03) inset, 0 8px 24px rgba(0,0,0,.4);
  --ok:#3fb950; --ok-tint:rgba(63,185,80,.14);
  --warn:#e3a008; --warn-tint:rgba(227,160,8,.14);
  --danger:#f76d6d; --danger-bg:#2a1517; --danger-border:#69262a;
  /* Flow accent (dark) */
  --acc:#37d39a; --acc-2:#54e0ad; --acc-ink:#04201a;
  --acc-tint:rgba(55,211,154,.15); --acc-line:rgba(55,211,154,.42);
}
.theme-light {
  --bg:#f4f6f9; --surface:#ffffff; --surface-2:#f1f4f8; --surface-3:#e9edf3;
  --border:#dde3ea; --border-2:#c8d1db; --hairline:rgba(15,23,32,.07);
  --text:#161c24; --text-dim:#4d5763; --text-faint:#6e7986;
  --shadow:0 1px 2px rgba(15,23,32,.06), 0 8px 22px rgba(15,23,32,.06);
  --ok:#1a7f37; --ok-tint:rgba(26,127,55,.10);
  --warn:#9a6700; --warn-tint:rgba(154,103,0,.10);
  --danger:#c4393f; --danger-bg:#fdeced; --danger-border:#f3c2c4;
  /* Flow accent (light) */
  --acc:#0a8f5f; --acc-2:#0b7d54; --acc-ink:#ffffff;
  --acc-tint:rgba(10,143,95,.10); --acc-line:rgba(10,143,95,.38);
}
html, body, #root { height:100%; }
body { font-family:'IBM Plex Sans', system-ui, sans-serif; background:var(--bg); color:var(--text);
  -webkit-font-smoothing:antialiased; }
```

**2. Surface them to Tailwind** so you can keep using utilities. In `tailwind.config.ts` extend the theme (keep `darkMode: 'class'` or switch to the explicit theme classes above):

```ts
extend: {
  fontFamily: {
    sans: ['IBM Plex Sans','system-ui','sans-serif'],
    mono: ['IBM Plex Mono','ui-monospace','Menlo','monospace'],
  },
  colors: {
    bg:'var(--bg)', surface:'var(--surface)', 'surface-2':'var(--surface-2)', 'surface-3':'var(--surface-3)',
    border:'var(--border)', 'border-2':'var(--border-2)',
    text:'var(--text)', 'text-dim':'var(--text-dim)', 'text-faint':'var(--text-faint)',
    acc:'var(--acc)', 'acc-2':'var(--acc-2)', 'acc-ink':'var(--acc-ink)',
    ok:'var(--ok)', warn:'var(--warn)', danger:'var(--danger)',
  },
}
```
Then write components with `bg-surface text-text border-border` etc. instead of `bg-zinc-900`.

**3. Theme state.** Add to the Zustand store (`web/src/store.ts`):
```ts
theme: 'dark' | 'light';            // default 'dark'
setTheme(t): persists to localStorage('ps-theme'); applies class to <html>
```
On boot, read `localStorage('ps-theme')` (fallback to `matchMedia('(prefers-color-scheme: light)')` if you want system default), and set `document.documentElement.className = 'theme-' + theme`. The rail's theme button calls `setTheme`.

---

## Layout architecture
Replaces the `<PanelGroup direction="horizontal">` two-column shell in `web/src/App.tsx`.

```
┌──────┬───────────────────────────────────────────────────────┐
│ Rail │  Header (page title + subtitle · status/controls)     │
│ 80px │  Trust band (local-first reassurance) — optional/route │
│      │  ───────────────────────────────────────────────────  │
│ Scrub│                                                        │
│ Rev  │            Routed screen content                       │
│ Vocab│                                                        │
│ Hist°│                                                        │
│ Chat°│                                                        │
│      │                                                        │
│ ──── │                                                        │
│ Theme│                                                        │
│ Set  │                                                        │
│ AC   │                                                        │
└──────┴───────────────────────────────────────────────────────┘
```

- **Rail** (`flow-chrome.jsx → FlowRail`): fixed **80px**, `bg-surface`, `border-right`. Brand mark (40×40, `--acc` bg, shield icon, radius 12) at top. Stacked nav items, each a vertical icon+label button (icon 21px, label 10px/600). Active item: `--acc` text on `--acc-tint` bg + a 3px `--acc` indicator bar on the left edge. `History` and `Chat` are present but **disabled with a "SOON" caption** (roadmap). Bottom cluster: theme toggle (sun/moon), Settings, and the `AC` avatar circle. The Review item carries a numeric **badge** (count of pending review items) top-right of its icon.
- **Header** (`FlowShell`): page **title 20px/600**, **subtitle 12.5px** `--text-dim`. Right side holds per-screen controls (status chips, mode segmented control, search, etc.).
- **Trust band**: a slim full-width strip under the header, `--acc-tint` bg, `--acc` text, lock icon, copy: *"Local-first — real values never leave this machine. Only stable tokens are sent to Claude."* Show it on Scrub & Send (and optionally Review); hide on Vocab/Settings (`trust={false}`).
- **Routing:** introduce a `route` value (`'scrub' | 'review' | 'vocab' | 'settings'`, with `'history' | 'chat'` reserved). Keep it in the store or URL hash. The drawers (`TokenMapDrawer`, `SettingsDrawer`) become **routes**, not overlays.

---

## Screens / Views

### 1 · Scrub & Send  *(replaces Composer + PreviewPane + ResponseStream)*
**Purpose:** paste/type sensitive text, watch it tokenize live, send the tokenized version, read a deanonymized reply.

**Layout:** header (title "Scrub & Send", subtitle "Paste sensitive text — it's tokenized before anything is sent."; right: a `claude ready` status chip + an **Observe / Enforce** segmented control). Trust band. Body = a single row, full height:
- **Left panel "Your text — stays on device"** (`.ps-panel`, flex:1): header strip with a doc icon + eyebrow label, and a **Clear** ghost button when non-empty. Below, a borderless **mono textarea** (12.5px, line-height 1.7, `--text-dim`), transparent bg, no resize. This is the live input.
- **Center seam** (56px wide): a 38px circle, `--acc` bg, containing a right-arrow icon. When a credential is present it turns `--danger` with an alert icon.
- **Right panel "Safe to send"** (`.ps-panel`, flex:1, border uses `--acc-line`): header strip (shield icon + accent eyebrow + a **Copy** button). Body renders the **scrubbed runs** (mono, line-height 2): plain text interleaved with **token pills** (see Token system). 

**Send footer** (below the row): left = `✓ N items protected` + a divider + up to 5 category pills (+`credential` danger badge if any); right = a one-line reassurance + the primary **Send to Claude** button (height 42).

**Behavior:**
- **Live scrub:** every input change re-runs scrubbing (debounce ~200ms, matching today's `Composer`). In the prototype this is the local regex engine; **in production call your existing scrub path** (`store.refreshScrub` / the `/api/scrub` result) and render its `runs` + `tokens`.
- **Credential block:** if `hasCredentials` (your store already tracks this) and mode is Enforce: right panel header reads **"Cannot send"**, a red banner appears (*"Credential detected — remove it to send. Credentials are never tokenized."*), each credential renders as a red **"blocked"** chip inline, the seam turns red, the footer shows `N credentials`, and **Send is disabled** with the message *"Send disabled while a credential is present."*
- **Send → response:** on Send the right panel swaps from "Safe to send" to **"Claude · replying…"** and streams the reply. Wire this to your existing `store.send` / `ResponseStream` streaming. A **Real ↔ Wire** segmented toggle controls display: **Real** = deanonymized (real values shown, each substituted span underlined 1.5px dotted in its category color, `title="sent as {TOKEN}"`); **Wire** = the literal `{TOKEN}` pills (the exact bytes sent). Reuse your `deanonymize()` (`lib/deanon.ts`) and the `showRawTokens` concept from `ResponseStream`. A footer caption states which view is shown. While streaming, show a **Stop**; when done, a **New message** resets to compose. **Editing the input returns to compose.**
- **Mode** (Observe/Enforce) maps to your existing mode setting; Disabled passes text through untouched (no tokens).

### 2 · Review queue  *(re-skins ReviewQueue + PatternSuggestions)*
**Purpose:** triage low-confidence spans (corp-entity heuristics + LLM-judge findings).

**Layout:** header (title "Review queue", subtitle, right: a `Judge on · scanning` status chip). Body = list (flex:1) + a 270px right rail.
- **Filter** segmented control above the list: `All · N` / `Heuristic` / `Judge`.
- **Item card** (`.ps-panel`, padding 15): top row = the span (mono, 15px/600) + a **judge/heuristic badge** (judge badge uses `--acc-tint`/`--acc`) + a category chip (`→ Customer`), and on the right a **confidence bar** (5px track, fill `--ok` if >70% else `--warn`) with the percentage. A context snippet (mono 11.5px, `--text-dim`). Action row: **Confirm as {Category}** (`--ok-tint`/`--ok`), then pushed right: **Always allow** (ghost) and **Ignore** (ghost).
- **Right rail:** a "This session" stat card (`pending` / `confirmed` / `allowed` big numbers), and a "What each action does" legend card.
- **Empty state:** when the queue clears, show a centered check badge + "Queue clear".

**Behavior:** Confirm / Always allow / Ignore each **remove the item** and update counters; Confirm also mints a token (call your existing `store.reviewAction(id, 'confirm'|'allowlist'|'ignore', category)`). The rail Review badge count = pending items. Keep the existing 8s `refreshReview` poll + the "LLM analyzing…" judge indicator (re-skinned as the header status chip).

### 3 · Vocabulary  *(promotes TokenMap / TokenMapDrawer to a full page)*
**Purpose:** browse, reveal, and forget every locally-stored token.

**Layout:** header (title "Vocabulary", subtitle "Every value you've tokenized — stored locally in SQLite, never synced."; right: a **search** input + an **Export** button). Body = table (flex:1) + a 240px right rail.
- **Category filter chips** above the table: `All · N` + one chip per category (each with a category color dot). Selected chip uses `--acc-tint`/`--acc`.
- **Table** (`.ps-panel`): column header row (Token / Category / Real value / Uses / actions). Each row: a **token pill**, the category label, the **real value masked** by default (`••••••••`), the use count (mono), and per-row **Reveal** (eye) + **Forget** (trash) ghost buttons.
- **Right rail:** a "By category" mini bar chart (count per category, bar tinted in the category color) and a local-storage reassurance card (`~/.privacy-screen`).

**Behavior:** Search filters by token or real value; category chips filter by category; Reveal toggles the mask per row; Forget removes the row (call `store.vocab` actions / `vocab forget`). Wire to your real vocab list rather than the seeded data.

### 4 · Settings  *(promotes SettingsDrawer to a full page)*
**Purpose:** modes, LLM judge, updates, customer names, data.

**Layout:** header (title "Settings", subtitle), no trust band. Two responsive columns of **section cards** (`.ps-panel`, padding 18; each card = a 30px rounded icon tile + title, optional description, then controls):
- **Screening mode** (accent card): three **radio rows** — Observe / **Enforce** *(recommended badge)* / Disabled. Selected row gets an `--acc` border + `--acc-tint` bg + filled radio.
- **Customer names:** removable **chips** + an inline add field (Enter or Add button). Adding a name must feed the scrubber.
- **Local LLM judge** (accent card): a model card (`qwen2.5-1.5b`, size/license, **Installed** badge or an install CTA + progress) and an **Enable judge** toggle (`.ps-toggle`, `role="switch"`).
- **Updates:** an **Off / Stable / Beta** segmented control + **Check now**; current version + "Up to date" line.
- **Data & privacy:** the vocab DB path + a **Clear vocab** danger button.

**Behavior:** mirror the existing `SettingsDrawer` logic and API calls (judge install/enable, update channel/check/download/apply, customer-names persistence, clear vocab). Mode + customer-name changes must re-run the current scrub (they affect the Scrub screen). Toggle = `aria-checked`, mode rows = a `radiogroup`.

### 5 · Onboarding / first-run  *(new)*
**Purpose:** confirm Claude Code is present, choose a mode, acknowledge the safety checklist before sending real data.

**Layout:** centered card (~680px) over a subtle radial-tinted background. A 3-step header (Connect · Choose mode · Safety check). Hero shield tile + "Welcome to Privacy Screen". A readiness checklist: **Claude Code detected** (green, shows version / logged-in — or the **not-found** error variant with `claude --version` / `claude login` instructions and a Re-check button) and **No API key needed / binds to 127.0.0.1**. Footer: "You can change everything later in Settings" + **Continue**. Gate first-run on `settings.claude_code.found` (already in your store) and a "first run complete" flag.

### 6 · Empty & error states  *(see `states.jsx`)*
Recreate each as the real app's state, not separate pages:
- **Empty / idle** — both panels show friendly placeholders ("Paste, type, or drop a file" / "Nothing to scrub yet").
- **Credential blocked** — the Scrub block state described above.
- **Claude not found** — full error with `claude` CLI instructions + Re-check / Install guide (replaces the current red corner toast in `App.tsx`).
- **Server offline** — "Local server unreachable. Scrubbing still works on-device." + Retry (your `health.ok === false`).

### 7 · PWA / mobile  *(roadmap, see `states.jsx → PWAMobile`)*
Same system, responsive: the rail collapses to a **bottom tab bar**, panels stack vertically, an "Add to Home Screen" hint. Not required for v1, but the layout is built mobile-friendly so a PWA manifest + service worker is the main remaining work.

---

## Token-pill system & Accessibility (hard requirements)
This is the most important visual/behavioral change and the core compliance story.

**Token pills** (`kit.jsx → Pill`, `CATS`): inline mono chips for `{TOKEN}` values. The pill is tinted from a single per-category base color via `color-mix`:
```css
.ps-pill{ /* one --cat per category */
  background: color-mix(in srgb, var(--cat) 17%, transparent);
  border:    1px solid color-mix(in srgb, var(--cat) 42%, transparent);
}
.theme-dark  .ps-pill{ color: color-mix(in srgb, var(--cat) 62%, #fff); }
.theme-light .ps-pill{ color: color-mix(in srgb, var(--cat) 64%, #000); }
```
This single rule replaces the per-category Tailwind triples in **`web/src/lib/colors.ts`** and adds light-mode support (today's `colors.ts` is dark-only and uses `*/20` opacity classes). Keep one base hue per category (table below) and let `color-mix` derive bg/border/text for both themes. `getCategoryStyle`/`getCategoryInlineStyles` collapse to "return the base hue."

**WCAG 2.1 AA — required, verify before shipping:**
- **Never rely on color alone (1.4.1):** a token's category is always carried by its **text** (`{EMAIL_1}` names its category). Color is redundant reinforcement only. In any non-token context (filter chips, summaries) pair the color dot with a **text label**.
- **Contrast (1.4.3 / 1.4.11):** body text ≥ 4.5:1, UI/large text ≥ 3:1, in **both** themes. The token palettes above are tuned for this; re-verify if you change a value.
- **Status by icon + label, not hue alone:** online/offline, credential-blocked, judge state all use an icon and words, not just a colored dot.
- **Focus visibility (2.4.7):** keep a visible 2px `--acc` focus ring on every interactive element (`*:focus-visible{ outline:2px solid var(--acc); outline-offset:2px }`). Do not remove outlines.
- **Targets & motion:** interactive controls ≥ 36px; the streaming caret / any motion must respect `prefers-reduced-motion`.
- **Semantics:** segmented controls = `role="radiogroup"`/`aria-pressed`; the judge toggle = `role="switch"` + `aria-checked`; rail items = `aria-current="page"` for the active route; icon-only buttons need `aria-label`.

---

## State management (Zustand additions to `web/src/store.ts`)
Most state already exists (`composerText`, `scrubbed`, `tokens`, `hasCredentials`, `reviewItems`, `settings`, `health`, `messages`, `showRawTokens`, `send`, `refreshScrub`, `reviewAction`, …). Add:
- `theme: 'dark'|'light'` + `setTheme` (persist `localStorage('ps-theme')`, apply root class).
- `route: 'scrub'|'review'|'vocab'|'settings'` (+ reserved `history`/`chat`) + `setRoute`. Replaces opening `TokenMapDrawer` / `SettingsDrawer` as overlays.
- Keep the existing `previewMode` (source/rendered) for the Scrub right panel; keep `showRawTokens` as the Real/Wire toggle.

No new data-fetching is required — the redesign reorganizes existing data. The prototype's seeded review/vocab arrays and its `buildReply` streamer are stand-ins for your real `/api` responses.

---

## Design Tokens (authoritative)

**Dark:** bg `#0d1117` · surface `#151b23` · surface-2 `#1b232e` · surface-3 `#212b38` · border `#283140` · border-2 `#374150` · text `#e9eef5` · text-dim `#aeb9c6` · text-faint `#7e8b9a` · ok `#3fb950` · warn `#e3a008` · danger `#f76d6d` (bg `#2a1517`, border `#69262a`).

**Light:** bg `#f4f6f9` · surface `#ffffff` · surface-2 `#f1f4f8` · surface-3 `#e9edf3` · border `#dde3ea` · border-2 `#c8d1db` · text `#161c24` · text-dim `#4d5763` · text-faint `#6e7986` · ok `#1a7f37` · warn `#9a6700` · danger `#c4393f` (bg `#fdeced`, border `#f3c2c4`).

**Accent — Flow:** dark `--acc #37d39a`, `--acc-2 #54e0ad`, `--acc-ink #04201a`; light `--acc #0a8f5f`, `--acc-2 #0b7d54`, `--acc-ink #ffffff`. (The alternative directions, if ever wanted: Console blue `#4c8dff`/`#1f6feb`, Chat violet `#b08bff`/`#6d3fd6`.)

**Token category base hues (`--cat`):** ip `#4c8dff` · customer `#b07cff` · email `#26c281` · host `#22c1d6` · phone `#f59e0b` · addr `#fb923c` · url `#2dd4bf` · account `#fb7185` · user `#f0a5c0` · path `#94a3b8` · credential `#f76d6d`.

**Typography:** family `IBM Plex Sans` / `IBM Plex Mono`. Scale: page title 20/600 (-0.01em); section/card title 14.5–15/600; body 12.5–13.5/400–500 (line-height 1.5–1.7); eyebrow 11/600 uppercase, letter-spacing .09em, `--text-faint`; token/mono .86em; button label 13/600 (sm 12). 

**Radii:** panel 12 · inset/input 10 · button 9 (sm 8) · chip 7 · pill 6 · rail brand tile 12 · toggle 11. **Spacing:** common gaps 6/8/10/12/16/24; panel padding 15–18; screen padding 24. **Controls:** button height 36 (sm 30, primary CTA 42) · toggle 38×22 · status dot 7 · rail 80px wide. **Shadow:** `var(--shadow)` per theme (above).

**Icons:** lucide-react (already a dependency). The reference `Ic` set maps to lucide equivalents: shield, lock, eye, eye-off, check, x, alert-triangle, settings, search, plus, copy, send, chevron-down/right, sparkles (judge), file-text, book-open, list, scan-line (scrub), message-square (chat), trash-2, arrow-right, refresh-cw, download, filter, sun, moon, link, history, flag. Use lucide directly; no custom SVG needed.

---

## Suggested implementation order
1. **Theme foundation** — fonts + CSS variables + Tailwind color tokens + `theme` store slice + root class. Verify both themes render the existing app acceptably.
2. **Rail + Shell + routing** — build `FlowRail` and `FlowShell`, convert the two drawers into routes.
3. **Token-pill rewrite** — replace `lib/colors.ts` with the `color-mix` system; verify AA + the no-color-alone rule.
4. **Scrub & Send** — recompose `Composer`/`PreviewPane`/`ResponseStream` into the two-panel + footer layout; wire live scrub, credential block, send/stream, Real/Wire.
5. **Review**, **Vocabulary**, **Settings** pages.
6. **Onboarding + error/empty states.**
7. **(Roadmap)** PWA: bottom-tab responsive layout + manifest + service worker.

---

## Files
**In this bundle (`reference/`):**
- `Privacy Screen — Flow.html` — interactive prototype (behavior source of truth). Open in a browser.
- `Privacy Screen Redesign.html` — static canvas of all screens, dark + light (visual source of truth).
- `kit.jsx` — **design system**: theme CSS, `CATS`, `Pill`, `Ic`. Port this first.
- `scrub-engine.jsx` — reference tokenizer (data-shape reference only).
- `flow-chrome.jsx` / `flow-app.jsx` / `flow-screens.jsx` — the Flow rail/shell, Scrub screen + app state, and Review/Vocab/Settings.
- `sample.jsx` — sample content + the deanonymized-render helper.
- `design-canvas.jsx`, `legend/console/flow/chat/screens/settings/onboarding/states.jsx` — back the static canvas (incl. alt directions, onboarding, states, PWA).

**Target files to change in `web/` (current repo):**
- `src/index.css` — fonts + CSS variables + focus ring.
- `tailwind.config.ts` — font families + var-backed color tokens.
- `src/store.ts` — `theme`, `route` slices.
- `src/App.tsx` — replace the `PanelGroup` shell with Rail + Shell + routed screens.
- `src/lib/colors.ts` — replace per-category Tailwind triples with the `color-mix` pill system (+ light mode).
- `src/components/Composer.tsx`, `PreviewPane.tsx`, `ResponseStream.tsx` → **Scrub & Send**.
- `src/components/ReviewQueue.tsx`, `PatternSuggestions.tsx` → **Review**.
- `src/components/TokenMap.tsx`, `TokenMapDrawer.tsx` → **Vocabulary** page.
- `src/components/SettingsDrawer.tsx` → **Settings** page.
- New: `Rail`, `Shell`, `Onboarding`, and the error/empty state components.

