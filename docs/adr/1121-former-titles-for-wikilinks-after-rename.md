# 1121. Former page titles: `[[old name]]` still finds a renamed page

- Status: Accepted
- Date: 2026-11-07

## Context
A wikilink in a stored document is a page id (`/w/<ws>/p/<id>`), so links that already exist
survive any rename. Text written *after* a rename is the problem: an agent, a Markdown import, a
vault sync or a template writes `[[Meeting notes]]` from memory, the page has since become
"Weekly sync", and `buildTitleResolver` (current titles, then aliases) finds nothing — the link
stays literal text. A page renamed A → B → C should answer to A and B.

Nothing stored the old names. `page_changes` has `page_renamed` events (before/after), but it is
a change feed: purged after its retention (`purgeOldChanges`), written through the outbox a few
milliseconds after the rename (ADR 1080), and not shaped for lookups by name.

## Decision
`page_former_titles(workspace_id, title_key, page_id, title, renamed_at)`, primary key
`(workspace_id, title_key, page_id)` — one row per page that once had the name
(`apps/server/src/db/schema-titles.ts`, `formerTitles.ts`):

- **Write** (`recordRename`, inside the `PATCH /pages/:id` transaction — every UI rename and MCP
  `rename_page` goes through it): this page's row for the old name is inserted or re-stamped
  (`renamed_at = now()`). If the new title is one of this page's former names, that row is dropped
  (renamed back to A: the current title answers again). Case-only changes and empty titles record
  nothing. Rows belong to one page, so renames of different pages never touch the same row
  (no lock order to get wrong); renames of one page are serialised by the PATCH's row lock.
- **Key** = `title.toLowerCase()` in JavaScript, the same key the resolver builds for current
  titles (not Postgres `lower()`, which can differ for some scripts).
- **Read** (`buildTitleResolver`): batch > current title > alias > former title. A current title
  or alias always wins, so a page that takes the name A later is what `[[A]]` means. The former
  rows are joined with `pages` under the same `visibleTo` filter as the titles (ADR 0756) and the
  most recent holder **the reader can see** wins (`renamed_at`). A private page's old name resolves
  only for its author, a trashed page answers to none, and a private page that later held a shared
  page's old name does not change what that name means for anyone else (a first version keyed by
  `(workspace_id, title_key)` with "newest holder overwrites" did: the shared name stopped
  resolving for other members, which also told them a private page had used it).
- Purging a page or workspace removes its rows (foreign keys, cascade).

## Why this data structure, and where it does not fit
A rename chain looks like a union-find problem: A, B and C are "the same page". The obvious
version — names as elements, a rename = `union(old, new)` — is wrong here, not only slow: when
another page later takes the name A, A must leave the first page's set, and union-find has no
split (`formerTitles.db.test.ts` builds this case; the two pages end up in one set).

What is stored instead is the union-find picture *after* path compression: every former name
points straight at the root, and the root is the page id, which never changes. A → B → C is stored
as A → page, B → page; a lookup is one hop at any chain length, and there is no chain to walk or
compress at read time. A reused name is simply a second row with another root, chosen per reader
by visibility and recency — a choice a forest, with one root per set, cannot express.

## Measured
5,000 pages in one workspace, Postgres 16 in Docker on the same laptop (shared with other
work), Node 22.23.4, `buildTitleResolver` called directly, old (the function body before this
change) and new interleaved 3 × 20 calls; ranges over 2 runs:

| | p50 | p95 |
|---|---:|---:|
| Before (titles + aliases) | 8.3–9.9 ms | 10.7–12.7 ms |
| After, 0 former rows | 7.6–9.0 ms | 9.7–11.8 ms |
| After, 1,000 former rows | 10.3–10.6 ms | 15.4–15.5 ms |

The former-title query runs in parallel with the title query. `recordRename` alone: 2 statements,
p50 2.4–3.0 ms in its own transaction (inside the PATCH it shares the transaction). Measured with
the first version of the key (one row per name, see Read above); the final per-page key adds an
`ORDER BY renamed_at` over the same 1,000 rows of this bench and was not re-measured.

## Alternatives considered
- **Append old titles to `aliases`.** No new table, but aliases are user-visible and editable in
  the page panel; a rename would silently add entries the user did not write, and "newest holder
  wins" could not be expressed.
- **Read `page_changes` at resolve time.** Purged, not indexed by name, and lags the rename.
- **Store old → new title edges and resolve the chain with find + path compression.** Works for
  one page's chain, fails as soon as a name is reused (needs a split), and adds a walk to every
  lookup that storing the id avoids.

## Consequences
- One indexed query more per resolver build (agent writes, imports, sync): nothing measurable
  without former names, about +0.5 to +2 ms p50 with 1,000; two statements more per rename.
- Renames made before this change are not known. Optional one-off backfill for the migration from
  `page_changes` (within its retention), newest rename per page and name:
  `INSERT INTO page_former_titles (workspace_id, title_key, page_id, title, renamed_at)
   SELECT DISTINCT ON (c.workspace_id, lower(c.before_text), c.page_id) c.workspace_id,
   lower(c.before_text), c.page_id, c.before_text, c.changed_at FROM page_changes c
   JOIN pages p ON p.id = c.page_id
   WHERE c.kind = 'page_renamed' AND coalesce(c.before_text, '') <> '' AND lower(c.before_text) <> lower(p.title)
   ORDER BY c.workspace_id, lower(c.before_text), c.page_id, c.seq DESC ON CONFLICT DO NOTHING;`
  (`lower()` here may differ from JavaScript for a few scripts; such rows simply never match.)
- Covered: renames through `PATCH /pages/:id` (sidebar, page header, MCP `rename_page`). Not
  covered: row titles changed by the collection bulk edit route (`collectionsExt`), titles set by
  vault sync on create, and the Notion importer's title fix-up of pages it just created. The
  `update_page`/`patch_section` note "a leading heading also renames it" is about the *section*
  heading, not the page title, so it needs nothing here.
- Rows grow with renames (one per page and former name); purged with the page.

## References
- ADR 0756 (resolver visibility), ADR 1080 (change log through the outbox), ADR 1120 (union-find).
