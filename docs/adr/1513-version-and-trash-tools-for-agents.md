# 1513. Version history and trash tools for agents; version restore under the write gate

- Status: Accepted
- Date: 2026-11-09

## Context
People undo with version history (HistoryModal, snapshots stored as diff chains, 1100–1104) and the
trash. Agents could replace a body (update_page keeps a "Before AI edit" snapshot) and trash pages,
but could not see or use either way back. Snapshot restore was one of the writes ADR 1151 left
outside the write gate.

## Decision
- **list_versions(pageId)** over `GET /pages/:id/snapshots` (latest 50): one line per version
  `id | time | "label" | by <person> via <client>`, as untrusted data (labels and names are member
  text).
- **diff_versions(pageId, from, to='current')** over the web's diff route
  (`GET /pages/:id/snapshots/:sid/diff?against=`, chains rebuilt by `snapshotBlocks`), formatted with
  the change feed's hunks (`formatHunks`, 0933). `from='current'` is the same route with the ops
  inverted. Over the diff caps the answer says "too large" instead of a diff.
- **restore_version(pageId, version)** over `POST /pages/:id/snapshots/:sid/restore`, which now:
  checks with `requireMembershipAcl` + `assertPageEditable`, applies the restore through
  `gatedTransact(…, pageEditGate(…))` (1151), records the edit's actor (`withEditActor`, so the
  change feed shows "by X via client"), and passes the client name to the "Before restore" snapshot.
  The restore is a new edit on top of the history; the "Before restore" version undoes it, and the
  tool's answer gives its id. Write tool (`wrapWrite`): read-only tokens refuse.
- **list_trash(workspaceId)** over `GET /workspaces/:id/trash` (visibility and range as in the web
  trash) with when each page is deleted for good (trash retention, 0950) and its former parent.
  **restore_page(pageId)** over `POST /pages/:id/restore` (edit locks of the subtree, range
  promotion rules); the answer says how many pages came back and where.
- Still no permanent-delete tool.

## Alternatives considered
- **Restore by writing the snapshot's Markdown with update_page**: loses blocks Markdown cannot
  carry; the restore route writes the stored blocks.
- **Leave restore ungated** (as in 1151): an agent restore is a whole-document write like replace,
  and the gate costs one short transaction.
- **Expose page_changes as "versions"**: section-level rows for change tracking (changes_since); they
  are not restorable states.

## Consequences
- Web restores are gated too (same route) and are now attributed in the change feed.
- Tests: `apps/server/src/mcpTools/agentTools012.db.test.ts` (list/diff both ways/restore/undo,
  via in versions and in the change feed, read-only, locked page, private page, trash visibility,
  subtree count, promotion to top level) and `apps/server/src/outboxTx.db.test.ts` (a restore that
  starts during a lock change waits and is refused; the test fails without the gate).
