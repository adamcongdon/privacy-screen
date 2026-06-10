# Family Photo Guardian — v1 Plan

> Status: Planning (E3, research-backed). ISA: `~/.claude/PAI/MEMORY/WORK/family-photo-guardian-planning/ISA.md`. Last updated 2026-06-08.

## TL;DR

A free, open-source browser extension that helps non-technical grandparents, parents, and teens harden their privacy on Meta (and later Google) and clean their photos before sharing. v1 ships as a Chrome + Edge extension with two tabs — **Settings Coach** (deep-link guide, zero DOM interaction with Meta) and **Photo Scrubber** (EXIF/GPS strip, optional C2PA, optional watermark, small batches via File System Access API). Mobile-native is a documented v2 gap, not v1 scope.

## Why this exists

- **TELOS G12** — "Privacy Screen Bootstrap + Family AI Threat Awareness Extension"
- **Brief** (from Adam, 2026-06-08): a family-safety jumping point from `privacy-screen`, biggest concern is *protecting people*, as free as possible
- **Threat-model conclusion** — in 9 of 11 threat horizons, platform-settings hygiene has higher leverage than photo scrubbing. **The Coach IS the product. The Scrubber is an honest small companion tool.** Public exposure (what gets posted on Meta) drives the dominant share of family-photo AI risk; locally stripping a photo no scraper would have reached doesn't move the needle.

## Audience

Three non-technical user types, asymmetric mobile vs desktop habits:

| Type | Primary device | Coverage in v1 |
|---|---|---|
| Grandparents | Desktop browser (Chrome / Edge) | Full — extension is the right surface |
| Parents | Desktop for settings work, mobile for consumption | Full — settings get configured on desktop |
| Teens | Mobile in-app for Meta | Known gap — closed in v2 mobile companion |

**v1 stopgap for teens:** "Send this to your teen on mobile" share-link in the Coach popup that opens the Meta app's settings via universal-link, with a checklist screenshot inline. Imperfect but covers the case where a parent runs the Coach for their teen.

## Form factor decision

**Browser extension wins v1.** Three lenses agree:

| Lens | Verdict | Evidence |
|---|---|---|
| Adoption friction | Extension >> desktop app >> mobile | 30-sec install from store, no installer trust, no app-store gate |
| Dev cost | Extension ~3-5× cheaper than Tauri/Electron, ~10× cheaper than native iOS + Android | Research probe: $0-2.4k DIY vs $30-90k native pair |
| Threat coverage | Extension hits the primary surface (Meta settings on desktop) but misses teen-on-mobile | Probe: teens edit Meta settings in-app on mobile per Meta's own 2024 teen-account rollout |

**Browser scope:** Chrome + Edge primary (Coach + Scrubber). Firefox + Safari secondary (Coach-only — no File System Access API). Brave deferred (FSA flag-gated; user-side flag-flipping is unrealistic for non-technical audience).

## Scope split

### v1 ships

