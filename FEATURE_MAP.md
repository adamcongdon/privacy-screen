# privacy-screen feature map

Agent navigation. Loopback 127.0.0.1:31338. Credentials BLOCK. Judge loopback-only.

**Boot (dev):** `bun run start` then open http://127.0.0.1:31338
**Verify:** `bash scripts/verify.sh`
**Tests:** `bun test tests/`
**Typecheck:** `bun run lint`
**Land:** PR to `beta`. Merge only via the repo-maint gate.

| User thing | Route / API | Notes |
|---|---|---|
| Health | GET /api/health | `{ ok, version }` live-proof minimum |
| Scrub paste | #scrub ; POST /api/scrub | |
| Send | POST /api/send | needs `claude` on PATH; credentials BLOCK |
| PDF | POST /api/files ; POST /api/files/pdf/render | |
| xlsx/csv | POST /api/files then inspect/commit under /api/files/xlsx | |
| Review queue | #review ; /api/review ; /api/patterns | |
| Vocab | /api/vocab | |
| Settings / judge | #settings ; /api/settings ; /api/judge-control | |

**Hard constraints:** loopback bind, credential BLOCK, 1MB JSON / 5MB multipart caps, judge refuses non-loopback.
