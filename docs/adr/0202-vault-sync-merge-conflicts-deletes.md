# 0202. Vault sync: diff3 merge, conflict copies, delete and rename rules

- Status: Accepted (experimental `vault-sync`)
- Date: 2026-11-07

## Context
With a stored base (ADR 0200) the client can tell which side changed. It needs a merge that
cannot destroy work, a conflict representation Obsidian users understand, and rules for deletes
and renames that never lose an edit.

## Decision
- **Merge**: own line-based diff3 (`apps/cli/src/sync/diff3.ts`, no dependency). Myers
  O((N+M)·D) diff after trimming common prefix/suffix, edit distance capped at 20 000 and inputs
  at 200 000 lines (beyond that the whole file is one conflict). Base lines matched in both diffs
  are anchors; each region between anchors takes the changed side, either side if both changed
  identically, else a conflict hunk.
- **Conflicts**: the note is never overwritten. A sibling `<name> (conflict YYYY-MM-DD).md`
  (`… 2).md` if taken) gets the merged text with `<<<<<<< local` / `=======` / `>>>>>>> server`
  markers; the summary lists hunk positions (base line ranges). The server version becomes the
  new base and the page is skipped while the copy exists. Deleting the copy means "resolved": the
  next run uploads the note (a normal upload, so a server change in the meantime is merged again).
  Conflict copies are never synced.
- **Deletes** propagate only when the other side is unchanged since the last sync:
  - deleted locally, server unchanged → `DELETE /pages/:id/sync?expectedRevision=` (trash; 412 if
    the server changed meanwhile → the note is restored locally; 409 when it has sub-pages →
    restored and reported);
  - deleted on the server (trashed, purged or no longer visible), file unchanged → the file is
    moved to `.inkling/trash/<date>/` (recoverable, never unlinked);
  - otherwise the surviving edit wins: a locally edited note whose page was trashed is re-created
    as a new page; a server-edited page whose file was deleted is downloaded again.
  Folders are not deleted by sync.
- **Renames/moves** are tracked by pageId. Local path change → `PATCH /pages/:id {title,
  parentId}` (missing parent directories become folder pages). Server rename/move → the file is
  moved unless the target path is taken. If both changed, the local path wins. Paths use the same
  sanitizing and sibling de-duplication (`Name (2)`) as the zip export.

## Alternatives considered
- Character-level merge (diff-match-patch, as Obsidian Sync does) — merges more, but silently
  produces wrong text more often; line conflicts are reviewable in any editor.
- Conflict markers inside the note itself (git style) — breaks rendering in Obsidian and would
  upload markers on the next run if the user does not notice.
- Hard delete on the server — the web UI trash is the established recovery path.
- Last-writer-wins by mtime — clocks differ across devices and it loses edits by design.

## Trade-offs
- Two edits of the same line always conflict, even if trivially compatible.
- A conflict blocks only that page; everything else keeps syncing.

## How others solve it
- Dropbox/iCloud: "conflicted copy" files — same user model, no merge.
- Syncthing: `.sync-conflict-<date>` copies, newest wins in place.
- git/obsidian-git: diff3 with markers in the working file.

## Consequences
- Verified in the two-vault smoke (local edit, server edit, disjoint concurrent edits → merge,
  same-line edits → conflict copy, resolution, delete both ways, delete-vs-edit both ways,
  rename both ways, attachments, nested folders, idempotent re-runs).

## References
- apps/cli/src/sync/diff3.ts (`matchLines`, `merge3`)
- apps/cli/src/commands/sync.ts (`mergeBoth`, pass 1 renames, pass 2 content, delete branches)
- apps/server/src/routes/sync.ts (DELETE `/pages/:id/sync`)
