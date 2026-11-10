# 2168. Vault sync keeps and reports what it cannot carry, instead of dropping it or stopping

- Status: Accepted
- Date: 2026-11-10

## Context
Found with `vaultSyncReadiness.db.test.ts` and `vaultSyncSecurity.db.test.ts`:
- **Frontmatter.** Page properties hold scalars and lists (ADR 0201). Nested maps, block scalars
  (`key: |`), the reserved `updated` key and keys past the 50-property limit are not stored. The server
  reported the first two as `droppedFrontmatterKeys`, the CLI ignored the field, and after every upload
  it rewrote the note in canonical form: the keys disappeared from the vault without a word (Obsidian
  plugins keep their settings in such keys).
- **Refusals ended the run.** One attachment the server refused (over 25 MB, a type it does not take,
  uploads switched off for connections) ended every run with an error, so no note after it ever synced.
  A write refused for the account (an edit lock, a range) did the same.
- **Silent skips.** Links to files of other types (`.svg`, `.zip`), Obsidian canvases (`.canvas`) and
  canvas pages in Inkling were skipped without a word.
- **Shared uploads.** Identical image bytes in two notes were uploaded once and both pages pointed at
  the first page's file. Purging the first page from the trash deletes its files (housekeeping), and
  the second page lost its image.

## Decision
- The server reports every frontmatter key that did not become a property or the aliases (parser
  drops, reserved keys, keys past the limit). The CLI prints them and keeps them in the note: whenever
  it writes a server version into the file (after an upload, on a download, as the server side of a
  merge) it copies those entries, with their indented lines, from the note on disk. The keys are
  remembered per page (`keep` in `sync-state.json`) until an upload no longer reports them. Nothing
  about them is stored on the server.
- An upload answered 400, 403, 413, 415 or 422 leaves the link as it is and is reported. A write,
  trash, rename or create answered 403 skips that note (`skip … (refused by the server: …)`); the next
  run tries again. Network errors and other statuses still end the run (it resumes, ADR 2166).
- Links to existing files of a type sync does not take, local `.canvas` files and canvas pages are
  reported every run (`note:` lines after the summary). Sync never writes, moves or deletes them.
- Identical bytes reuse an uploaded file only within the same page.

## Alternatives considered
- **Store unknown frontmatter verbatim on the page** (a hidden property): every client that edits
  properties would have to carry text it cannot show.
- **Keep every local key the server text lacks**: a property deleted in the web app would come back from
  the vault on the next upload.
- **Stop on the first refusal** (before): safe, but one file blocks the vault for good.
- **Sync canvases as JSON files**: Obsidian's canvas format and Inkling's canvas pages do not map onto
  each other (optional O2 of the readiness checklist).
- **Dedupe across pages and keep files alive while referenced**: a reference count over page bodies on
  every purge.

## Consequences
- A run finishes whenever the network does; what it left out is listed.
- Two devices syncing the same page each keep their own copy of frontmatter Inkling does not store.
- Two notes with the same picture store it twice on the server.

## References
- apps/server/src/routes/sync.ts (`droppedKeys`)
- apps/cli/src/commands/sync.ts (`keptKeys`, `download`, `upload`, `mergeBoth`, `toServer`, `refused`, `notice`)
- apps/cli/src/sync/vault.ts (`keepFrontmatterKeys`, `scanVault`)
