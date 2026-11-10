# 1947. update_page replace names the version it read

- Status: Accepted
- Date: 2026-11-10

## Context
Evaluation 2026-11-10, sync problem 5: `update_page(mode='replace')` had no precondition. An agent
reads a page, a person edits it, the agent replaces the body with its version of the old text: the
person's edit is undone (recoverable only from the "Before AI edit" snapshot). patch_section takes a
`baseVersion` but it is optional there too; patch_sections already requires it for replace/delete
(ADR 1542).

## Decision
- `update_page` takes `baseVersion` (the `- version:` line of read_page, the page version of ADR 1540:
  kind, title, properties, body).
  - Given: the current version is computed exactly as read_page does (the same export, `readWholePage`)
    and must be equal, else nothing is written: `the page changed since version <v> (PAGE_CONFLICT; a
    change of title or properties counts too). Nothing was written. read_page(pageId) again, merge your
    change into what is there now and retry with its version as baseVersion; patch_section changes one
    part.`
  - Missing: refused only when **a person** changed the page last (the newest change-log row has no
    connection; this includes editor typing and imports), with
    `baseVersion is required to replace a page a person edited last (<name>): their edit may be newer
    than your read. Nothing was written. Pass the version line of your read_page as baseVersion
    (read_page(pageId, known=<that version>) answers in one line if it is still current), or read the
    page again and merge; patch_section changes one part.`
  - Missing, and the last change came from an agent (any connection) or there is none: written as in
    0.15.0, so agent-owned pages and 0.15.0 flows that rewrite their own pages keep working.
- **The current version is never put in an error.** An agent that retried with it would overwrite the
  edit anyway; the error points to a read (one line with `known=` when nothing changed).
- `append` is unchanged (it cannot undo an edit).

## patch_section (assessed with the same rule, not changed here)
patch_section lives in contextTools.ts / routes/context.ts (find_context's work stream). The same rule
fits it: `replace`/`delete` without `baseVersion` refused when a person changed the page last
(or, stricter and simpler, required like patch_sections). Its conflict answer already returns the
current section text, so the retry is one call. Recorded for its owners.

## Trade-offs
- Two steps: the check reads the page, then the content route writes; a person's edit landing in the
  milliseconds between them is not caught (the "Before AI edit" snapshot still holds the previous
  state).
- The "person last" test reads the change log, written for editor typing after the index debounce
  (≤ 30 s, ADR 0932); typing in that window is invisible to it. baseVersion has no such gap (the
  export reads the live document).
- A replace with baseVersion costs one extra full export (the same work as a read_page).
- A rename or property change alone makes the old version stale (the version covers them); the
  message says so.
- The check runs before the content route: on a locked or "suggestions only" page that a person edited
  last, a replace without baseVersion answers "baseVersion is required" first and `PAGE_LOCKED` (or a
  suggestion) only on the retry with a version.
- The "person last" test sees the change log only within the change feed's retention
  (`CHANGE_FEED_RETENTION_DAYS`, default 30): a page whose newest row aged out counts as "no change"
  and is replaced without baseVersion, as in 0.15.0.

## Alternatives considered
- **Always require baseVersion**: safest; every 0.15.0 replace of an agent's own page would fail once.
- **Warn instead of refuse**: the edit is lost by the time the warning is read.
- **Refuse only recent person edits (time window)**: the window is a guess about how long an agent
  holds a read; the change-log rule needs no clock.
- **Check inside the content route (atomic)**: the route takes no version and is shared with other
  callers; computing the agent-notation version there means exporting inside the write path. Possible
  later if the race matters.

## References
- apps/server/src/mcp.ts (`assertReplaceBase`, `readWholePage`, update_page)
- docs/adr/1540-*, 1542-*; evaluation 2026-11-10 §2.5
- Tests: toolSurface.db.test.ts (stale base, missing base after a person's edit, agent-written page,
  errors without the current version); notationMoves.db.test.ts and charts.db.test.ts pass the version
  they read.
