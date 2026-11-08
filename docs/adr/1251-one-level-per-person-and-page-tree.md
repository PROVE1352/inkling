# 1251. One level per person and page tree; members too; separate from the edit lock

- Status: Accepted
- Date: 2026-11-08

## Context
Besides guests (docs/adr/1250-*), teams want exceptions for members: "Kim may only read the contract
pages", "the project lead manages sharing of the project folder". The edit lock (docs/adr/0970-*,
0971-*) already narrows edit and comment through `page_access_overrides` on lock nodes. We need a
model that stays explainable in one sentence.

## Decision
- **Workspace default + page-tree exceptions.** Default level on a shared page: owners and admins
  `full`, members `edit`, non-members nothing. A row in `page_grants` on the page or an ancestor
  replaces the default for that person and subtree; the nearest row wins (a nested row may raise or
  lower). Owners and admins ignore rows (a row for them is refused). Private pages stay their
  author's only: no rows there, no rows considered there.

  | Level | sees | comments | edits | manages people |
  |---|---|---|---|---|
  | view | yes | no | no | no |
  | comment | yes | yes | no | no |
  | edit (member default) | yes | yes | yes | no |
  | full (members only) | yes | yes | yes | yes, on that subtree |

- **Evaluation** with the edit lock: `caps = lockCaps ∧ levelCaps`. The level gives EDIT/COMMENT bits;
  the lock (unchanged) takes bits away under lock nodes; a person needs both. A lock editor with a
  `view` row cannot edit; a `full` member under a lock they are not an editor of cannot edit either.
  Errors say which one refused: `PAGE_ACCESS` (with the level) or `PAGE_LOCKED` (with the lock node).
- **Where it is enforced**: `capsFor`, `assertCan` (and so `assertPageEditable`,
  `assertPageCommentable`, `assertPlacement`, `assertAllEditable`) and `pageLockStatus` in
  `editLock.ts`. Every write path already calls these (AGENTS.md), so member rows are enforced on
  REST, MCP (through REST), collab (read-only socket) and placement without per-route edits. A subtree
  check (trash, move) also checks every page below that carries a row of the person.
- **Managing people** (`GET/PUT/DELETE /pages/:id/access`): owners, admins and `full` members of the
  page. Nobody changes their own row (except leaving) and nobody hands out more than they have.
- **Caching** (docs/adr/1071-*): "this workspace has rows" and the nearest row per (page, user) are
  cached under the workspace access version; every row change runs `bumpAcl` in its transaction after
  the tree and member locks. A request whose account has no row anywhere (known from the user lookup,
  docs/adr/1252-*) skips the lookups entirely.

## Alternatives considered
- **Reuse `page_access_overrides` for member exceptions** (a `user:<id>` deny row on a lock node). It
  has the bits already, but rows count only while the page is `edit_locked`: a "view only" member would
  turn the page into a lock node (badge, lock dialog), turning the lock off would silently drop the
  restriction, and `applyLockChange` rewrites a node's rows from its presets. Overrides also never
  grant visibility, which guests need. Kept separate: rows decide who sees and the person's level,
  overrides stay the lock's fence. Both share the access version and the cache discipline.
- **Union of levels from several rows** (Discord-style allow beats deny): depends on how many rows a
  person has; "nearest wins" matches the lock and the tree the user sees.
- **Role groups** (`group:<id>` subjects): useful later; a layer between default and person fits
  without changing the order.
- **Hiding pages from members with a `none` level**: makes every member list, search and feed depend
  on rows (SQL on every read). Members always see shared pages; "only some people see it" is a
  private page or a separate workspace.

## Consequences
- `PageLockDTO` gains `level` and `guest` (additive); `canEdit`/`canComment` include the level.
- Writes in a workspace with rows pay one walk per page and version (cached); without rows nothing.
- Tests: `guests.db.test.ts` ("members with their own rows"), `pageGrants.test.ts`.
