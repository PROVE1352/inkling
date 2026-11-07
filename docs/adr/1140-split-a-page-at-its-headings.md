# 1140. Split a page into subpages at its headings, on the live document

- Status: Accepted
- Date: 2026-11-07

## Context
ADRs 1040–1043 and 1100–1104 made a 4.5 MB "experiment log" page readable and writable, but every
store, index pass and version of it still costs in proportion to its size, and opening it in the
browser builds ≈ 2,000 blocks (ADR 1104). The page is 99.9 % live content, so compaction does not
help (ADR 1042). The remedy ADRs 1043 and 1103 point people and agents to is "split it into
subpages", and there was no way to do that except copying sections by hand: block ids, comment
anchors and links were lost on the way, and the page might be open in someone's editor meanwhile.

## Decision
- **Route** `POST /pages/:id/split { level, sections?, preview? }` (`routes/splitPage.ts`), MCP
  `split_page` (`mcpTools/splitTools.ts`, through the route like every tool), and "Split into
  subpages…" in the page's ⋯ menu (`SplitPageModal`). `preview: true` returns the plan and writes
  nothing; the web list and the agent's `dry_run` come from it, so what is shown is what runs.
- **Sections** (`md/splitDoc.ts planSplit`): a top-level heading of `level` starts a section, which
  runs to the next top-level heading of that level or higher. Headings of a higher level, the intro
  and anything before the first section stay on the page. Same top-level rule as `splitSections`, so
  the anchors in the plan are the ones `read_page outline` printed. A heading without an id stays.
  At most 200 sections per call (`SPLIT_MAX_PAGES`).
- **Everything happens on the Yjs tree, never through BlockNote.** A section moves as clones of its
  top-level containers (`copyTopRange`): block ids, nested children, marks and nodes the server
  schema does not know (mention chips, callouts) arrive byte for byte. Reading the live document
  through BlockNote would delete those nodes and broadcast it (sectionPatch.ts).
- **Order of writes** (one DirectConnection on the page for the whole call):
  1. "Before split" version of the page (version history; restorable like any version).
  2. Plan, section copies (V2 state + state vector each) and link bullets are built synchronously
     from the live document; a deep observer on the top-level group marks the plan stale if any
     planned container changes.
  3. One transaction under the workspace tree lock: `assertPlacement` under the page (parent live,
     depth cap, edit lock, public-folder rule), subpage rows (`created_by` = the actor,
     `created_via` for agents, scope of the parent) with their `page_docs` rows, and the moves of
     `comments` whose `block_id` is any block inside a moved section, plus `notifications` about
     those comments or anchored at those blocks.
  4. `DirectConnection.transact`, synchronously: the stale check, a re-plan that must find the same
     container objects at each section, then in one Yjs transaction each section is deleted and a
     bullet with an internal link to its subpage (`/w/<ws>/p/<id>`, built by BlockNote) is inserted
     where it was. Every open editor receives one update. The store hook saves and re-indexes the
     page (ADR 1042). The subpages are indexed one after another after the response
     (`scheduleDocIndex` with the stamp from each `INSERT … RETURNING`, under the actor for the change
     feed), as AGENTS.md requires of a new `page_docs` writer: ≈ 10 ms each, 2.2–2.8 s for the
     production page, which the first version spent inside the request. Until then search and
     `find_context` do not list them; reads decode them. A restart in between leaves them to the
     load-time and boot backfill like any page without an index marker.
  5. If step 4 fails (changed sections → 409 `SPLIT_CONFLICT`, or anything else) the comments and
     notifications are moved back and the subpage rows deleted: the page is as it was, apart from
     the extra version.
- **Collaboration: split the live document, do not wait for it to close.** The plan is cloned from
  and removed in the in-memory document Hocuspocus serves, so people who have the page open see the
  sections turn into links in place, and their own typing elsewhere in the page is kept (the
  observer ignores changes outside the moved containers; the test types in the intro between the
  commit and the removal). The window in which a change inside a moved section aborts the split is
  the length of the one transaction (tens of milliseconds); the web dialog says how many others have
  the page open.
- **Permissions:** visible + member + `assertPageEditable` on the page before anything, then
  `assertPlacement` in the transaction. No `bumpAcl`: like `POST /pages`, inserting leaves changes
  no existing lock chain, owner or parent (ADR 1071 lists changes of those, not inserts).
- **Links into the page** are covered by ADR 1142.

## Alternatives considered
- **Refuse while the page is open, or close everyone's connection first.** Simple, but the page
  that most needs splitting is the one somebody always has open (an agent loop writing, the author
  reading), and closing sockets throws away unsaved typing in other sections.
- **Rebuild the page from blocks with an epoch** (what compaction would need). Reconnecting clients
  with an old state would merge their history back in and duplicate content; and the BlockNote
  round trip loses unknown nodes.
- **One transaction for everything.** The Yjs edit is not a database write: the collab store writes
  `page_docs` through its own serialised chain. Instead the database part is one transaction and the
  document part one Yjs transaction, ordered so the document is touched only after the commit, with
  a compensating transaction if it cannot be.
- **Move by BlockNote blocks (read, then write to new pages).** Two full conversions of a 4.5 MB
  page, new block ids for nested blocks and lost unknown nodes.
- **Keep the heading only as the title (drop it from the subpage body).** The heading block carries
  the id that comments, `?block=` links, notification anchors and `section=` reads point at; it stays.

## Trade-offs
- A person who typed inside a moved section while offline loses that typing when they reconnect:
  their update lands in containers that were deleted. This is the same as any concurrent deletion of
  a section (and as restoring a version, which also edits the live document).
- The extra "Before split" version costs one snapshot row (a diff when the chain allows, ADR 1100).
- Subpages are created by the actor, not the page owner (owner is left empty, like `POST /pages`).

## Measurements
docs/PERFORMANCE.md, "Split a page into subpages" (Server & database): split and preview of the
4.5 MB production copy and the 4.1 MB synthetic log, with the page closed and open elsewhere, the
size of what stays on the page, and other requests during the call
(`apps/server/scripts/split-bench.ts`).

## References
- apps/server/src/md/splitDoc.ts (`planSplit`, `sectionDoc`, `linkContainers`, `watchSections`, `replaceSections`)
- apps/server/src/routes/splitPage.ts (`runSplit`, `previewSplit`, `insertChildren`, `undoChildren`, `splitTestHooks`)
- apps/server/src/mcpTools/splitTools.ts, packages/shared/src/pageSplit.ts
- apps/web/src/components/SplitPageModal.tsx, apps/web/src/splitApi.ts, apps/web/src/i18n/{en,ko}/split.ts
- apps/server/src/routes/splitPage.db.test.ts
- ADR 0970 (edit lock), ADR 1042 (DirectConnection writes, store skips), ADR 1100 (versions), ADR 1104
