# 2003. check_notes: a read-only memory check of a workspace or subtree

- Status: Accepted
- Date: 2026-11-10

## Context
Teams keep their memory (wiki) in Inkling and ask agents to tidy it. The material for that — which
links are broken, which pages say the same thing, which pages nobody links to, which verifications
lapsed, which big pages nobody touched — took dozens of list_pages, read_page and search calls, and
a model guessing from a tree cannot see links or verification at all. Every finding names pages, so
the check must not become a way to learn about pages the connection cannot see.

## Decision
- **A new read-only tool, `check_notes(workspaceId?, parentId?, limit?, budget?)`**, over a new route
  `GET /api/workspaces/:id/notes-check?parentId=&limit=` (`notesCheck.ts`, `routes/notesCheck.ts`):
  membership, agent blocks, the two-step requirement and the connection range are requireMembership's
  and visibleTo's; `parentId` must be visible in that workspace (else 404).
- **Kinds** (totals always, top `limit` per kind, default 10, max 50):
  - *broken links*: a `[[X]]` left as text — page_texts keeps a resolved link as its bare label, so a
    literal `[[…]]` there never resolved — looked up with the write path's resolver
    (`buildTitleResolver`: titles, aliases, former titles, `Page#Heading`, visible pages only):
    `missing`, or `not linked, page <id> has that name now` when writing the line again would link it;
    and links (page_links) whose target is now in the trash, when the trashed page is visible.
    Pages with most broken links first, then id.
  - *duplicate titles*: equal after NFKC, case, punctuation, spacing and word order are ignored;
    `Untitled` is no title. Largest group first, then key; ids by id.
  - *unlinked*: no link in or out among visible pages (folders and collection rows excluded, like
    the graph's "unlinked", ADR 1123); oldest change first.
  - *verification* (0.15, ADR 1840–1842): lapsed (oldest first), then verified pages that changed much
    since (most changed sections first).
  - *large and quiet*: documents with ≥ 3,000 indexed tokens (`page_chunks`) not changed for 180 days;
    largest first.
- **No oracle**: every decision is made over the pages the caller can see now. A `[[Title]]` naming
  another member's private page is `missing` for this caller — the same answer as for a title nobody
  used; a link to a hidden page is not an edge (so a page whose only link goes there is "unlinked" for
  this caller, as in linkIslands); a trashed private page of someone else is not reported; duplicate
  groups contain visible pages only.
- **Output**: one header line (ours), the kinds inside one `<untrusted_content source="check">`
  (titles and link texts are member text), one footer line of next steps (patch_section, suggest=true,
  rename/move, trash only with the person's OK, verifying is for people). 8-character ids, dates as
  server-local days, fixed order with id tie-breaks: the same notes give the same bytes on the same
  day. `budget` (default 2,000, 500–8,000 tokens) is met by showing the same smaller number of items
  per kind (`Shown: n per kind to fit the budget`).
- **Not in core**: a memory check is a weekly flow, not an everyday one; in `core` it is reached with
  `more_tools(tool="check_notes", arguments={…})`, and the `memory-review` prompt (ADR 2002) writes
  that call for core connections.

## Measured
- Fixed cost: check_notes in the full list 804 chars, ~201 tokens (descriptions 72, schema 102); 0 in
  core. The catch_up option alternative (a `check` flag plus `parentId` on catch_up) would cost ~84
  tokens in both profiles.
- 2,000-page workspace (500 pages with 2 literal links each, 3,000 page links, 300 duplicate pairs):
  route + rendering p50 18.0 ms, p95 26.8 ms over 20 calls after 5 warm-ups; default answer 552 tokens.
  In-process test app (`app.inject`, MCP over the in-memory transport), Postgres 16 in Docker on
  localhost, Node 22, Apple-silicon MacBook Air shared with other agents' test runs; scratch script
  on the [db] test database (not kept).

## Alternatives considered
- **A `catch_up` option**: ~84 tokens instead of ~201 and present in core, but catch_up is a time
  window that moves the connection's marker (`peek`), answers "what happened", and has no subtree
  argument; a mode switch that changes what the tool means is harder for a model than a named tool.
- **Similar-title detection by trigram similarity or edit distance**: pairwise over every title is
  O(n²) per call and flags numbered series (`Weekly sync 2026-11-03` / `-10`) as near duplicates; the
  normalised key catches case, punctuation and word-order variants only (a limit).
- **Checking literal links in page_chunks**: chunk text renders resolved and unresolved links alike
  (`[[label]]`).

## Limits
page_texts keeps the head and tail of a body over 200 KB, so a literal link in the middle of a huge
page is not seen; text in code blocks counts. Links to pages deleted for good leave no page_links row
and are not reported. A page linked only by someone's private page is "unlinked" for others.

## References
- apps/server/src/notesCheck.ts, routes/notesCheck.ts, mcpTools/notesCheckTools.ts
- apps/server/src/mcpTools/profilesResources.db.test.ts, toolProfiles.test.ts
- docs/adr/0756-*, 1123-*, 1840-*, 2000-*, 2002-*
