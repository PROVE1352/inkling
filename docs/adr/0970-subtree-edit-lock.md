# 0970. Subtree edit lock, enforced at every write path

- Status: Accepted
- Date: 2026-11-07

## Context
Every member can edit every shared page they can see. Teams want a few pages (policies, specs,
agent instruction pages) that only named people change, while everyone keeps reading and
commenting. Agents make this sharper: an MCP connection writes as its user, so "anyone may edit"
also means "any member's agent may edit". Hiding buttons in the web app is not enough; the REST
routes, the collaboration socket and the MCP tools must all refuse.

## Decision
- **Off by default.** `pages.edit_locked boolean NOT NULL DEFAULT false`; migration 0030 leaves
  every existing page unlocked. A lock is only ever turned on by a person in the web app.
- **Subtree.** A lock on a page covers the page and every descendant; the nearest locked
  ancestor-or-self governs (a nested lock replaces the outer editors for its subtree). The
  evaluation order is ADR 0971.
- **Who edits** under a lock with the default preset: workspace owners and admins, the owner
  (`pages.owner_id`, ADR 0951) of the locked page, and the listed editors. Everyone else: read and
  comment.
- **Who changes a lock**: owners/admins, or the page owner while they can edit the page as a person
  (so a nested lock cannot be used to get around an outer one). Browser sessions only
  (`PUT /pages/:id/lock`); there is no MCP tool and bearer tokens are refused: an agent never edits
  its own fence. Every change is audited in the same transaction (`page.locked`, `page.unlocked`,
  `page.lock_editors_changed`).
- **Enforcement points** (all server side):
  - `assertPlacement` (pageTree.ts) now requires `userId` and refuses a parent the actor cannot
    edit, and a moved subtree that contains a lock the actor cannot edit. Making the field required
    let the type checker enumerate every creation path: create, duplicate, expand-canvas, templates,
    Markdown/zip/Notion import, vault-sync create, new collection rows, sheet sync inserts.
  - Explicit `assertCan`/`assertPageEditable` in: PATCH /pages/:id (title, icon, cover, aliases,
    properties, order, move, scope; inside the row-locked transaction), DELETE (trash, whole
    subtree), restore, purge, POST content (update_page, plugins), POST section (patch_section),
    PATCH props, collection rows batch PATCH (subtree), fields PUT, views POST/PATCH/DELETE, task
    toggle, quick-add (the Tasks document), ink PUT, snapshot restore, document owner and living
    override (the owner is an editor, so changing it needs edit rights), sheet-sync PUT/DELETE/run
    and the sheet-sync job itself, vault-sync PUT/DELETE, two-way relation mirroring into another
    collection's rows and its paired schema field.
  - Hocuspocus `onAuthenticate` sets `connection.readOnly` when the member cannot edit; the server
    then answers their sync updates with `SyncStatus(false)` and never applies them. Lock changes
    close the live sockets of the subtree (`closePageConnections`) so clients re-authenticate.
  - MCP write tools inherit all of the above because they call the REST routes as the token user;
    the error `403 PAGE_LOCKED` carries `lockedPageId` and `editors`, and the MCP layer adds a
    code-specific next step (do not retry or work around; comment instead).
- **No cache.** Each check is one recursive CTE over parent_id capped at TREE_MAX_DEPTH (64), the
  pattern of ADR 0800; subtree checks add one descendant walk. Managers skip the people layers but
  still run the walk when the request is an agent's. With no cache there is no invalidation rule.
- Comments, bookmarks, read counters, "mark reviewed", manual snapshots and file uploads stay open
  (see Trade-offs).

## Alternatives considered
- Page-level ACL lists (Notion-style per-page permissions): far more surface, and private pages
  already cover "only me".
- A lock flag checked only in the SPA: trivially bypassed with the API or an agent.
- Caching the governing lock per page: needs invalidation on lock change, move, trash, restore and
  owner change; the CTE is already sub-millisecond on realistic depths.
- Checking the lock inside `findVisiblePage`: would break reads, which must keep working.

## Trade-offs
- Duplicating a locked page next to itself under an unlocked parent is allowed and the copy is
  unlocked: it is a read followed by a new page; the original is untouched.
- File uploads with a `pageId` are not refused: an attachment is inert until a document references
  it, and comments may need uploads.
- Role changes (admin → member) do not close live sockets; the next reconnect is read-only.
- Vault-sync and sheet-sync stop with an error when a lock excludes the user who set them up.

## How others solve it
- Notion: page-level "Can edit / Can comment / Can view" inherited down the page tree, with
  "locked database" for schema only. https://www.notion.com/help/sharing-and-permissions
- Confluence: page restrictions ("Can view / Can edit"), inherited for view restrictions only.
  https://support.atlassian.com/confluence-cloud/docs/what-are-page-restrictions/
- GitHub CODEOWNERS + branch protection: path-scoped required reviewers enforced on the server.
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners

## Consequences
- `PageMetaDTO.editLocked?: true` on lock roots (sidebar badge); `GET /pages/:id/lock` returns the
  governing lock, editors and `canEdit`/`canComment`/`canManage` for the caller.
- New tables `page_access_overrides` and the column `pages.edit_locked` (migration 0030).

## References
- apps/server/src/editLock.ts:75, :104, :196, :288, :358, :439
- apps/server/src/pageTree.ts:157
- apps/server/src/collab.ts:186
- apps/server/src/routes/pages.ts:372 (PATCH), :540 (trash), :815 (restore), :868 (purge); apps/server/src/routes/editLock.ts:117
- apps/server/src/mcpTools/core.ts:49
- apps/server/src/editLock.db.test.ts:162 (write-path matrix), :262 (collab socket)
