# 2101. Section references in `page_links.sections`; backlinks name the heading

- Status: Accepted
- Date: 2026-11-10

## Context
The backlinks panel and check_notes must know which heading a section link points at. `page_links`
holds one row per (source, target), rebuilt from the document by the store indexer; reading every
source document at request time is what ADR 0750 moved away from.

## Decision
- **Migration 0052**: `page_links.sections jsonb NULL` — the headings the source's section links name
  in that target, `[{ h, b? }]`, deduplicated by block id or heading, at most 20 per pair. Null when
  the source only links the page. The primary key is unchanged: a page link and section links to the
  same page are one row, one backlink, one graph edge.
- **Writers**: `reindexPageLinks` fills it from `extractLinkSections`. The docIndexer's link signature
  includes the section refs, so adding `[[Guide#Usage]]` next to an existing `[[Guide]]` reindexes.
- **Backlinks route**: `GET /pages/:id/backlinks` adds `sections: { <sourceId>: [{ heading, status }] }`
  when any source has section links (absent otherwise, as before). Each ref is resolved against the
  target's sections now (ADR 2102): `found` / `renamed` show the heading as it is called now, `missing`
  the name in the link. The right panel lists them under each source page.

## Alternatives considered
- **A row per (source, target, heading).** Changes the primary key and every reader of page_links
  (graph, islands, unlinked mentions, check_notes) for data only two readers use.
- **Resolve from the source documents at read time.** One decode per source per request.

## Trade-offs
- Stored names go stale until the source is reindexed; the backlinks route re-resolves on every read
  (one outline read of the target, the change-log trace only for unresolved names).
