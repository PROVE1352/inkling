# 2102. Following section links: block id, name, then the change log

- Status: Accepted
- Date: 2026-11-10

## Context
A heading is renamed or moved; a link to it should keep working where the system can tell where the
section went, and say clearly when it cannot.

## Decision
- **Order** (`context/sectionLinks.ts` on the server, `lib/sectionLinkMatch.ts` in the editor):
  1. the heading block id in the link (`b`): survives renames and moves inside the page;
  2. the heading text with read_page's rules (`findSection`: anchor, path, text, slug, case-insensitive);
  3. the change log's rename replay (`resolveMovedSection`, ADR 1501), bounded by its retention.
  `renamed` when found under another name than the link has.
- **Clicking** a section link navigates to the page with the fragment; once the document is synced the
  editor looks for the block id, then the text (headings anywhere in the document, also in toggles),
  then asks `GET /pages/:id/section-link?heading=&block=` (the change log). Found → the existing
  `?block=<id>` jump (open folds, scroll, flash, ADR 1221); not found → the page stays at the top and
  a toast says "Heading … was not found on this page". The fragment is removed, so the same link can
  be clicked again.
- **Not rewritten**: links are not edited when their heading changes (no cross-document writes on a
  rename); the backlinks panel and check_notes show the resolution instead.

## Alternatives considered
- **Rewrite every linking document on a heading rename** (as some tools do for page renames). Writes
  into other people's documents, conflicts with locks and suggest-only connections, and a rename typed
  over several seconds would cause a storm of writes.
- **Mark every renamed link as broken.** Throws away the block id and the change log, both of which
  already know the answer.

## Trade-offs
- A section that `split_page` moved to a subpage (ADR 1140) is gone from the page: its links resolve to
  `missing` (the Markdown form `[[Page#Heading]]` written after the split goes to the subpage, as before).
  Following them to the subpage titled like the heading is possible later (the rule buildTitleResolver
  already uses); not done in 0.17.
- A section link from a page to one of its own headings is not in page_links (self-links are dropped), so
  it has no backlink row and check_notes does not check it; clicking it works.
- A link from Markdown or MCP (no block id) whose heading was renamed and then the change log expired
  is `missing`. Guests cannot use the server fallback (the route needs membership); the editor's own
  lookup still works for them.
