# 2260. The web clipper is one REST route that writes a page like an imported file, with no MCP tool

- Status: Accepted
- Date: 2026-11-10

## Context
0.18 lets people save what they see on the web without installing anything: a bookmarklet, the
installed app's share target (manifest `share_target` → `/clip`, GET title/text/url, already in
`vite.config.ts`) and a hand-typed `/clip?url=`. All three need one server write that creates a page
from a URL, an optional selection and tags, under the same permission rules as creating a page.

## Decision
- `POST /api/clip { workspaceId, parentId?, url?, title?, text?, mode: 'link'|'article', tags? }`
  (`routes/clip.ts`, schema `clipRequestSchema` in `packages/shared/src/clip.ts`) answers
  `{ page, mode, fallback?, truncated? }`. `GET /api/clip/lookup?workspaceId&url` lists up to five
  live, visible pages whose `source` property is that URL (JSONB containment on `pages.properties`,
  workspace-scoped, `visibleTo`), so the screen can say "already saved" before a second save.
- Checks, in order and all before any fetch: zod, URL must be http(s) (`CLIP_INVALID_URL`),
  `requireMembership(…, { guests: true })` (suggest-only connections refused there),
  `assertTopLevelInRange` or a visible parent in the same workspace plus an early `assertCan`, then
  `assertPlacement` again under `withTreeLock` when the row is inserted. Same as `POST /pages`.
- Body: a link embed in card form for the source, the selection as quote blocks (one per paragraph),
  tags as `#tag` text (page tags are derived from the body), an italic "Saved … UTC from host" line,
  then the article blocks (ADR 2261). Everything from outside is placed as literal text in blocks;
  nothing goes through `markdownToBlocks`, so `[[x]]`, `@[x](user:…)` and `<!-- inkling:… -->` in a
  web page or selection never become links, mentions or embeds.
- Provenance as ordinary page properties: `source` (type url) and `clipped` (type text,
  `YYYY-MM-DD HH:MM UTC`). Not a date property: page date properties feed the due list and the
  calendar (`md/dateItems.ts`), so every clip would show up as due today.
- The page row is inserted like `POST /pages` (sort order, `created_via`, `page_created` webhook for
  shared pages). The document state is built before the row and inserted in the same transaction
  (a conversion failure leaves no empty page; an article that cannot be stored falls back to the link
  clip); then, like `importMarkdown`, the five derived indexes inside `withEditActor`. The first chunk index logs `page_added` with the clipping person as actor
  and runs the injection heuristics on the clipped text like any page (ADR 0977).
- Not an MCP tool (ADR 2262). Not in `CORE_TOOLS`/`HIDDEN_GROUPS`.
- No migration: the lookup scans the workspace's page properties with `@>`; a GIN index can come
  later if lookups show up in timings.

## Alternatives considered
- Reuse `POST /pages` + `POST /pages/:id/content` (as MCP `create_page` does through import):
  two requests, Markdown in between (the injection problem above), and a page that briefly exists empty.
- A `clips` table with URL, time and page: a second source of truth next to page properties that a
  person can already see and edit.
- Tags as a `tags` property: not indexed into `page_tags`, so `#tag` views would not find clips.

## Trade-offs
- The lookup is an unindexed containment scan per workspace (one statement, rows limited to visible
  pages); fine for the sizes the app targets, revisit with a GIN index if needed.
- Saved time is shown in UTC; the browser's time zone is not sent.

## Consequences
- `guests.db.test.ts` has a line for the route (guests clip only under pages shared with them for
  editing), `mcpTools/testHarness.ts` registers it so the suggest-only route sweep covers it.
