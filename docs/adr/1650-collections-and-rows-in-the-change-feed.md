# 1650. Collections, rows and row properties in the change feed

- Status: Accepted
- Date: 2026-11-10

## Context
Using 0.12 through MCP: a page, a `create_collection` under it and three `create_row` showed up in
`changes_since` and `catch_up` as one line, "page added" for the page. An agent that keeps a local copy
with the feed never learned about the collection or the rows.

Cause: the only writer of `page_added` was the section index (`recordSectionChanges`, ADR 0932): a page
is logged as added when its document is indexed for the first time. A collection has no document, a row
made without a template body has none either (`createRow`, the batch insert route), so nothing was
logged. Row properties live in `pages.props`, outside the document, and `PATCH /pages/:id/props` and the
batch update logged nothing either. Trashing a row already went through `DELETE /pages/:id` and was
logged like any page.

## Decision
- **Logged at creation, in the creating transaction** (ADR 1150): `POST /pages` with `kind=collection`
  or under a collection, `createRow` (web "New row", board/calendar "+", MCP `create_row`, REST), and
  `POST /pages/:id/collection/rows/batch` write a `page_added` event through `recordPageEvents(…, tx)`.
  Document pages keep being logged by their first index, so their `page_added` keeps the body text.
- **A body typed into such a row later is not lost.** `writePageAdded` stays "one per page, ever"; the
  index's `page_added` op now carries the first index's sections, and when the page already has its row
  they are written as `added` section rows (empty bodies are skipped, so opening a row adds nothing). A
  template body indexed right after `createRow` is attributed to the creator (`withEditActor`). The
  section texts ride on the op only while they total 64 KiB or less (else the sections are kept without
  text, "large change, read section"), so a large new document page does not double its outbox row for
  a fallback it never uses.
- **Property changes are a page-level kind `page_props`** (anchor null, `after_text` = the changed
  fields' names at log time in field order). Only keys whose JSON value really changed are logged. The
  feed folds them per page into `properties: Status, Due`; values are not logged (option ids, people and
  relation ids would need the schema at read time) and `query_rows` gives them. Batch updates also log
  title changes as `page_renamed`, which they did not before. `page_changes.kind` is text, so no
  migration; revert treats any anchor-less row as a page event (unsupported); the activity screen files it
  under "Page events" (metadata, like a rename) with its own label.
- **Labels**: the feed and catch_up say `collection added:` / `row added:` (from `pages.kind` and the
  parent's kind now) instead of `page added:`.

## Alternatives considered
- Log `page_added` for every `POST /pages`: document pages would lose the body text in their
  `page_added` row (the first index's row would be dropped), visible in the activity screen.
- Fold collections and rows out of the log and let agents call `query_rows` on a timer: the feed is the
  one sync primitive (ADR 0932); a second one per collection is what the user asked us not to need.
- Log property values: needs the collection schema at log time and at read time to print option names,
  and the values are already one `query_rows` away.

## Consequences
- Sheet sync (`routes/sheetSync.ts`, experimental) still writes rows and props without log rows.
- `GET /changes/:seq/diff` of a `page_props` row shows the field names as the "after" text.

## References
- apps/server/src/routes/pages.ts (POST /pages), apps/server/src/rowTemplates.ts (createRow),
  apps/server/src/routes/collectionsExt.ts (batch insert/update), apps/server/src/routes/collections.ts
  (PATCH /pages/:id/props), apps/server/src/context/changeLog.ts (writePageAdded fallback, page_props),
  apps/server/src/context/changeFeed.ts (fold, labels)
- apps/server/src/mcpTools/mcpFixes013.db.test.ts
