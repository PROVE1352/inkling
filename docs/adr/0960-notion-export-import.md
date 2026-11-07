# 0960. Notion export import: Markdown & CSV zip into pages, collections and attachments

- Status: Accepted
- Date: 2026-11-07

## Context
Teams moving from Notion bring the "Markdown & CSV" export. The generic zip importer could not use
it: only `.md` became pages, attachments had to sit in a top-level `assets/` folder, every title kept
Notion's 32-hex id suffix, links (`[Title](Folder%20abc/Title%20def.md)`) stayed as broken relative
hrefs, CSV databases were ignored, and large exports arrive as part archives inside the download.

## Decision
- **Entry point**: the existing `POST /api/workspaces/:id/import` with `?source=notion`. A zip without
  `source` is checked by name (`looksLikeNotionExport`: at least half of the `.md`/`.csv` files carry
  a 32-hex id, or the zip only wraps `Export-…-Part-N.zip` archives) and routed to the Notion
  importer (`report.detected = 'auto'`); `?source=markdown` forces the old importer. The response adds
  `report` (see API.md). MCP `import_folder` is unchanged.
- **Archive**: one level of nested part archives is unpacked (outer zips with no `.md`/`.csv`, or
  names like `Export-…-Part-1.zip`); other `.zip` files are ordinary attachments. Paths are NFC
  normalised (macOS zips store NFD), `..` paths are skipped, a single `Export-<uuid>/` wrapper folder
  is not turned into a page.
- **Tree**: ids are stripped from every segment; `X <id>.md` and folder `X <id>/` are one page with
  children; folders with no Markdown become folder pages. Siblings whose cleaned titles collide get
  ` (2)`, ` (3)` (counted in `report.renamed`). The leading `# Title` line becomes the page title
  (file names are truncated by Notion) and is removed from the body.
- **Databases**: `X <id>_all.csv` is preferred over the view-filtered `X <id>.csv` (the other one is
  listed as skipped). First column = row title, other columns become fields: checkbox (`Yes`/`No`),
  number, date (Notion spellings, ranges keep the start, time is dropped), URL, select / multi-select
  (≤ 50 options, else text); email and everything else stay text. A column whose every value
  resolves to rows of one database in the same import (via `Title (path.md)` tokens, notion.so URLs
  or exact row titles) becomes a one-way `relation`. Row pages are the `.md` files in the database
  folder matched by title (truncated prefix allowed); their `Key: value` property block is removed.
  Each collection gets one table view.
- **Links**: every non-external href and attachment URL is percent-decoded and resolved against the
  file's folder, then the archive root, then the id in the path; notion.so / notion.site URLs resolve
  by id. Pages become internal links (`/w/<ws>/p/<id>`), files are uploaded on first reference
  (owned by that page) and a paragraph that is only an attachment link becomes a file/image block.
  Unresolved references keep their original href and are listed in the report.
- **Markdown**: `<aside>` callouts become quotes (the server schema has no callout block),
  `$$…$$` becomes a ```` ```latex ```` code block and inline `$x$` inline code (pandoc delimiter rule,
  fenced code untouched); `<details>` toggles, tables and checklists already parse natively.
- **Atomicity**: plan everything first with pre-assigned page ids (no writes), create all pages,
  collections and views in one transaction under the tree lock, then write documents one at a time.
  If that phase fails, the created pages (cascade) and uploaded files (rows and bytes) are deleted.

## Consequences
- Imports are faithful for structure, links, attachments and plain databases; callouts lose their
  styling, equations are not rendered, person / rollup / formula columns arrive as text and
  attachments not referenced by any page are skipped (listed in the report).
- During phase C the created pages are briefly visible before their documents are written; a
  crash of the process (not an exception) in that window leaves a partial import.
- Select detection needs at least four non-empty values; small databases keep such columns as text.

## Alternatives considered
- **Notion API import** (token, live workspace): needs OAuth/app review and rate-limit handling;
  out of scope for a file import.
- **HTML export**: richer (callout colours) but much harder to map; Markdown & CSV is what Notion
  recommends for moving data.
- **Extending `importEntries` with hooks**: the CSV/relation/row matching and the atomic two-phase
  plan did not fit its single-pass shape; shared helpers are reused instead.