**Settings Coach — Meta first:**
- Privacy Checkup walk-through (deep-link to `facebook.com/privacy/checkup` and Instagram equivalent)
- Face Recognition disable
- Profile → Friends-Only or Custom
- Off-Facebook Activity disable
- AI training opt-out (Meta's "Manage AI Information" surface)
- Tagging permissions hardened
- Per step: popup shows screenshot + plain-English explanation + "Open settings" button + "Mark complete" checkbox

**Photo Scrubber — Chromium-only via File System Access API:**
- Drag-drop photo OR `showOpenFilePicker` for single/multi-file
- Show what's in the metadata before any action — educate first
- Strip GPS, camera serial, maker note, creator name by default
- Optional C2PA "Do Not Train" assertion (honest framing — see Scrubber spec below)
- Optional visible watermark with user-chosen text (off by default)
- "Print Clean Version" — temp file without watermark, deletes after print dialog
- Capped at ~2k photos / 20GB per batch in popup; larger via extension-page-tab pattern

**Distribution:** Chrome Web Store + Edge Add-ons (+ Firefox AMO for Coach-only build).
**License:** MIT, open source, all features free.

### v2 deferred

- Google Account Coach (Data & Privacy, ad settings, YouTube history)
- Native Messaging companion (.NET 8 single-file binary) for large-library scrubbing (hundreds of GB)
- iCloud + school-account walk-throughs
- Send-to-teen mobile share-link with deeper IG/FB deep-link coverage
- Safari extension (requires Apple Developer + notarization)

### v3+ aspirational

- Native iOS/Android companion app for the teen-on-mobile gap
- Optional hosted vision-LLM augmentation (opt-in, paid tier — local extension stays free)
- Browser-shared-account family-tree mode (audit a teen's account on the parent's session, with the teen present)

## Coach feature spec — Meta-safe architecture

**The Coach injects NO content scripts into `*.facebook.com` / `*.instagram.com` / `*.meta.com`.** All UI lives in the extension popup. The only Meta interaction is `chrome.tabs.create({url})` to a canonical settings URL — equivalent to the user clicking a bookmark.

**Why** — Probe 1 (Meta extension TOS posture, research-cited):
- Louis Barclay's "Unfollow Everything" (2021) — free, open-source, no monetization, user-side ONLY automation → permanent ban + Chrome Web Store takedown
- Meta's consistent enforcement trigger is "automated means to access or interact," not commercial use
- 12-year track record of *tolerating* popup-driven deep-link guides that never inject on Meta domains

**Risk classification:**

| Pattern | Risk | Decision |
|---|---|---|
| Popup UI + `chrome.tabs.create` deep links + bundled screenshots | MEDIUM | **v1 SHIP** |
| Content script on Meta domain to highlight the toggle | HIGH | NO |
| Content script + automated click on user consent | HIGH | NO |
| Headless RPA | DO-NOT-SHIP | NO |

**UX flow per setting:**
1. Popup shows bundled screenshot of the target setting + plain-English explanation
2. "Open Meta privacy checkup →" button opens canonical URL in new tab
3. User makes change themselves — consent IS the click
4. User returns to popup, clicks "Mark complete"
5. Popup updates checklist progress; `chrome.storage.local` persists state

**Education content** — bundled with the extension, updated via extension update cycle:
- What each setting actually controls
- Why it matters for AI training, deepfakes, stalking, identity theft
- What each setting does NOT protect against (honest)

## Scrubber feature spec — honest framing

**Honest copy block — appears verbatim in the Scrubber tab UI:**

> Stripping EXIF data and GPS coordinates protects against direct-share leaks (AirDrop, email, file send). Major social platforms — Instagram, Facebook, TikTok, X — already strip this metadata on upload, so it does not add protection there.
>
> Adding a C2PA "Do Not Train" assertion is a machine-readable opt-out signal. As of 2026, only Adobe Firefly and Spawning-partnered models commit to honor it. OpenAI, Google, Meta AI, Midjourney, xAI, Anthropic, and Black Forest Labs do not. Most social platforms strip the C2PA manifest on upload before any AI scraper ever sees it.
>
> A visible "Private — Not for Training" watermark deters casual reuse. It does not block AI training.
>
> The strongest protection from AI exposure is not posting publicly. The Coach tab is more useful than this tab for that.

**Where C2PA actually travels** (research probe — narrow but real):
- iMessage — full metadata pass-through
- Cloudflare Images (opt-in, Feb 2025)
- Direct email or AirDrop file send

The Scrubber surfaces this to the user: "If you share via iMessage or self-host, your C2PA assertion stays. If you upload to Instagram, it gets stripped."

**Metadata fields — scrubbed by default:**
- GPS coordinates (latitude, longitude, altitude)
- Camera serial number
- Owner name / artist / copyright when PII-sensitive
- MakerNote (often contains camera-user data)
- Pre-edit thumbnail (frequently un-redacted)

**Metadata fields — preserved by default:**
- Capture date/time (useful for organization)
- Camera model (no PII)
- ISO / aperture / shutter speed
- Image dimensions
- Color profile

**C2PA library:** `c2pa-rs` via the open-source `c2patool` CLI (MIT / Apache-2.0). v1 path — bundled WASM build in the extension popup (size ~5MB; acceptable on a tab the user opts into). v1.5 fallback — Native Messaging companion for stability at scale.

**File System Access scale envelope** (research probe):
- ≤2k photos / ≤20GB → popup handles cleanly
- 2k-50k photos → extension-page-tab pattern (survives popup-close)
- 50k+ photos / hundreds-of-GB → v1.5 Native Messaging companion (the .NET 8 binary, single-file `osx-arm64` / `win-x64`)

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Browser extension MV3 | Substrate constraint — dotnet has no browser-extension story |
| Language | TypeScript | Only honest path for MV3 |
| UI | React + Tailwind (or Preact for size) | Familiar, small bundle, accessible primitives |
| Schema | `platforms.json`, `settings-catalog.json` | Update catalog without code change; reviewer can audit diffs |
| C2PA | `c2patool` (Rust, MIT/Apache-2.0) via WASM v1, Native Messaging v1.5 | Industry standard |
| EXIF | `piexifjs` in popup (v1) → `exiftool-vendored` via Native Messaging (v1.5) | Pure-JS path keeps v1 self-contained |
| State | `chrome.storage.local` + IndexedDB for FSA handles | MV3-native |
| Build | bun + Vite + `web-ext` | Adam's preferred toolchain |
| Testing | bun test (unit) + Playwright (e2e on Chrome) | Familiar to Adam |
| CI | GitHub Actions | Standard |

**Dotnet preference tension — resolved:**
- v1 extension MUST be TypeScript (MV3 forbids dotnet) — substrate constraint, not preference override.
- v1.5 Native Messaging companion → dotnet 8 single-file binary. This is where Adam's preference lands cleanly: small CLI that strips EXIF / embeds C2PA / writes back protected copies, called from the extension via `chrome.runtime.connectNative`.
- v3+ desktop standalone (if ever) → dotnet MAUI or Avalonia.

## Architecture sketch

```
~/code/family-photo-guardian/
├── extension/
│   ├── manifest.json          # MV3, no host_permissions on Meta domains
│   ├── popup/                 # tabs: [ Coach | Scrubber | About ]
│   ├── background/            # service worker (chrome.runtime, chrome.tabs only)
│   ├── coach/
│   │   ├── platforms.json     # Meta v1, Google v2
│   │   ├── settings-catalog.json
│   │   └── screenshots/       # bundled, updated via extension update
│   ├── scrubber/
│   │   ├── exif-strip.ts
│   │   ├── c2pa-embed.ts      # WASM
│   │   ├── watermark.ts       # canvas
│   │   └── fsa-pipeline.ts
│   └── shared/                # types, education content
├── public/                    # icons, store-listing assets
├── tests/
├── scripts/                   # build.ts, package.ts, screenshot-update.ts
├── README.md                  # honest framing — no AI-proof copy
├── LICENSE                    # MIT
└── Plans/
    └── FAMILY_PHOTO_GUARDIAN.md  # symlink/mirror of this file
```

## Distribution + signing

| Store | Cost | Sign | v1 status |
|---|---|---|---|
| Chrome Web Store | $5 one-time dev account | Auto via CWS | PRIMARY |
| Edge Add-ons | Free | Auto | PRIMARY |
| Firefox AMO | Free | Auto via review | SECONDARY — Coach-only build |
| Safari Mac App Store | $99/yr Apple Dev | Notarization | DEFERRED v1.5 |

No installer for v1. Auto-updates ride the store channel.

## Privacy + telemetry stance

**Zero default-on data egress.** Hard constraint.

- No analytics. No crash reporting. No "anonymous usage metrics." No A/B testing infrastructure.
- All state lives in `chrome.storage.local`. Never synced to any server.
- The only network call the extension makes is `chrome.tabs.create({url})` to open canonical platform settings URLs — same as the user typing the URL.
- C2PA library runs entirely in WASM (or local Native Messaging companion) — no network.
- README front-matter: "We collect nothing. There is no server. There is no account."

**Honest README sections — MUST exist before v1 ships:**
- "What this protects you from" (specific scenarios)
- "What this DOES NOT protect you from" (be specific — name AI training, deepfakes, account theft)
- "How C2PA works in 2026" (honest, link the research)
- "Why we don't have a mobile app yet" (the teen gap and our plan to close it)

## License + business model

- **MIT license.** All features free. Code public from day 1.
- v1 and v2 free forever.
- Paid tier reserved for v3+ IF hosted LLM or cloud vision augmentation gets incorporated. Opt-in. Hosted features only. The local extension stays free, MIT, forever.

## Risk register

| Risk | Trigger | Mitigation |
|---|---|---|
| Meta enforcement against the Coach | Meta updates TOS to target deep-link guides | Pivot to pure educational PDF + checklist; lose the extension surface but keep the content |
| Meta privacy-settings URLs change | Quarterly UI refresh | Bundled screenshot pipeline + extension update; ship updates on auto-channel |
| File System Access API removed from Chromium | Unlikely but possible | Fall back to `showOpenFilePicker` (drag-drop, single/multi-file only) |
| C2PA-honor news degrades further | Adobe rolls back commitment | Demote C2PA to off-by-default-with-note; remove from default Scrubber flow |
| Solo-dev burnout | Maintenance burden exceeds passion budget | Honest README: "this is a passion project, response time best-effort"; community-PR friendly setup from day 1 |

## Open questions for Adam

1. Approve "Coach IS the product, Scrubber is honest companion" framing?
2. Approve Chrome + Edge first / Firefox + Safari deferred browser scope?
3. Approve `~/code/family-photo-guardian/` as the sibling repo path?
4. Want the `PROJECTS.md` row committed now, or wait?
5. C2PA — include as opt-in v1 feature with honest framing, or defer to v2? Probe says it's mostly performative.
6. Bootstrap path — scaffold the extension skeleton (manifest, popup shell, build pipeline) as the next step, or wait for further sign-off?

## Next steps (post-approval)

1. Commit this doc to `~/code/privacy-screen/Plans/FAMILY_PHOTO_GUARDIAN.md` (DONE — this file)
2. Add row to `~/.claude/PAI/USER/PROJECTS/PROJECTS.md` (HIGH priority, prefix `[FPG]`)
3. Bootstrap `~/code/family-photo-guardian/` sibling repo with extension skeleton (Forge auto-included at code time per E3+ binding)
4. Coach v1 first feature — Meta Privacy Checkup walkthrough, single-platform single-flow demo
5. Scrubber v1 first feature — drag-drop single photo → show metadata → strip GPS → save copy
6. Both demoable end-to-end on Adam's machine within ~2 weeks of code start

## Research log

Plan grounded in 4 parallel research probes fired during the E3 planning run:

| Probe | Agent | Finding (one-line) |
|---|---|---|
| Meta extension TOS posture | Grok | Deep-link guide MEDIUM risk; content-script highlight HIGH; click-automation DO-NOT-SHIP. Barclay precedent (2021). |
| C2PA honor rate 2026 | Perplexity | Only Adobe + Spawning honor on input; all major social platforms strip on upload. Mostly performative. |
| File System Access API in MV3 | Claude | Chromium-only; popup OK for ≤2-5k photos; large libraries need Native Messaging companion. |
| Mobile extension adoption | Gemini | Ship extension v1, accept teen-mobile as v2 gap; hybrid-in-v1 is the trap. |

Full citations in ISA Decisions log at `~/.claude/PAI/MEMORY/WORK/family-photo-guardian-planning/ISA.md`.

---

*Plan generated 2026-06-08 via PAI Algorithm v6.3.0 E3 run. Effort: research+plan, no code yet.*
