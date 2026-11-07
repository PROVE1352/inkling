# 0200. Vault sync protocol: change feed + state-vector revisions + client-side 3-way merge

- Status: Accepted (experimental, behind `EXPERIMENTAL_FEATURES=vault-sync`)
- Date: 2026-11-07

## Context
Obsidian users want to keep editing in their vault while the same notes live in an Inkling
workspace. Until now the CLI only pulled (server → vault, replacing a directory) or pushed single
files. Two-way sync has to cope with: browsers editing the same page live over Yjs, Hocuspocus
persisting those edits on a 2–10 s debounce, a lossy markdown ⇄ BlockNote conversion, and
thousands of pages per workspace.

## Decision
- **Server (all under `/api`, registered only when the flag is on, `routes/sync.ts`):**
  `GET /workspaces/:id/sync/changes?since=` returns the visible page tree (id, parent, kind,
  title, updatedAt) plus `revision`/`contentHash` for docs changed since the cursor (or all docs on
  a first sync), and trashed ids. `POST /workspaces/:id/sync/read` returns canonical markdown for
  ≤100 pages. `PUT /pages/:id/sync/md {markdown, expectedRevision}` writes or answers **412** with
  the current version. `POST /workspaces/:id/sync/pages` creates a doc/folder; `DELETE
  /pages/:id/sync?expectedRevision=` trashes a leaf page (412 on mismatch, 409 with children).
  Renames/moves use the existing `PATCH /pages/:id`.
- **Revision token** = `sha256(Yjs state vector)[0..20] . sha256(properties, aliases, link-target
  titles)[0..12]`. The state vector changes with every applied Yjs update and is read
  synchronously from the in-memory Hocuspocus document when a browser has the page open (else
  derived from `page_docs` with `Y.encodeStateVectorFromUpdate`, without building the document).
  The debounced store never changes it, so a client's own write does not look like a remote
  change seconds later. The PUT does compare-and-write inside one `DirectConnection.transact`
  callback (synchronous Yjs section): edits typed in a browser but not yet persisted still cause
  a 412. Link-target titles are in the token because wikilinks are exported by current title
  (ADR 0201); the change feed also marks referrers of renamed/trashed pages as changed.
- **`contentHash`** = SHA-256 of the normalized canonical markdown. The client decides "really
  changed" by hash, so a revision bump without a content change (e.g. a browser opening an empty
  page) costs one read and no write. `page_sync_hashes` caches hash-per-revision so the feed can
  return it without rendering markdown.
- **Writes** reuse the snapshot-restore path (`DirectConnection` → `blocksToXmlFragment`): open
  editors receive the change live; the store hook re-indexes links/tags/tasks/text.
- **Client (`inklingctl sync <vault> --workspace <id>`):** state in `<vault>/.inkling/`:
  `sync-state.json` maps pageId → {path, localHash (file bytes), serverHash, revision} and
  `base/<pageId>.md` keeps the last synced text as the merge ancestor. Per page: only local
  changed → PUT; only server changed → write file; both → line diff3 (ADR 0202). After any
  upload the vault file is replaced by the server's canonical rendering unless it changed during
  the run — this keeps base, local and server in one normal form, so later merges see only real
  edits. Renames/moves are tracked by pageId (state path → frontmatter `inkling-id` → identical
  content hash) and applied before content, so links Obsidian rewrote resolve to the renamed
  page. New local notes with links/attachments are created empty first, then filled, so `[[links]]`
  between notes created in the same run resolve.

## Alternatives considered
- **`pages.updatedAt` as revision** — bumped seconds later by the debounced store after the
  client's own write (false "server changed"), and blind to unsaved live edits.
- **Monotonic revision counter column** — needs a hook on every Yjs store and still lags live
  edits; the state vector is free and exact.
- **Markdown hash as the 412 check** — rendering markdown is async (BlockNote/JSDOM), so the
  check could not be atomic with the write.
- **Server-side merge** — the server would need the client's base; keeping base files in the
  vault keeps the server stateless per client and works offline.
- **Yjs in the CLI (sync CRDT updates directly)** — exact merges, but Obsidian edits plain files;
  something still has to turn a file diff into CRDT operations, and the vault would hold binary
  state.

## Trade-offs
- `writeBlocksToDoc`-style replace regenerates block ids for the whole page: comment anchors on a
  page edited in the vault become orphaned (comments are kept, shown as detached).
- Canonical rewrite changes formatting of vault files on first sync (`*` bullets, `\` hard breaks,
  aligned tables). It happens once; afterwards the canonical form is a fixed point.
- First sync of N notes costs N/100 batch reads; uploads are one request per changed note (rate
  limit 600/min on write routes).

## How others solve it
- Obsidian Sync: server keeps file versions; conflicting edits are merged with diff-match-patch or
  saved as a conflict copy.
- Git-based vault sync (obsidian-git): 3-way merge with the last commit as base — same model as
  `.inkling/base/`.
- Notion/Logseq database sync: CRDT/OT on the server, files are export artifacts only.

## Consequences
- Sync never overwrites unmerged work: conflicts produce `<name> (conflict YYYY-MM-DD).md` and the
  note is skipped until that copy is deleted (ADR 0202).
- Only `doc` pages sync. Folder pages map to directories; canvases and collection pages are not
  synced (collection rows sync as ordinary docs, without their collection field values).

## References
- apps/server/src/routes/sync.ts:88 (`linkSigs`), :112 (`snapshotPage`), PUT handler (`/pages/:id/sync/md`, compare-and-write in `conn.transact`)
- apps/server/src/md/syncMd.ts:45 (`metaHash`), `revisionFromDoc` / `revisionFromState`
- apps/server/src/db/schema-sync.ts (`page_sync_hashes`)
- apps/server/src/md/docWrite.ts:20 (the restore path this reuses)
- apps/server/src/collab.ts:36 (debounced store that motivated the token choice)
- apps/cli/src/commands/sync.ts (`SyncRun.run`, two passes), apps/cli/src/sync/syncApi.ts
