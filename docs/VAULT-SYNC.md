# Obsidian vault sync (experimental)

Two-way sync between a folder of markdown notes (an Obsidian vault, or a sub-folder of one) and an
Inkling workspace.

> **Still experimental in 0.17.** The server routes stay off unless `EXPERIMENTAL_FEATURES` lists `vault-sync`.
> 0.17 closed the data-loss paths found while checking it (see [Status](#status-and-what-is-left)), but two
> required conditions are not met yet.

**Server:** add `vault-sync` to `EXPERIMENTAL_FEATURES` (e.g. `EXPERIMENTAL_FEATURES=vault-sync`).

```sh
inklingctl login --server https://notes.example.com
inklingctl sync ~/Vault/Inkling --workspace "Team notes"     # run it whenever you like
inklingctl sync ~/Vault/Inkling --workspace "Team notes" --dry-run
```

Instead of a password login you can use an API token (Settings → Connections → API tokens):
`inklingctl login --token`, or `INKLING_TOKEN=ink_pat_… inklingctl sync …` for one run. A token limited to one
page's subtree syncs only that subtree, and new top-level notes are refused. See [apps/cli/README.md](../apps/cli/README.md).

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
| page with sub-pages / folder renamed or moved in the vault | the same page or folder page is renamed or moved (comments, locks and grants stay) |
| folder deleted in the vault | its notes and the folder page go to the trash (only folders that held notes at the last completed run; an empty folder missing from a copy is made again) |
| run cut off (network, crash) | run again: pages are created once, and a write whose answer was lost is recognised |
| server refuses one note (edit lock, read-only token) or one attachment (size, type) | that one is skipped and listed; the rest syncs and the run exits 0 |

Pages being edited in the browser are safe: a vault upload that would overwrite unsaved browser
typing is rejected by the server and merged instead.

## Mapping

* Folders ⇄ folder pages; a page with sub-pages becomes `Page.md` + `Page/` (since 0.17 a folder `X/` next to
  `X.md` is always X's sub-page folder).
* Frontmatter ⇄ page properties: `tags`, `aliases`, and any `key: value` (text, number, true/false,
  `YYYY-MM-DD` dates, lists). Frontmatter Inkling cannot store (nested maps, `key: |`, `updated`, keys past 50)
  stays in the note and is listed after the run.
* `[[Wiki links]]` ⇄ page links, kept by page identity — renaming a page updates the link text in
  other notes (`[[New title|old text]]`). `[[Page#Heading]]` is a link to that heading of the page (written with the
  page's current title), and links to a page whose title contains `#` ("C# notes") work.
* Page embeds, inline database views, link embeds, plugin blocks and charts are written as one-line
  `<!-- inkling:… -->` comments (hidden in reading view); delete the line to delete the block.
* Images and files: stored in Inkling, mirrored to `assets/<id>.<ext>` in the vault; `![[photo.png]]`
  embeds are uploaded and rewritten to standard markdown image links. Allowed types: png, jpg, gif,
  webp, avif, pdf, mp4, webm, mp3, m4a, wav, txt. An image inside a line of text moves to its own line.
* ```` ```dataview ```` blocks stay as they are and run as Query blocks in Inkling
  ([QUERY.md](QUERY.md)).

## Known losses

The first sync rewrites notes into Inkling's markdown style (`*` bullets, `*italic*`, padded tables,
`\` line breaks inside paragraphs). After that, files only change when content changes.
Kept as plain text (not interpreted): callouts `> [!note]` (shown as quotes), `![[Page]]` page
embeds, `==highlight==`, `%%comments%%`, math, inline fields `key:: value`. Canvases (`.canvas` files and
canvas pages) and collection (database) pages are not synced; each run lists the canvases. Collection rows sync as
plain notes without their field values. Attachments: vault edits of files under `assets/` are not uploaded.

Blocks you leave alone keep their ids, so comments and section links on them stay. A mention chip or a file/audio
block in a paragraph you edit becomes `@Label` / a link. If the minimal edit cannot be applied, the page is rewritten
and its blocks get new ids (KNOWN-ISSUES SYNC-3). Images inside table cells are dropped on upload (VSYNC-3).

**Upgrading from 0.16.** The first upload of a note last synced by 0.16 merges once with the new form (block
tokens, revision marker `md2`); an edit on the line next to an embed then gives one conflict copy, and nothing is
lost.

State lives in `<folder>/.inkling/` (`sync-state.json`, `base/` copies used for merging, `trash/`).
If it is deleted, notes are re-linked through their `inkling-id` frontmatter; notes that differ
from the server then show up as conflicts (there is no common base to merge against).

## Status and what is left

0.17 checked vault sync against a list of conditions fixed before testing (tests under `apps/server/src/routes/`
unless noted). The flag stays on because R13 is open and one path that can drop block identity is untested.

| ID | Condition | Kind | Evidence | Result | Notes |
|---|---|---|---|---|---|
| R1 | Create, both directions | required | vaultSyncReadiness "R1 R2" | pass | linked notes, sub-folders |
| R2 | Modify, both directions | required | vaultSyncReadiness "R1 R2", "R7 (and R2)", "R8 (and R2)" | pass (fixed) | before: a vault edit deleted embeds, plugin blocks and charts |
| R3 | Delete, both directions, no resurrection | required | vaultSyncReadiness R3 (3 tests + empty folder) | pass (fixed) | before: a page deleted with its sub-pages folder came back; a deleted folder was made again |
| R4 | Rename, both directions | required | vaultSyncReadiness "R4 R5" (3 tests) | pass (fixed) | before: a folder rename made a new folder page; `Topic.md` + `Topic/` rename lost the children |
| R5 | Move, both directions | required | same | pass (fixed) | |
| R6 | Concurrent edits: merge or conflict copy, nothing lost | required | vaultSyncReadiness R6 | pass | incl. edit-vs-delete both ways; KNOWN-ISSUES A-M6 (meta TOCTOU) remains |
| R7 | Block ids survive a round trip (comments, section anchors) | required | vaultSyncReadiness "R7 block ids", "R7 (and R2) blocks Markdown cannot carry" | pass with caveats | untouched blocks, other-section edits and the 412 merge keep ids; the full-rewrite fallback is untested and gives new ids (SYNC-3); ink is per page, not per block; a mention chip in an edited paragraph becomes `@Label` |
| R8 | Frontmatter and tags round trip | required | vaultSyncReadiness R8 (2 tests) | pass (fixed) | before: nested maps and block scalars vanished from the note |
| R9 | Interrupted and resumed: no duplicates, no losses | required | vaultSyncResume (fault before / after / kill at every request; first sync killed) | pass (fixed) | 14-request mixed run × 3 fault modes; first sync 8 requests × kill; attachment uploads not in the sweep. Before: a cut create duplicated pages, a lost PUT answer made a false conflict copy |
| R10 | Upgrade from pre-0.15.0 revision tokens | required | vaultSyncReadiness R10 (2), vaultSyncRevision (5) | pass | incl. 0.16 → 0.17 |
| R11 | Attachments: no loss, skips announced | required | vaultSyncReadiness R11 | pass (fixed) | `/files` links of image/pdf/mp3 kept; local files untouched; svg and a 26 MB mp4 skipped and listed. Before: one oversize attachment failed every run; inline images vanished. Images in table cells still dropped (VSYNC-3) |
| R12 | Canvas: no damage or loss | required | vaultSyncReadiness R12 | pass (fixed) | not synced; now listed each run (before: skipped silently) |
| R13 | Security parity on sync routes | required | vaultSyncSecurity (13) + agentTaint, accessLeaks, guests, editLock, tokenRange, snapshotChain (146) | **open** | suggest-only, read-only and subtree tokens, guests, locks, others' private pages and outsiders are refused on writes; **sync reads do not record flagged content for the suggest-only rule (TAINT-1)** |
| R14 | 1,000-file vault | required | vaultSyncScale (`VSYNC_SCALE_N=1000`; CI default 100) | pass | docs/PERFORMANCE.md |
| O1 | Attachment files synced both ways | optional | — | not built | server → vault downloads; vault edits under `assets/` are not uploaded |
| O2 | Canvas content synced | optional | — | not built | listed only |

R14, measured on an Apple M4 shared with other agents (CLI through tsx against a test app, local Postgres 16 in
Docker): a first upload of 1,000 notes takes 23.5 s with the rate limiter off and 120.1 s with it on (5 waits on
429); a run with no changes 0.4 s / 1.3 s; a first download of 1,000 pages 4.4 s / 15.5 s.

Left before the flag can go:

1. Decide TAINT-1 for sync reads (record flagged content on `POST /sync/read` and the 412 and replay bodies, keep it
   as it is, or a CLI-only exception) and, with it, whether read-only tokens may pull (`POST /sync/read` refuses them
   today; opening it also opens it to suggest-only tokens). Recording it would make a token suggest-only right after
   its first sync in any workspace with one suspicious line.
2. Test the minimal-edit fallback (whole-document rewrite) and keep block ids there, or make it refuse and write a
   conflict copy instead (SYNC-3).
3. Run the two mixed-version combinations (0.17 CLI with a 0.16 server, 0.16 CLI with a 0.17 server) for real; so
   far they were checked by reading the code.
4. Sync creates do not queue the "new page" webhook and leave `created_via` empty (the change feed has them,
   VSYNC-4).
5. Confirm at review the six behaviour changes of 0.17 (CHANGELOG, 0.17.0 Upgrade notes): block tokens and the `md2`
   marker; folder deletes trash the folder page (reverses ADR 0202's "folders are not deleted by sync", ADR 2167); a
   stale-revision `PUT` that changes nothing answers 200; creates take a `clientKey` and replay; a 403 on one note is
   skipped and the run exits 0; `X/` next to `X.md` is X's sub-page folder.

Design: docs/adr/0200–0202, 1920, 2166–2169.
