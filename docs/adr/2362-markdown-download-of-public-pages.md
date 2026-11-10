# 2362. Markdown download of public pages: per link, off by default, the page's own blocks

- Status: Accepted
- Date: 2026-11-10

## Context
Visitors of a public link asked for the page as Markdown. The member export (`md/exporter.ts`) writes
frontmatter with the page id, wikilinks as `[[Title]]` of any page the member can see, chart and database
view tokens and snapshots in the member's view, and (agent notation) mention and embed ids. The public page
shows much less: ADR 2120–2123 cut embeds, database views, query blocks and charts to pages inside the
link, and `md/convert.ts publicBlocks` drops whatever is left. A download must not show more than the page.

## Decision
- **Setting**: `pages.share_allow_download boolean not null default false` (migration 0059), next to the
  link's expiry and password. Only `PATCH /pages/:id/share` `{ allowDownload }` changes it, with the same
  rule as the other link settings (owners and admins of the workspace) and an audit row
  `share.download_changed` with before/after. Creating a link never sets it (`createShareSchema` is strict
  and the insert writes `false`); unpublishing clears it (`CLEARED_SHARE_LINK`), so a re-published link
  starts with it off. No MCP tool makes links, and none was added.
- **Routes**: `GET /api/public/:token/export.md` and `GET /api/public/:token/p/:ref/export.md`, rate-limited
  like the other public routes. Order: token lookup (unknown → 404, counted as a guess), the link's gate
  (expired 410, before a scheduled start 404, password 401 until unlocked), page kind (doc or collection;
  a folder itself has no body) and the folder ref (outside, private, trashed → 404), then the setting
  (off → 404, not counted). The gate comes first so a locked or expired link does not reveal whether its
  download is on. For a folder link the folder's setting covers its pages.
- **Content**: the route builds the page's blocks with the same function as its HTML
  (`singlePageBlocks` / `childPageBlocks` in `routes/public.ts`, which the HTML routes now call too),
  runs the HTML's last filter (`publicBlocks`, now exported), leaves out button blocks, turns `/s/…` and
  `/api/public/…` addresses into absolute ones (`PUBLIC_URL` via `configuredPublicOrigin`, never the
  Host header) and writes `plain` Markdown (`md/publicMarkdown.ts`): no frontmatter, no `<!-- inkling:… -->`
  tokens, mentions as `@Label`, links outside the link as their text, query blocks as their result table
  without the query. The title is the first line as a heading.
- **Response**: `text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename*=UTF-8''<title>.md`,
  `Cache-Control: no-store` (as the page JSON), `X-Robots-Tag: noindex, nofollow`, `nosniff`, a sandbox CSP.
- **Test of the property**: `publicExport.db.test.ts` renders one fixture (outside wikilink, mention,
  query block, database view and chart of an outside / inside collection, outside page embed, button with
  a webhook action, image with a file name, comment and suggestion on the page) as HTML and as Markdown
  and checks that every word of the Markdown occurs in the HTML or the title, and that ids, e-mail
  addresses, outside titles and bodies, comment and suggestion text, button actions and tokens are in
  neither. Switching the writer to agent notation or dropping the public filter makes it fail.

## Alternatives considered
- **Reuse `exportPageMd`**: its frontmatter carries the page id and its notation and chart / view
  snapshots are the member's view; a separate public writer over the public blocks is shorter than
  switching all of that off.
- **Check the setting before the gate**: a locked link would answer 404 or 401 depending on the setting.
- **A zip of the whole folder link**: out of scope (one page per download); kept as a candidate.
- **Per-workspace switch**: links differ (a public handbook vs. a review copy); the workspace can still
  turn public links off altogether (ADR 0949).

## Consequences
- Images and files in the Markdown point at the link's public file URLs: they work while the link is
  open; for a password link only in a browser that has unlocked it.
- Downloads are not recorded (the link's views are not either).

## References
- `apps/server/src/routes/public.ts`, `apps/server/src/md/publicMarkdown.ts`,
  `apps/server/src/routes/pages.ts` (PATCH /share), `apps/server/src/publicExport.db.test.ts`,
  ADR 1170, 1171, 1844, 2120–2123, 2244
