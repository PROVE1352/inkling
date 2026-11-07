# 1170. Public links can expire

- Status: Accepted
- Date: 2026-11-07

## Context
A public link (`/s/<token>`, docs/adr/0945-*, 0949-*, 1110-*) worked until someone stopped sharing
by hand. People share pages for a meeting, an application or a review and forget them; the link
then stays readable by anyone it was forwarded to. Notion offers link expiry on paid plans only.

## Decision
- **Column**: `pages.share_expires_at timestamptz` (null = never). Set when the link is made
  (`POST /pages/:id/share { expiresAt? | expiresInDays? }`) or later
  (`PATCH /pages/:id/share { expiresAt | expiresInDays }`, owners and admins). `expiresAt: null`
  removes the expiry.
- **Server clock only**. Presets (1, 7, 30 days, or the workspace default, docs/adr/1172-*) are sent
  as a day count and turned into an instant on the server; "on a date" sends the end of that local
  day as an instant (the publisher's time zone is the only thing the browser decides). An explicit
  instant must be at least a minute in the future and at most ten years away (400 otherwise). The
  public routes compare it with the server's `Date.now()`, never with anything the visitor sends.
- **Gate on the link's root page.** `findSharedPageByToken` keeps its WHERE clause (live page, shared
  scope, live workspace) and also returns the expiry from the same row. Every public route runs
  `assertShareOpen` (shareAccess.ts) on that root before any subtree, body or file work:
  `/api/public/:token`, `…/f/:fileId`, `…/p/:ref`, `…/p/:ref/f/:fileId`. A folder's expiry covers
  every page below it; child pages have no expiry of their own.
- **Expired answers 410 `SHARE_EXPIRED`**, not 404. The body is only the code and a fixed message:
  no title, no date, no owner. It is not counted as a token guess (no `recordFailure`): the token is
  real, and counting it would get readers of an old link banned. The web shows "This link has
  expired" instead of "not found". Folding the expiry into the SQL WHERE was rejected because it
  turns expired links into unknown tokens (404, counted as guesses).
- **Unfurl shell** (`/s/…`, docs/adr/0503-*): expired links get the plain shell plus
  `<meta name="robots" content="noindex, nofollow">` and the same `X-Robots-Tag`; no title,
  description or image.
- **Files**: `Cache-Control` max-age is the smaller of 300 s and the time left, `no-store` once it
  has passed, so a shared cache cannot serve a file past the expiry.
- **Owners keep control of expired links.** The link is not deleted at expiry: `GET /pages/:id/share`
  and `GET /workspaces/:id/shared` return `expiresAt` and `expired`, the "Web shares" list marks the
  row "Expired", and the share dialog offers "Change expiry" (extend or remove). Stopping sharing,
  bulk removal and "remove all links" clear the expiry with the token, so a later link starts fresh.
- **Audit**: `share.expiry_changed` with `{expiresAt}` before/after (null = none). A link made with
  an expiry records it in `share.published`'s `after`.
- `pages.updated_at` is not touched (the page did not change; the render cache key stays valid).

## Alternatives considered
- **Delete the token at expiry with a periodic job**: no 410 page, the owner loses the link to extend,
  and a missed run keeps the link alive. The check per request costs nothing (same row).
- **Expiry per child page of a folder share**: no use case, and the folder's own link is the unit
  people send around.
- **Client-computed instants for presets**: a visitor's or publisher's wrong clock would shift the
  expiry; the server count avoids it.

## Consequences
- Placement rules that look at public ancestors (`pageTree.publicAncestors`) still treat an expired
  link as public: it can be extended at any time, so the owner-only placement rule stays.
- Tests: `shareLinks.db.test.ts` (expiry on every route and the shell, extend/remove, list,
  audit), `shareAccess.test.ts` (clock comparison, file cache lifetime, requested expiry).
