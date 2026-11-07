# 0951. Document owner and last review

- Status: Accepted
- Date: 2026-11-07

## Context
Team wikis rot when nobody owns a page. Software Engineering at Google (chapter 10) reports that
when GooWiki was retired most pages had gone months without views or edits and attributes it to
missing owners; its remedy is an owner and a "last reviewed" date per document. Inkling pages
had neither.

## Decision
- `pages.owner_id` (users, set null, indexed), `pages.reviewed_at`, `pages.reviewed_by`.
- `PUT /pages/:id/owner { ownerId | null }`: any member who can see the page; the owner must be a
  member; a private page can only be owned by its author. Removing or leaving clears the
  person's ownerships in the same transaction as the removal.
- `POST /pages/:id/review`: "Mark reviewed" = now, by the caller. It does not touch
  `updated_at` (no content change) and recomputes that page's priority row (0953).
- Browser sessions only: review sign-off is a human statement; agents can read the facts
  (`read_page` / `find_context`) but not sign.
- Workspace `review_interval_days` (7–730, null = off, default off) is the base interval of the
  freshness model (0953).
- UI: right panel section "Owner & review" (apps/web/src/components/PageReview.tsx); the
  Review tab of the workspace settings lists documents by priority, with "Only mine".
- MCP: `read_page` header adds `owner`, `reviewedAt` (document date) and `reviewDue` with
  `(stale, p=0.62)`; `find_context` appends `owner X, reviewed YYYY-MM-DD, stale p=0.62` to a
  fragment header. Only document values and the daily batch appear, never "N days ago", and a
  page without facts renders byte-identically (docs/adr/0937-*).

## Alternatives considered
- Reuse page properties (frontmatter) for owner/reviewed: free-form, not validated against
  membership, and agents could set them.
- Review = any edit: an edit is not a statement that the whole page is still right.

## Trade-offs
- The stale flag in MCP output changes once a day at most (batch), not per request.

## How others solve it
- Google g3doc / GooWiki lesson: owners and "freshness date + last reviewed by" in the doc
  header; reminders to owners. https://abseil.io/resources/swe-book/html/ch10.html
- Confluence: page owner and page verification with an expiry.
- Notion wikis: verified pages with an owner and an expiry date.

## Consequences
- The review list needs reminders off by default: a new interval affects all docs at once.

## References
- apps/server/src/db/schema.ts:280
- apps/server/src/routes/workspaceAdmin.ts:412, :418, :438
- apps/server/src/review.ts:283, :334
- apps/server/src/mcp.ts:39, apps/server/src/mcpTools/contextTools.ts:22
