# 1920. Vault sync revisions see deletions

- Status: Accepted
- Date: 2026-11-10

## Context
The vault-sync revision (ADR 0200) was `<state vector hash>.<metadata hash>`. A Yjs deletion does not
move the state vector, so a pure deletion on the server (an agent's `patch_section mode=delete`, a
person deleting a paragraph) left the revision unchanged. `inklingctl sync` only reads the server
version when the revision differs, and the PUT accepts a write when the revision is equal, then
replaces the whole document. Sync, delete a section on the server, edit another line in the vault,
sync: the deleted section came back. The end-to-end test reproduces it with the real CLI.

The same PUT replaced the document by deleting every block and inserting the note's blocks. Typing a
browser had sent but the server had not applied yet landed inside deleted blocks and was lost.

## Decision
- The document half of the revision is `<state vector hash>-<delete set hash>`. The delete set is
  hashed in a canonical form (clients ascending, ranges sorted and merged), so the live document
  (from its struct store) and a stored V1 or V2 state (from the update's delete-set section) give the
  same token, before and after GC or a reload. The stored path decodes the state once and derives
  the state vector from the same decode.
- Compatibility, server side only: a token without `-` was issued before 0.15.1. It never equals a
  current one. The deployed CLI already handles that: a changed revision with an unchanged content
  hash is adopted without a read; a PUT with a stale token gets 412 with the current version and goes
  through the three-way merge, where base equals server, so no conflict copy. A DELETE with a legacy
  token is accepted when its state-vector half and metadata still match: only deletions can have
  happened since, and the page goes to the trash anyway. Otherwise the note would be restored once.
- The PUT applies the note as a minimal edit of the whole document (the `update_page` replace path,
  ADR 1500): blocks the note did not change keep their nodes, so in-flight typing into them survives
  and their colours and ids are kept. If that edit does not validate, the document is rewritten as
  before.

## Alternatives considered
- **A content hash as revision**: the change feed would have to render every changed page to
  Markdown (it only decodes states today, up to 20k pages), and the PUT compare runs synchronously
  inside the Yjs transaction, where rendering is async.
- **`Y.encodeSnapshot`**: its byte layout depends on client order and on how ranges were merged, so
  the live and stored forms would need the same canonicalisation anyway.
- **Accepting legacy tokens on PUT by the state-vector half**: that is exactly the bug.

## Consequences
- Measured on a 1.17 MB V2 state (6,000 paragraphs, edits and formats): 3.0 ms (state vector only)
  → 11.5 ms (state vector and delete set from one decode) per stored page in the change feed.
- The first sync after the upgrade re-reads pages whose revision changed since the vault's cursor and
  merges notes edited locally once (the legacy token gets a 412, then the merge uploads); nothing is
  overwritten or marked as a conflict. An untouched page keeps its legacy token in the vault state
  until it changes; then the revisions differ and the CLI reads it as for any change.

## References
- apps/server/src/md/syncMd.ts, apps/server/src/routes/sync.ts
- apps/server/src/routes/vaultSyncRevision.db.test.ts
