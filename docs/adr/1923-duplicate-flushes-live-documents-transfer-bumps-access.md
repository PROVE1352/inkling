# 1923. Duplicate copies the live document; ownership transfer is an access change

- Status: Accepted
- Date: 2026-11-10

## Context
- Duplicating a page copies `page_docs`, `page_texts` and `page_chunks` inside Postgres (ADR 0751).
  An open page leads `page_docs` by up to the store debounce (2–10 s), so the copy missed what was
  just typed, and its copied index described the stored state, not the copy's content after a later
  store.
- `transferOwnership` changes two roles but did not bump the workspace access version (ADR 1071).
  Lock chains and agent contexts cached under the old version stayed valid for the old roles.

## Decision
- Before copying, `flushLiveDocuments` stores every open document of the subtree that changed since
  its last store, through the normal store path with immediate indexing; unchanged ones finish their
  pending index pass. A failed store fails the duplicate instead of copying a stale state.
- `transferOwnership` calls `bumpAcl` right after the member lock, like `changeMemberRole`.

## References
- apps/server/src/collab.ts (`flushLiveDocuments`), apps/server/src/routes/pages.ts, apps/server/src/workspaceDeletion.ts
- apps/server/src/syncEdges.db.test.ts
