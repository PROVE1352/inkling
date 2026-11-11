# 2505. Limits: checked in the creating transaction, at every insert site

- Status: Accepted
- Date: 2026-11-12

## Context
0.22 lets an operator cap pages, members and owned workspaces per workspace or person, the size of one
upload, the storage of a workspace and the versions kept per page (ADR 2500). A cap only holds if no path
can create past it: the REST routes, the MCP tools (which call REST), imports, duplication, templates,
splitting, sync, the web clipper, the onboarding sample and form answers all create pages, and two
concurrent requests must not both pass the last free place.

## Decision
- **Two functions** in `apps/server/src/quota/room.ts`, called in the creating transaction right before
  the insert: `assertWorkspaceRoom(tx, workspaceId, { pages?, bytes?, members?, memberId?, reserve? })`
  and `assertUserRoom(tx, userId, { workspaces })`. Errors: 403 `LIMIT_PAGES`, `LIMIT_MEMBERS`,
  `LIMIT_WORKSPACES`, 413 `LIMIT_STORAGE`, `LIMIT_FILE`, all with `{ limit, used }` (bytes, marked
  `unit: 'bytes'`, for the last two).
- **No setting, no read.** With the relevant limit unset the functions return before any SQL, lock
  included (a test passes an executor that throws when used).
- **Locks.** Pages and bytes: `ws-quota:<workspace>`; members: the existing member lock
  `ws-members:<workspace>`; owned workspaces: `user-ws:<user>`. All are transaction-scoped advisory locks,
  taken after the tree and member locks a path already holds, so the order is tree → members → quota.
  Transfer, promotion to owner and restore run in B's / existing functions that open their own
  transaction; `withUserRoom` takes the user lock in an outer transaction around them, so the order there
  is user → members, the same as creating a workspace.
- **Batches check once, for the whole batch, before the first insert**: duplicate (the subtree and its
  bodies), row batch, folder and Notion import, template trees, split, sheet sync. A refused batch
  creates nothing. Folder import writes its attachments before the page transaction: it checks first
  without reserving, and removes the attachments if the page transaction is refused.
- **Bytes are reserved**: an upload's bytes are added to `workspaces.storage_bytes` in the same
  transaction, so concurrent uploads see each other (ADR 2506).
- **Every insert site is listed** in `quota/sweep.test.ts`, which scans the source for inserts into
  `pages`, `files`, `workspace_members` and `workspaces` and fails on an unlisted one or one without a
  check above it:

| Site | Rows per call | Check |
|---|---|---|
| `routes/pages.ts` create, duplicate, expand to canvas | 1, subtree, 1 | room: pages (+ copied body bytes, canvas bytes) |
| `rowTemplates.ts createRow` (REST row, MCP `create_row`, public form answers) | 1 | room: pages + template body bytes |
| `routes/collectionsExt.ts` row batch | n | room: n pages |
| `md/importer.ts` single .md, folder/zip | 1, n | room: pages + file bytes; folder: pre-check, then n pages + archive bytes |
| `md/notionImport.ts` | n | room: n pages + archive bytes |
| `templates/structure.ts instantiateTree` (templates, onboarding sample, MCP `create_from_template`) | n | room: n pages + body bytes |
| `routes/clip.ts`, `routes/tasks.ts`, `routes/sync.ts` | 1 | room: pages |
| `routes/splitPage.ts insertChildren` (split, rotation) | n | room: n pages + body bytes |
| `routes/sheetSync.ts` | n | room: n pages |
| `routes/files.ts` upload | 1 file | room: bytes, in a transaction; a full workspace is refused before the body is read |
| `routes/workspaces.ts` create / join / direct add | 1 | user room / room: members (no check for someone already a member) |
| `routes/auth.ts` sign-up, `routes/oidc.ts` first login | 1 workspace | none: the first workspace is always allowed |

- **Owned workspaces** count every workspace where the person is an owner, deleted-but-restorable ones
  included. Transfer and promotion to owner check the new owner; restoring checks that the owner is not
  already over (the deleted one is counted already). The error text points at "permanently delete"
  (B's `DELETE /api/workspaces/:id/permanent`).
- **File size**: `LIMIT_FILE_MB` lowers the per-request multipart cap of `POST /api/files` (the plugin's
  25 MB stays); connections get `min(AGENT_UPLOAD_MAX_MB, LIMIT_FILE_MB)`. Without it the answer stays
  413 `PAYLOAD_TOO_LARGE`.
- **Versions**: `LIMIT_VERSIONS_PER_PAGE` is read when pruning (`quota/versions.ts snapshotBudget`); a
  lower total scales the AI-step caps (40 % per client, 60 % per page) so agents still cannot push the
  people's versions out.

## Consequences
- A new creating path fails the sweep test until it calls the check.
- Page guests are not members and are not counted; a page can have at most 50 people of its own.
- Calls with the bare `db` (the folder-import pre-check) are not race-safe; the transaction check after
  them is.
