# 2163. Zip imports: crafted names, legacy encodings, links and the inflate ratio

- Status: Accepted
- Date: 2026-11-10

## Context
Zip imports already counted real decompressed bytes against per-entry and total caps (C-M6, ADR 0961),
never wrote an entry to disk by its name (attachments are stored under their row id), and skipped dot
segments. Checking them again for import_zip (ADR 2162) found:
- JSZip collapses `..` in entry names on load (its own zip-slip guard), so `a/../../b.md` silently became
  `b.md`; a crafted archive was imported somewhere other than where it claimed, without a word.
- `\` separators, a leading `/` and drive letters were kept as part of titles.
- Entries flagged as symbolic links were read as files whose content is the link target.
- Names without the UTF-8 flag were decoded as UTF-8: zips made by Windows Explorer on a Korean system
  (code page 949) produced titles full of U+FFFD.
- macOS writes Hangul names decomposed (NFD), so titles looked right but did not match `[[링크]]` typed in
  NFC.
- A highly compressible entry was decompressed up to the size caps before anything stopped it.

## Decision
For the folder-zip import (web and MCP import_zip; the Notion detection step loads through the same
loader):
- `loadZip` passes `decodeFileName`: strict UTF-8, then WHATWG `euc-kr` (= CP949, available in Node's
  full ICU, checked in the image's Node 22), then Latin-1. Names with the UTF-8 flag or a Unicode path
  extra field are unchanged.
- `normalizeEntryName` on the name as stored in the archive (`unsafeOriginalName` when JSZip changed it):
  NFC, `\` → `/`, no leading `/` or drive letter, no empty or `.` segments, no control characters, and a
  `..` segment refuses the archive (400 `ZIP_UNSAFE_PATH`).
- An entry whose Unix mode is a symbolic link refuses the archive (400 `ZIP_SYMLINK`).
- An entry that inflates past 200 times its compressed size and past 1 MB stops the import (400
  `ZIP_RATIO`). Text compresses 3–20x; small repetitive files are under the floor. This check lives in
  `readZipEntryCapped`, so the Notion importer and template zips (`templates/io.ts`) get it too.
- Not covered yet: the Notion importer's own entry walk and nested part archives, and template zips,
  do not run the name rule or the symlink check (they also never write by name). Left for the change that
  brings the Notion importer under the connection rules (ADR 2162).
- The new 400s carry their own codes so the web app can translate them (`errors.ZIP_*`, en/ko).
- Folder uploads (`import-folder`) NFC-normalize their relative paths too (they already refused `..`).

## Alternatives considered
- **Skip unsafe or link entries and import the rest**: the archive is crafted; refusing it is clearer
  than a partial import nobody notices.
- **A configurable ratio**: the real-byte caps remain the limit; the ratio only stops bombs earlier. One
  constant until someone needs another value.
- **Detect the encoding with a library**: a new dependency (ADR 0882) for one fallback that the platform's
  TextDecoder covers.
- **Normalize to NFC in the converter instead**: titles come from names here; one place is enough.

## References
- apps/server/src/md/importer.ts (`loadZip`, `decodeZipFileName`, `normalizeEntryName`, `isZipSymlink`,
  `readZipEntryCapped`), apps/server/src/routes/exportImport.ts
- apps/server/src/md/zipSafety.test.ts, apps/server/src/mcpTools/importZip.db.test.ts
- ADR 0961 (import limits), 2162 (import_zip), C-M6
