# Socket Alert Remediation — exceljs@4.4.0

## The finding

Socket Security flagged `exceljs@4.4.0` on PR #31 with:

- **Severity**: High (Warn)
- **Alert**: "Obfuscated code: npm `exceljs` is 90.0% likely obfuscated"
- **Confidence**: 0.90
- **Component scores**: Supply Chain 87 · Vulnerability 100 · Quality 100 · Maintenance 82 · License 100

Vulnerability and License scored 100. The flag is the obfuscation heuristic alone.

## Audit — what's actually in the package

`exceljs` ships **two parallel builds** in one tarball:

| Path | Purpose | Reader-friendly? |
|---|---|---|
| `excel.js` (437 bytes) | Node entry point — `require('./lib/exceljs.nodejs.js')` | Yes |
| `lib/**/*.js` | Source-form Node code (workbook, worksheet, xlsx, csv, stream, utils) | **Yes — clean `'use strict'`, named requires, ordinary class syntax** |
| `dist/exceljs.min.js` (947 KB) | Browser UMD bundle, minified | **No — minified UMD output** |
| `dist/exceljs.js` (1.9 MB) | Browser UMD bundle, unminified | Yes (large) |
| `dist/exceljs.bare*.js` | Browser bundle without polyfills | Same as above |

The Node entry point we actually load (`"main": "./excel.js"`) reaches **only** `lib/` source files. The `dist/` directory is loaded only when bundlers honor the `"browser"` field — and we don't bundle this for the browser (it's a server-only dep).

**I spot-checked lib files** (`doc/worksheet.js`, `xlsx/xlsx.js`, `utils/utils.js`, `doc/workbook.js`, `exceljs.nodejs.js`). All are idiomatic, readable JavaScript — `const fs = require('fs')`, standard class definitions, no string-array indirection, no eval, no escaped unicode chains.

**Conclusion**: Socket's 90% obfuscation score is the heuristic recognizing the high-entropy minified browser bundles in `dist/`. It's a true-positive on those files, but a **false-positive for the code we execute**.

## Other signals
- **License**: MIT (verified in `node_modules/exceljs/LICENSE`)
- **Author**: Guyon Roche — long-running maintainer of the official org
- **Repo**: https://github.com/exceljs/exceljs — 14k stars, actively maintained
- **Vulnerability score 100**: no known CVEs at 4.4.0
- **Supply Chain score 87**: deductions presumably from the obfuscation finding itself

## Risk assessment

For this app's use case (privacy-screen handling user PII):
- The xlsx data path runs server-side. Code path goes `entry.text() → exceljs Workbook.xlsx.load(buffer) → traversal → writeBuffer()`. No external network, no eval, no dynamic require beyond what's statically imported.
- We can verify what we ship by examining `lib/` files at install time. If a future version sneaks obfuscated code into `lib/`, we'd want to catch it — see Option D below for the durable defense.
- The risk this finding describes (an attacker hiding malicious code inside obfuscation) is not present in the code we execute.

## Options, ranked

### Option A — Document audit + Socket-ignore on this PR
- Reply to the Socket bot: `@SocketSecurity ignore npm/exceljs@4.4.0`
- Add this plan file to the repo as the audit record
- Pin `exceljs` to exact `4.4.0` in `package.json` (no caret) so future versions trigger a fresh review
- Effort: 15 minutes
- Risk: minimal — based on direct inspection
- **Trade-off**: trusts our audit; doesn't protect against future package compromise unless we re-audit on every bump

### Option B — Same as A, plus a pre-install verification gate
- Add a script (`scripts/verify-exceljs-lib.sh` or `.ts`) that runs in CI before `bun install` completes:
  - Decline if `node_modules/exceljs/lib/**/*.js` files exceed an entropy threshold or contain `\x` escape chains
  - Fail loud, block CI
- Effort: 2 hours
- Risk: lower — protects against future supply-chain swap on update
- **Trade-off**: brittle if the package legitimately changes shape

### Option C — Swap to a smaller alternative
Candidates that meet our requirements (read .xlsx + write .xlsx back):

| Lib | Pros | Cons |
|---|---|---|
| `xlsx-populate@1.21.0` (MIT, dtjohnson) | No browser-bundle dist, smaller surface, focused scope | Last update older than exceljs; less battle-tested; need to verify Socket signature first |
| `xlsx` (SheetJS) | Massive ecosystem | Already has npm advisories; was removed from npm at one point; SheetJS Pro pressure |
| `@e965/xlsx` (community fork of SheetJS) | Open continuation | Smaller community, less battle-tested |
| `read-excel-file` | Read-only, focused | Doesn't satisfy re-serialize requirement — DISQUALIFIED |
| Custom: `jszip` + raw XML walk | We own the surface; minimal deps | 1-2 days work; reinventing edge cases (shared strings, formats, types) |

- Effort: 1-2 days (xlsx-populate); 2-4 days (custom)
- Risk: real — trading a battle-tested mature lib for an unknown surface
- **Trade-off**: may avoid future audits but introduces new bugs in a privacy-critical code path

### Option D — Stay on exceljs but harden the supply chain
- Pin `exceljs@4.4.0` exact (no `^`).
- Add a CI gate (`scripts/audit-deps.sh`) that:
  - Re-runs Socket scan on every `bun install` in CI
  - Fails if **new** alerts appear (existing acknowledged ones pass)
  - Treats new "Critical" or "High" alerts as merge-blocking
- Document the acknowledged-alerts list in `Plans/socket-acknowledged.md` (this file + future entries)
- Effort: 3-4 hours
- Risk: very low — defense-in-depth on the same package
- **Trade-off**: requires Socket org setup; one-time cost amortized across all dependencies

### Option E — Defer
- Wait until exceljs cuts a new release that addresses Socket's heuristic (maybe by splitting the browser bundle to a separate package)
- Effort: 0
- Risk: leaves the alert open on every PR; CI noise grows
- **Trade-off**: not really a remediation, just a pause

## Recommendation

**Option A + Option D combined**, executed as one PR:

1. Document this audit (this file, committed to the repo).
2. Pin exact version: `"exceljs": "4.4.0"` (no caret).
3. Reply `@SocketSecurity ignore npm/exceljs@4.4.0` on PR #31 with a link to this plan.
4. Add a `scripts/audit-deps.ts` that runs on every install + in CI, treating the acknowledged list as an exception (everything else blocking).
5. Establish `Plans/socket-acknowledged.md` as the durable acknowledged-alerts ledger.

This gets PR #31 unblocked today, leaves an audit trail, and sets up the durable defense for future supply-chain alerts on any dep.

If the user is uncomfortable with that and prefers swap-and-replace, the next-best choice is **Option C → xlsx-populate** — but only after running a Socket scan against it first to confirm it's not flagging anything worse.

## What to NOT do
- Don't use `@SocketSecurity ignore-all` — that disables the entire scanner. Use the per-package form.
- Don't bump to a newer exceljs minor version blindly. Pin exact and re-audit before bumping.
- Don't roll our own xlsx parser unless we're willing to own all the edge cases (shared strings, merged cells, types, encoding) — these are subtle and a privacy-screen app cannot afford a corrupted-output bug.
