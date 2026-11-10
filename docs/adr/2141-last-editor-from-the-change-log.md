# 2141. "Last edited by" is the change log's actor, kept on the page

- Status: Accepted
- Date: 2026-11-10

## Context
`editedBy` needs who changed a row last, and for an agent the same "(via Client)" the change feed and the
version history show. `page_changes` has the actor and via of every change, but it is written by the
outbox consumer (lag up to a second), merges edits within ten minutes and is pruned after
`CHANGE_FEED_RETENTION_DAYS` (30): reading it would make old rows' editor fall back to the creator.
`pages.updated_at` has about thirty writers, most without an actor.

## Decision
- Columns `pages.edited_by` (FK users, set null) and `pages.edited_via` (migration 0051).
- Written where the change log is written, in the same transaction: `recordPageEvents` for
  `page_props` and `page_renamed` (property and title changes: PATCH props, batch updates, rename), and
  `recordSectionChanges` for body edits (the in-flight REST/MCP actor, else the single live typist of the
  index window). So the last editor is the actor of the newest logged change and its via is the same
  string, capped like `page_changes.via_client`. A change without a known actor keeps the previous editor.
- Not written: two-way relation mirroring, sheet sync, moves, trash/restore, visibility (no editor in the
  sense of the row's content).
- Read as `coalesce(edited_by, created_by)` and the matching via: a row nobody edited since 0.17 shows its
  creator (no backfill).
- A body edit is indexed 8–30 s after the store bumped `updated_at`; when the editor changes on a row of a
  collection with an `editedBy` field, `collections.updated_at` moves too, so the collection's ETag (ADR
  0752) changes and a client that polled in between sees the new editor.
- "Last edited time" is `pages.updated_at` (also bumped by writes that do not change the editor).

## Alternatives considered
- **Latest `page_changes` row per page** (DISTINCT ON at read): lag, merges and retention, and one more
  join per collection read.
- **Write in every `updated_at` writer**: thirty places, most without an actor.

## References
- apps/server/src/context/changeLog.ts (`markEdited`), migration 0051
- ADR 0932, 1080, 1650 (change feed), 0936 (via), 2140
