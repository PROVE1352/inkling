# 2591. Sorting by title: one comparator on the server and in the web app

- Status: Accepted
- Date: 2026-11-27

## Context
Folders of dated notes, lecture numbers or people's names are easier to scan in title order, and keeping them in
that order by hand breaks every time someone adds a page. The tree is read in three places: the web sidebar, the
`GET /api/workspaces/:id/pages` answer that other clients and scripts use, and the MCP `list_pages` tool. If only
one of them sorted, an agent told "the third page in Lectures" would pick a different page than the person sees.

## Decision
- A parent page has `pages.child_sort` (`'manual'` or `'title'`, not null, default `'manual'`). The top level has
  two: the shared section's `workspaces.root_child_sort`, one for the workspace (any member may change it, as any
  member may drag the shared top level), and the private section's `workspace_members.private_child_sort`, one per
  person. All three are added by migration 0065 with `'manual'`, so nothing moves on upgrade.
- Routes, browser only (a token gets 403):
  - `PUT /api/pages/:id/child-sort { childSort: 'manual' | 'title' }` → `{ page }`, with the same rights as pinning
    (docs/adr/2590-*). `PageMetaDTO.childSort` is `'title'` only for a parent sorted by title.
  - `PUT /api/workspaces/:id/root-sort { section: 'shared' | 'private', childSort }` → `{ rootSort }`, members only
    (guests 403).
- One comparator. `@inkling/shared` exports `orderPageTree`, `compareSiblings` and `sortSiblingGroup`; the server
  (the pages list, `list_pages`) and the web app (the sidebar and drop position math) call the same code. Pinned pages
  come first, also under a parent sorted by title. Titles compare with
  `Intl.Collator('en', { numeric: true, sensitivity: 'base' })`: "2" before "10", case ignored. The locale is fixed so
  that the server and every browser, whatever their default language, give one order. Equal titles fall back to
  `sort_order`, then `created_at`, then id.
- `GET /api/workspaces/:id/pages` returns the pages in tree order and adds `rootSort: { shared?: 'title',
  private?: 'title' }` when either top level is sorted by title; the ETag includes the top-level order.
  `GET /api/workspaces` carries the same `rootSort` on each workspace.
- Under a parent sorted by title, a drag that only reorders (`PATCH /api/pages/:id` with `sortOrder`, the parent and
  the section unchanged) answers 409 `SORTED_BY_TITLE`. Moving a page in from another parent, or out, still works.
  The web app draws no drop line between such siblings, and a page dragged in from elsewhere only changes its parent.
- `list_pages` (compact, lines and json) prints the sidebar's order. At the top level it mixes the two sections by
  drag order as before while both are manual; when either is sorted by title it prints the shared section, then the
  private one. Inside each section the order always matches the sidebar.
- Web: **Sort subpages by title** (checked when on) in a page row's ⋯ menu, not for databases. Workspace settings ›
  General › **Sidebar order** has two switches: **Sort the shared section by title** and **Sort my private section
  by title**. Guests do not see them.

## Alternatives
- Sort in the web app only. Agents and other clients would see a different order than the person.
- `ORDER BY title COLLATE …` in Postgres. Postgres's ICU collation and the browser's `Intl.Collator` can
  disagree on numbers and Hangul, and the web app has to place a dropped page itself, so the two would drift.
- A collator in each viewer's locale. The server and the browsers do not share a default locale, so the same tree
  would come out in different orders.

## Consequences
- The order of a sorted parent is one setting for everyone; a person who wants their own order uses the private
  section.
- A new client that arranges pages must use the shared comparator, or expect 409 `SORTED_BY_TITLE` when it reorders
  inside a sorted parent.
