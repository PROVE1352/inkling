# 0961. Import caps from the environment

- Status: Accepted
- Date: 2026-11-07

## Context
The upload (25 MB), unpacked total (50 MB), per-entry (25 MB) and file-count (300) caps were
constants spread over `md/importer.ts` and `routes/exportImport.ts`. A team's Notion export with
images easily exceeds them, while small hosts (768 MB container) need them low.

## Decision
- One module, `apps/server/src/md/importLimits.ts`, reads `IMPORT_MAX_UPLOAD_MB` (25),
  `IMPORT_MAX_UNPACKED_MB` (50), `IMPORT_MAX_ENTRY_MB` (25), `IMPORT_MAX_FILES` (300) and the existing
  `IMPORT_MAX_PAGES` (5000). Defaults are the old values, so nothing changes unless configured.
- The zip importer, the folder import route and the Notion importer use these values. The single
  import route passes the upload cap per request (`req.file({ limits: { fileSize } })`), so the
  global 25 MB multipart limit for other uploads stays.
- Error messages keep their exact text at the defaults (Korean translations are keyed by text).
- Memory stays bounded: the zip is held compressed, entries are decompressed one at a time through
  `readZipEntryCapped` (real bytes counted against the unpacked cap), nested Notion part archives are
  bounded by the upload cap, pages are inserted in batches of 500 and documents converted one by one.

## Consequences
- Raising the caps raises peak memory roughly by the upload size (twice for nested exports).
- With non-default values the size messages have no Korean match and fall back to the generic text.
- The web folder picker still pre-checks 300 files on the client.
