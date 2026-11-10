# 2263. /clip is a form filled from its query; the bookmarklet and the share target only open it

- Status: Accepted
- Date: 2026-11-10

## Context
Three ways in, none installed: a bookmarklet, the installed PWA's share target (GET `/clip` with
title/text/url, fixed in `vite.config.ts`), a typed link. Any site can link to `/clip?…`.

## Decision
- `/clip` (`pages/Clip.tsx`, outside the app layout) never writes on load. The query fills a form
  (workspace, location, title, address, text, mode, tags); the page is created only on Save. With
  `frame-ancestors 'self'` in the SPA CSP it cannot be framed for a forced click.
- Query values are text only: control characters dropped, title 300 / text 20,000 code points
  (never splitting a surrogate pair), URL http(s) ≤ 2,048 or dropped (`lib/clipQuery.ts`).
  Share-sheet shapes: the last http(s) link in `text` becomes the URL when `url` is empty and is
  removed from the text; a URL given as title moves to the address; a single short line with no
  title becomes the title; text repeating the title or URL is dropped.
- Signed out: `/login?next=/clip?…`; a query longer than 1,800 characters (OIDC `returnTo` takes
  2,000) is kept in sessionStorage and `next=/clip?stash=1`.
- Location: the default ("Always start here") or else the last one used, in localStorage; guests
  start under their first shared page (no top level for them). Mode remembered. An earlier clip of
  the URL in the workspace is pointed out (lookup). After saving: open the page, close the window
  (only works for script-opened windows; otherwise a hint), or save another.
- Bookmarklet (`buildBookmarklet`, Settings › Connections › Web clipper): `javascript:` code with this
  server's origin, no token or secret; opens `<origin>/clip?title&url&text` in a 520×680 window
  (the current tab when popups are blocked); cuts the selection by code points until the address is
  ≤ 6,000 characters (nginx's default request-line buffer is 8 KiB). React 19 rewrites
  `javascript:` hrefs, so the link's href is set on the element. The settings text says that strict
  CSP sites may block it and what to do instead. `/clip` drops `window.opener` on load.
- `examples/web-clipper-extension/`: a four-file MV3 extension (toolbar button → the same window;
  `activeTab`+`scripting` for the selection, `storage` for the server address), loaded unpacked, not
  published; it is the answer for CSP-strict sites.

## Alternatives considered
- Save on GET (one-tap from the share sheet): any site could write into a signed-in person's notes.
- Bookmarklet that POSTs from the visited page: needs CORS on `/api` and a credential in the page's
  context; CSRF protection (ADR 1062) refuses cross-site writes by design.
- A published extension: store review and updates are out of scope for 0.18.

## Trade-offs
- The selection reaches the server in a URL (logs, history) — the same as any shared link; long
  selections are cut.
- Bookmarklets do nothing on sites whose CSP blocks them (behaviour differs by browser).

## Consequences
- Tests: `lib/clipQuery.test.ts` (share shapes, caps, bookmarklet run in a VM); the browser check
  covers sign-in round trip, save, the opened page, and the bookmarklet on a local page.
