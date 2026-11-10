# 2120. An inline database view is a page embed of a collection with a view

- Status: Accepted
- Date: 2026-11-10

## Context
0.17 adds Notion's linked database view: a block in a page that shows one view (table, board,
gallery, calendar, timeline, chart) of an existing collection. Like a chart (ADR 1600) the block lives
in the Yjs document that every reader receives, so it may only say what to show, never the rows. A
new node type also repeats CHART-2: a client that does not know the type deletes the node from the
live document when it reads it (y-prosemirror drops unknown nodes).

## Decision
- No new node type. The page embed (`pageEmbed`, known to every client since 0.1) gets a second prop,
  `viewId` (default `''`), in `packages/shared/src/blocks.ts pageEmbedConfig`; the web editor, the
  embed viewer and the server schema build from that config, so they agree. A page embed whose page is
  a collection is the database view; `viewId` names one of its views, `''` (or a view that was
  deleted) shows the first view with a note.
- Stored: collection id and view id only. Rows come from `GET /pages/:id/collection` for each reader,
  under the same React Query key as the database page, so its 15 s poll and every mutation's
  invalidation refresh the block too.
- Web (`components/blocks/DbViewEmbed.tsx`): the existing view components (TableView, BoardView,
  GalleryView, CalendarView, TimelineView, ChartView) render under `CollectionReadOnlyContext`
  (no cell edits, drag, new rows or view settings) in a box of at most 480 px with "Open database". A
  row opens its page. Editors can switch the view from the header. The slash item "Database view"
  inserts an empty page embed that asks for a database of this workspace and a view; `![[Database]]`
  gives the first view.
- One "Database not available" state for a database the reader cannot see, one in the trash and an
  unknown id: the server answers 404 for all of them, and telling them apart would say that a private
  database exists. A page guest sees a database shared with them (ADR 2146; names of the people in its
  rows come from the response's `people`) and "not available" for any other.
- Read-only in 0.17: editing in the block would need CollectionView's whole handler set (properties,
  options, titles, paste, row templates), which belongs to the database page and is changing in this
  release; the block reuses the views without forking those handlers.

## Alternatives considered
- A new `databaseView` block type: clearer name, but a 0.16 client deletes it on read (CHART-2), and
  every path that knows page embeds (agent notation, public pages, exports, the embed viewer) would
  need a second case.
- A plugin block with a reserved plugin id: also survives old clients, but plugin data is opaque
  JSON, and plugins could claim the id.
- Storing a copy of the view's config in the block (a view of its own): more freedom, but filters and
  columns would drift from the database's own views and need their own editor.

## Consequences
- A pre-0.17 client keeps the block and shows a page card for the collection. Only when it rewrites
  that very node (moving it, for example) does it drop `viewId`; the block then shows the first view.
  Tested on the Yjs document with the old schema (`apps/web/src/components/blocks/DbViewCompat.test.ts`).
- Existing page embeds of a collection now show the collection's first view instead of an empty body.
- Tests: `DbViewCompat.test.ts`, `md/fileExport.test.ts` (token round trip), `md/dbView.db.test.ts`.
