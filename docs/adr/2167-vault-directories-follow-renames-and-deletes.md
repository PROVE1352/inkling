# 2167. Vault sync: directories follow renames and deletes

- Status: Accepted
- Date: 2026-11-10

## Context
Vault sync tracked notes by page id but directories only by path (ADR 0202: "folders are not
deleted by sync"). Found with `vaultSyncReadiness.db.test.ts`:
- Deleting a folder in the vault trashed its notes, but the folder page stayed and the next run
  re-created the empty directory.
- Renaming a folder in the vault made a second folder page with the new name, moved the notes into
  it and left the old one, whose directory came back on the next run. Locks, guest grants and
  comments on the folder page stayed behind on the empty old page.
- Renaming a note with sub-pages (`Topic.md` + `Topic/` → `Subject.md` + `Subject/`) moved the
  sub-pages out of the note into a new folder page `Subject`.
- Deleting `Page.md` together with `Page/` trashed the sub-pages but not the page: the CLI asked to
  trash the page first, got 409 (it still had sub-pages) and restored it.
- A new note in `Topic/` next to `Topic.md` (Obsidian's folder-note layout, and the layout sync
  writes) went into a new folder page `Topic`, which the next run renamed to `Topic (2)` on disk.

## Decision
- The CLI keeps the directories of the last completed run (`dirs`: page id → path, for folder
  pages and pages with sub-pages) in `sync-state.json`.
- A directory of the last run that is gone while all its tracked notes reappear under one new
  directory with the same relative paths was renamed or moved as a whole: a folder page is renamed or
  moved (`PATCH`, same page); for a note with sub-pages the directory follows when the note itself
  moved the same way. Outer directories are handled first. Anything less clear-cut falls back to
  per-note moves.
- A folder page whose directory is gone after the content pass (deleted, or emptied by moves) is
  trashed with `DELETE /pages/:id/sync` (leaf only: the server answers 409 while it still holds pages,
  visible or not, and the directory is restored).
- Deletes in the vault are sent deepest first, so a page deleted with its sub-pages is a leaf when
  its turn comes.
- A directory with the name of a tracked note next to it holds that note's sub-pages; a folder page is
  made only for other directories.
- Directories of the last run that no page uses any more are removed when empty (`rmdir`, never
  recursive).
- Moving a note changes the page title only when the file name changed, so a title with characters a
  file name cannot hold survives a move.

## Alternatives considered
- **Never touch folder pages** (ADR 0202): leaves empty folders and resurrects deleted directories.
- **Trash a folder page with its subtree** (`DELETE /pages/:id`): would also trash pages the vault
  does not show (other people's private pages, collections, canvases).
- **Track directories by an id file inside them** (`.inkling-folder`): one hidden file per folder in
  the user's vault, and copies of a folder would carry the same id.

## Consequences
- Folder renames keep the page and what hangs on it; deletes do not come back.
- A rename that also moved single notes elsewhere is handled as moves plus a trash of the emptied old
  folder: no loss, but the folder page is a new one.
- A state from before 0.17 has no `dirs`; its folder map is used once, then `dirs` is written.

## References
- apps/cli/src/commands/sync.ts (directory pass, `remapDir`, deletes, folder trash, `ensureDir`)
- apps/server/src/routes/vaultSyncReadiness.db.test.ts (R3, R4, R5)
