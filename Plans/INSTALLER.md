---
type: design
status: scoping
component: installer / auto-update
filed: 2026-06-02
filed_by: Adam
issue: #4
---

# Installer + Auto-Update — Design + Scoping

> **Scope of THIS iteration:** scaffold the version-**check** path only.
> No download. No install. No execution of foreign bytes. No telemetry.
> The user must opt-in by flipping `update_channel` from `off` to `stable`.

## Why

privacy-screen is local-first. The whole point is that nothing leaves the
machine without explicit user intent. Auto-updaters have historically been
the loudest exception to that rule: they phone home with version + OS +
machine ID, they ship code that runs without user review, and they tend to
accumulate trust the user never explicitly granted.

We still need a way to tell users when a new release exists — security
fixes especially. The compromise is **opt-in version-checking, never
auto-install, never silent**:

- One HTTPS GET to a static JSON manifest hosted on GitHub raw.
- No identifying information sent. No POST. No User-Agent customization
  beyond the bun default.
- If a newer version exists, surface it in the UI. The download +
  install is a manual step the user performs on their own terms.

### In scope for THIS iteration

- A version-check library (`server/lib/update-check.ts`).
- A Hono route (`/api/version`) that exposes current + latest known.
- A config-gated default of `off` — zero network activity until the
  user flips it.
- A release-manifest schema + example.
- A `build-release.ts` script that produces single-file binaries and a
  matching manifest for ad-hoc tagged releases.

### Out of scope for THIS iteration

- Actual binary download from the manifest URL.
- Signature verification of downloaded bytes.
- Spawning an installer / replacing the running binary.
- Rollback / atomic-replace semantics.
- Delta updates.
- Code-signing / notarization (cost-flagged below).
- Telemetry of any kind. **There will never be telemetry in privacy-screen.**
- A "background daily check" — the check fires only when the route is hit.

## Distribution targets

| Platform        | Status (this iter) | Chosen format                                          | Notes                                                                          |
|-----------------|--------------------|--------------------------------------------------------|--------------------------------------------------------------------------------|
| darwin-arm64    | this iter          | single-file binary; future `.dmg` or `brew tap` formula | Primary dev target; `bun build --compile --target=bun-darwin-arm64`.           |
| darwin-x64      | this iter          | single-file binary; future `.dmg` or `brew tap` formula | Compiled but not regularly smoke-tested.                                       |
| windows-x64     | this iter          | single-file `.exe`; future `.msi` via WiX or Inno      | Compiled via `bun build --compile --target=bun-windows-x64`.                    |
| linux-x64       | deferred           | `.tar.gz` then later `.deb` / `.rpm` / AppImage        | `keytar` requires `libsecret-1-dev`; verify build before adding to targets.     |
| linux-arm64     | future             | `.tar.gz`                                              | After linux-x64 is stable.                                                     |

We deliberately ship a single self-contained binary per platform first
and worry about platform-native installer wrappers (`.dmg`, `.msi`,
`brew tap`, `.deb`) as separate, smaller issues once the binary itself
is proven to work outside a dev checkout.

## Build pipeline

`scripts/build-release.ts` is the one-shot release builder. Steps:

1. Read `package.json#version` — that becomes the manifest version.
2. Build the web bundle: `bun run web:build` → `web/dist/`. The bundle
   is read from disk at runtime via `serveStatic({ root: './web/dist' })`,
   so the binary must be shipped alongside `web/dist/`. (We will
   embed-into-binary as a follow-up — see Future Work.)
3. For each target in `{darwin-arm64, darwin-x64, windows-x64}`:
   - `bun build --compile --target=bun-<target> server/server.ts --outfile dist/privacy-screen-<target>[.exe]`
   - Hash the resulting file with `Bun.CryptoHasher('sha256')`.
   - Record `{ url, sha256, size_bytes }` in the manifest.
4. Write `dist/release-manifest.json`.
5. Exit non-zero if any step fails.

The script is intentionally dumb. It does not push to GitHub, it does not
sign anything, it does not modify the live manifest at
`release-manifest.json` in the repo root. Releasing means manually:

1. Run the script locally.
2. `gh release create vX.Y.Z dist/privacy-screen-* dist/release-manifest.json`.
3. Commit `dist/release-manifest.json` to `release-manifest.json` at repo
   root so the raw URL serves the new version.

This means cutting a release is a deliberate human action, not a CI side
effect, which matches the local-first / no-surprises ethos.

## Release manifest

See `release-manifest.example.json` for the canonical shape. Schema (TS):

```ts
interface ReleaseManifest {
  version: string;                    // semver "major.minor.patch"
  channel: 'stable' | 'beta';         // future-proofed for prerelease tracks
  released_at: string;                // ISO 8601 timestamp
  notes_url?: string;                 // optional changelog/release page
  minimum_supported_version?: string; // semver; below this we recommend reinstall
  platforms: Record<PlatformKey, {
    url: string;                      // direct download URL (https only)
    sha256: string;                   // 64-char lowercase hex
    size_bytes: number;               // for UX, not security
  }>;
}

type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';
```

