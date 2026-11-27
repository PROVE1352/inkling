# 2590. Pinned pages: one flag on the page, the same for the whole workspace

- Status: Accepted
- Date: 2026-11-27

## Context
A team often wants a few pages (an index, this week's plan) to stay at the top of their siblings in the sidebar.
Dragging a page to the top works until someone creates or moves a page there: new pages and moved pages land in
`sort_order` like any other, and nothing shows that the first page was meant to stay first. Favorites already put
pages at the top of the sidebar, but they are one person's list.

## Decision
- `pages.pinned` (boolean, not null, default false), migration 0065. Existing pages are not pinned, so every tree
  keeps its order on upgrade.
- A pinned page comes first among the siblings under the same parent; pinned pages keep their drag order
  (`sort_order`) among themselves. New pages and pages moved in go below the pinned ones. The order is computed by
  the shared comparator of docs/adr/2591-*, so the sidebar, `GET /api/workspaces/:id/pages` and the MCP `list_pages`
  agree.
- The flag is the workspace's: every member sees the same pinned pages. `PageMetaDTO.pinned` is `true` only for a
  pinned page and absent otherwise.
- `PUT /api/pages/:id/pin { pinned }` → `{ page }`, a signed-in browser only (a token gets 403). The caller must be
  able to edit the page (edit lock, page levels, docs/adr/0970-*); guests get 403 and people outside the workspace
  404. It bumps the page's `updated_at` as a drag does, so the tree's ETag changes and other members' sidebars pick
  it up on their next poll.
- Web: **Pin to top** / **Unpin** in a page row's ⋯ and right-click menu; a pinned row shows a small pin next to its
  title.
- Agents cannot pin: there is no tool, and the route is browser-only. How the tree is arranged stays a decision of
  the people in it.

## Alternatives
- Shared favorites (extend bookmarks to the workspace). Favorites are one person's shortcuts in a separate list;
  making some of them shared would give the same feature two meanings and would not change the order inside the
  tree.
- Push the page's `sort_order` far below the others. A later drag or a new page can still go above it, and nothing
  records that the page is meant to stay first, so the sidebar could not show it or offer **Unpin**.

## Consequences
- Pinning needs edit rights on the page, like a rename; a read-only member sees pins but cannot change them.
- A pinned page under a parent sorted by title still comes first (docs/adr/2591-*).
