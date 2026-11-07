# 1122. Import de-duplication: identical attachments once, one Notion page per Notion id

- Status: Accepted
- Date: 2026-11-07

## Context
Imports stored every attachment entry as its own file and every Markdown file as its own page:

- A zip / folder import (`md/importer.ts`) with the same picture under two names in `assets/`
  stored the bytes twice (two `files` rows, two files on disk).
- A Notion import (`md/notionImport.ts`) uploaded each referenced attachment path once, but the
  same image exported under two page folders was two files.
- A Notion upload that carries the same page twice — two export folders zipped together, or the
  page in one part archive and its subpage folder `Page <id>/` in another — became two pages
  "Page" (and with the folder case, the subpages hung under an empty folder twin).

## Decision
- **Attachments, both importers:** SHA-256 of the bytes; the first entry with a hash is stored,
  later entries with the same hash map to its `/files/<id>`. Zip entries hash the buffer that is
  read anyway; disk-backed folder uploads hash the temp file as a stream (`ImportEntry.sha256`)
  so the zero-copy `moveTo` path (ADR 0751) still never buffers a large file. The file row keeps
  the first entry's name and, as before, the first referencing page as owner (the C-L11 rule:
  an import has one scope, so every referencing page has the same visibility at import time).
- **Notion pages:** planned document and folder nodes that carry the same Notion id are one set
  (`groupByKeys` over the id). The representative is a document if the set has one, then the
  first by archive path; the others are dropped, their children move under it, and their paths
  resolve to it for links. Database nodes and rows are never merged (their identity is the CSV,
  not one file). The dropped copy's body is not imported; the kept one is the first by path.
- **Report:** `NotionImportReport.merged = { pages, attachments }` ("중복 N개를 합쳤습니다" under
  the import summary); `attachments` now counts stored files. The zip import response gains
  a top-level `duplicateAttachments` count (a toast after the import; `report` stays the Notion
  importer's, its presence tells the client which importer ran); single `.md` imports are unchanged.
- Plain zip pages are never merged: two Markdown files at two paths are two notes in Obsidian,
  even with the same text.

## Why this data structure, and where it does not fit
"Group items that are the same, keep one representative, point the rest at it" is the
disjoint-set pattern, and the Notion planner uses the union-find helper for it. But in both
places **one key decides** (content hash; Notion id), and with one key a `Map<key, first item>`
gives the same groups with every tree of depth 1 — that is what the attachment code uses, and it
says so in a comment. Union-find earns its place only when an item has several identities that
can chain (A shares a key with B, B with C, so A and C belong together without sharing anything);
`groupByKeys` takes a list of keys per item so a second identity (e.g. a normalised path form)
can be added to the Notion planner without changing the grouping code.

It would not fit de-duplication *across* imports or after edits: a file stored once and
referenced by two pages cannot be "split" when one page is moved to Private later. Within one
import all pages share one scope, so the merge is safe; across imports each import keeps its own
files.

## Measured
- Storage: in the test archive (`importDedup.db.test.ts`), 3 asset entries (2 identical) → 2
  stored files instead of 3; the Notion archive: 2 identical images → 1 file, 2 copies of one page
  → 1 page with the subpage under it.
- Cost: SHA-256 of 40 MB in 19–26 ms (`createHash`, p50 of 6 calls in each of 3 runs, Node 22.23.4,
  Apple-silicon MacBook Air shared with other work), i.e. ≈ 0.5–0.65 ms per MB of attachments,
  paid once per attachment.
  End-to-end import time before/after was not measured.

## Alternatives considered
- **Content-addressed storage for all uploads** (files keyed by hash across the workspace): saves
  more, but couples visibility of unrelated pages to one file row (see above) and changes the
  upload path; out of scope.
- **Merging Notion pages by title** (the importer already renames sibling title clashes to
  "Title (2)"): titles are not identity in Notion; ids are.

## Consequences
- Fewer duplicate files and pages; the report says how many were merged, so a missing copy is
  explained.
- If two copies of a Notion page differ (two exports at different times), the first by path wins
  silently except for the merged count.

## References
- ADR 0751 (streamed imports), ADR 0960/0961 (Notion import and limits), ADR 1120 (union-find).