Validation is strict: any malformed `sha256` (must match
`/^[a-f0-9]{64}$/`) or missing field aborts the check — we surface the
failure rather than degrading silently. A malformed manifest is treated
as "no update available", never as "trust me, here's an update".

## Update channel

Configured via `update_channel` in `PRIVACY_CONFIG.yaml`:

| Value     | Behavior                                                                                  |
|-----------|-------------------------------------------------------------------------------------------|
| `off`     | **Default.** `GET /api/version` returns the local version and never touches the network. |
| `stable`  | `GET /api/version` performs a single HTTPS GET to the manifest URL and compares versions. |
| `beta`    | Same as `stable` but only considers releases marked `channel: 'beta'` in the manifest.    |

Rules enforced in code:

- HTTPS only. The manifest URL is validated to start with `https://`
  before any fetch. (Implementation defers strict scheme enforcement to
  a follow-up, but `update_manifest_url` ships with an `https://` default.)
- Content-addressed. Even when we ship the actual downloader in a
  future iteration, the binary will be addressed by its sha256 — the
  filename is convenience, the hash is identity.
- No telemetry. The request carries no query string, no headers we
  add ourselves beyond what `fetch()` defaults to, no body. We send
  nothing about the user's machine, version, or environment beyond
  what an unauthenticated GET to a static file inherently reveals to
  the host (which is GitHub).
- Bounded. The fetch is wrapped in an `AbortController` with a 5 s
  default timeout and a single attempt. No retry storm.

## Code signing

This is the part that costs real money. Honest accounting:

- **macOS — Apple Developer ID Application certificate:**
  ~USD $99/year. Required for Gatekeeper to stop telling users the app
  is "from an unidentified developer". Notarization through Apple is
  free but requires the cert.
- **Windows — code-signing certificate:**
  Standard OV cert ~USD $200-300/yr; EV cert (instant SmartScreen
  reputation) ~USD $300-500/yr. Without one, SmartScreen will warn on
  every first-run download for an extended period.
- **Linux:** no equivalent gatekeeper. Distro-specific signing (GPG,
  apt repo signing) is essentially free.

**Recommendation for THIS iteration:** ship unsigned with clear,
copy-pasteable instructions ("right-click → Open" on macOS first run;
SmartScreen "More info → Run anyway" on Windows) and a sha256 the user
can verify themselves. Promote signing to a separate follow-up issue
once we have non-trivial usage and the cost is justified.

## Future work (explicitly not in this iteration)

1. **Binary embedding.** Today `web/dist/` is loaded from disk. Embed
   it via `Bun.embed` (or a build-time JSON inlining step) so the
   release is genuinely a single file.
2. **Download path.** A `POST /api/update/download` that fetches the
   binary for the user's platform, verifies sha256 against the
   manifest, and stages it next to the running binary — without
   replacing it. The replace + relaunch step stays manual.
3. **Signature verification.** Sign the manifest itself with a
   long-lived offline key; verify with a pinned public key in the
   binary. This is independent of OS code-signing and exists to prove
   *we* published this manifest, not just "GitHub served some JSON".
4. **Atomic install + rollback.** Stage-then-swap, with the previous
   binary kept for one-click rollback.
5. **Delta updates.** Only relevant once the binary is large enough to
   matter. Probably never.
6. **Signed release notes.** Currently `notes_url` is just a link.
   We could ship the notes inline + signed.
7. **`linux-x64` smoke build.** Confirm `keytar` builds against
   `libsecret-1-dev` in a container before claiming Linux support.

## Decision log

- **`bun build --compile` over `pkg`/`nexe`.** We already require bun
  for development and runtime. Adding a second packager would mean
  maintaining two binary-production paths and explaining why. `bun
  build --compile` is supported, targeted (`--target=bun-<os>-<arch>`),
  and produces a single static binary that includes the bun runtime
  and our TS source. Cost: bun's cross-compile maturity is younger
  than pkg's. We accept the risk and document failure modes if/when
  we hit them.
- **Static JSON manifest over a release-server.** Local-first
  principle. A static file on GitHub raw is observable, cache-friendly,
  CDN-backed, and adds zero new attack surface we have to operate. The
  only thing it can't do is push a notification, and we don't want
  push notifications. The check happens when the user opens the app
  with the channel enabled — that is the right cadence.
- **Default `update_channel: off`.** Surprise network activity is
  exactly the kind of thing the rest of this codebase exists to
  prevent. Off-by-default means a fresh install is provably silent
  on the network until the user explicitly enables checking.
- **No telemetry, ever.** Stated here so future contributors do not
  "improve" the update check by adding a User-Agent that includes
  the OS + arch + version. The whole point is that the request says
  nothing.
- **Manifest URL configurable.** Mirrors are useful for air-gapped
  installs and for users who want to point at their own pinned
  copy. Default points at the upstream repo's raw URL; users who
  fork can repoint trivially.
- **HTTPS enforced.** Plain-HTTP manifests are rejected at config
  validation time (follow-up — the current default is already https,
  and a non-https URL would still be a deliberate user action).

