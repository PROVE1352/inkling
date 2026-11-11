# 2506. Storage: counted from every member-grown column, cached, read-only when full

- Status: Accepted
- Date: 2026-11-12

## Context
`LIMIT_WORKSPACE_STORAGE_MB` caps what a workspace keeps. Uploads have a size when they arrive, but page
bodies grow outside any transaction (live editing over the collab socket), and version history, the
change log and the trash grow with them. Counting everything on every write would be slow; counting only
uploads would let a workspace fill the disk with text.

## Decision
- **What counts** (`quota/storage.ts`): file sizes; page bodies (`page_docs` state and state vector);
  versions (`page_snapshots` state, state vector, step); handwriting; comments; the page rows (title,
  row and page properties, aliases, icon, cover); collection fields, views and row templates; custom
  templates; the change log's kept texts; agent suggestions. Trashed pages count until purged.
- **Not counted**: derived indexes (search text, sections, chunks, tags, tasks, links, embeddings — rebuilt
  from the bodies, roughly proportional to them), audit events, notifications, outbox and deliveries
  (retention-bound), per-person tables, OAuth clients, backups.
- **Cache**: `workspaces.storage_bytes`, `storage_checked_at`, `over_storage`. Moved by uploads (reserved
  in their transaction) and by every collab store (the body's growth, before the upsert), recounted by
  the hourly housekeeping, by the store path when the count is older than 10 minutes, by the usage
  route when older than a minute, and after a purge.
- **Full = read-only**: new pages, uploads, imports, templates, comments, handwriting, manual versions and
  every REST/MCP body write (`docWriteGate.ts`, checked on each write) answer 413 `LIMIT_STORAGE`; live
  editing connections are read-only (`collab.ts onAuthenticate`), and the open ones are closed when the
  workspace goes over so they come back read-only. Deleting, purging, clearing handwriting and export
  always work. Gated on the limit: a stale flag on a server without the limit is ignored.
- **One page** may hold at most a quarter of the workspace limit: past it, REST/MCP writes are refused
  and the page's live connections are closed and reopen read-only. The store itself is never refused
  (that would arm the retry timer and pin the document in memory, ADR 1921).

## Consequences
- Between a burst of live typing and the next store the use can pass the limit by what one store
  carries (the store debounce is 2–10 s; one message is bounded by the socket's payload limit).
- Deleting text does not shrink a Yjs state much; the notice points at files, pages and the trash.
- The usage route answers members, pages, storage and file bytes, and the limits that apply.
