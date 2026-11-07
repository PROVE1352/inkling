# 1142. Links into a split page: keep the page, move anchors with their blocks, resolve [[Page#Heading]]

- Status: Accepted
- Date: 2026-11-07

## Context
A split (ADR 1140) moves sections of a page to new pages. Things that pointed into those sections
must not break. What exists in this codebase, checked against the code:
- Internal links in documents are `link` marks with href `/w/<ws>/p/<pageId>` and nothing else
  (`INTERNAL_HREF_RE`, md/convert.ts); `page_links` (backlinks) is page to page. There is no stored
  form of "page X, section Y".
- `[[Title#Heading]]` written through the API or MCP did not resolve (the resolver looked up
  `title#heading` as a title) and stayed literal text; vault sync stripped `#Heading`.
- Deep links into a page use block ids: `?block=<id>` (calendar, task lists), `comments.block_id`,
  `notifications.anchor`, `page_tasks.block_id`, and `section=` reads fall back to the heading's block id.

## Decision
- **The page keeps its id** and gets a link to each subpage where the section was. Every existing
  backlink still lands on it, one click from the moved section. Other members' pages are not edited.
- **Block ids move with their blocks** (clones, ADR 1140), so the subpage answers `?block=` and
  `section=<heading id>` for everything that moved; derived rows (`page_tasks`, `page_chunks`,
  `page_links`) are rebuilt from the documents by the index passes.
- **Comments and notifications** whose block moved are re-pointed in the split's transaction:
  `comments.page_id` for every block inside the section, nested ones included, and
  `notifications.page_id` for notifications about those comments and for notifications anchored at
  a moved block (mentions). Their links in the bell keep opening the right block.
- **`[[Page#Heading]]`** (buildTitleResolver, md/importer.ts) now resolves: to the subpage of Page
  titled Heading when there is one (what a split leaves), else to Page itself. Agents can keep writing
  `[[Lab log#Run 2]]` after the log was split.

## Alternatives considered
- **Rewrite links in other pages to point at the subpages.** There is nothing to rewrite (links carry
  no section), and editing other pages would need the actor's edit right on each of them, including
  locked pages and other members' private pages the actor cannot see.
- **A redirect table (old page + block → new page)** for `?block=` links pasted by hand as external
  URLs. Those open the original page, which lists the subpages; a table and a lookup in the editor
  for that case were not worth a new table now.
- **Leave `[[Page#Heading]]` unresolved.** It was already a dead literal before the split; resolving
  it to the page is strictly better, and to the subpage is what the writer meant.

## Consequences
- An import or `update_page` that contains `[[Page#Heading]]` now produces a link (to Page or its
  subpage) where it produced literal text before. Link text stays `Page#Heading`.
- A hand-pasted URL with `?block=<id>` of a moved block opens the original page without scrolling.

## References
- apps/server/src/md/importer.ts (`buildTitleResolver`), apps/server/src/md/syncMd.ts (`wikiTitleResolver`)
- apps/server/src/routes/splitPage.ts (comment and notification moves in `runSplit`)
- apps/server/src/routes/splitPage.db.test.ts ("split moves sections …", `[[Lab log#Run 2]]`)
- ADR 1140
