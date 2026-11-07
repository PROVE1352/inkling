# Obsidian vault sync (experimental)

Two-way sync between a folder of markdown notes (an Obsidian vault, or a sub-folder of one) and an
Inkling workspace.

**Server:** add `vault-sync` to `EXPERIMENTAL_FEATURES` (e.g. `EXPERIMENTAL_FEATURES=vault-sync`).

```sh
inklingctl login --server https://notes.example.com
inklingctl sync ~/Vault/Inkling --workspace "Team notes"     # run it whenever you like
inklingctl sync ~/Vault/Inkling --workspace "Team notes" --dry-run
```

Use a dedicated folder per workspace; the first run links the folder to that workspace and later
runs refuse a different one.

## What happens on each run

| Situation | Result |
|---|---|
| note changed only in the vault | uploaded; the file is then rewritten in Inkling's normal form |
| page changed only in Inkling | file updated |
| both changed, different lines | merged line by line, both sides updated |
| both changed, same lines | **conflict**: your note is left as is, `Name (conflict 2026-11-07).md` holds both versions with `<<<<<<<` markers. Fix the note, delete the conflict copy, run sync again |
| note deleted in the vault, page unchanged | page moved to the Inkling trash |
| page deleted in Inkling, note unchanged | note moved to `.inkling/trash/<date>/` |
| deleted on one side, edited on the other | the edit wins (the note is restored / re-created) |
| file renamed or moved | page renamed / moved (and vice versa) |
| new note / new page | created on the other side; new folders become folder pages |

Pages being edited in the browser are safe: a vault upload that would overwrite unsaved browser
typing is rejected by the server and merged instead.

## Mapping

* Folders ⇄ folder pages; a page with sub-pages becomes `Page.md` + `Page/`.
* Frontmatter ⇄ page properties: `tags`, `aliases`, and any `key: value` (text, number, true/false,
  `YYYY-MM-DD` dates, lists). Nested YAML maps and multi-line strings are not stored (the CLI run
  reports them as dropped).
* `[[Wiki links]]` ⇄ page links, kept by page identity — renaming a page updates the link text in
  other notes (`[[New title|old text]]`).
* Images and files: stored in Inkling, mirrored to `assets/<id>.<ext>` in the vault; `![[photo.png]]`
  embeds are uploaded and rewritten to standard markdown image links. Allowed types: png, jpg, gif,
  webp, avif, pdf, mp4, webm, mp3, m4a, wav, txt.
* ```` ```dataview ```` blocks stay as they are and run as Query blocks in Inkling
  ([QUERY.md](QUERY.md)).

## Known losses

The first sync rewrites notes into Inkling's markdown style (`*` bullets, `*italic*`, padded tables,
`\` line breaks inside paragraphs). After that, files only change when content changes.
Kept as plain text (not interpreted): callouts `> [!note]` (shown as quotes), `![[Page]]` page
embeds, `==highlight==`, `%%comments%%`, math, inline fields `key:: value`. Canvases and collection
(database) pages are not synced; collection rows sync as plain notes without their field values.
Comment threads anchored to a page edited from the vault lose their block anchor.

State lives in `<folder>/.inkling/` (`sync-state.json`, `base/` copies used for merging, `trash/`).
If it is deleted, notes are re-linked through their `inkling-id` frontmatter; notes that differ
from the server then show up as conflicts (there is no common base to merge against).

Design: docs/adr/0200–0202.
