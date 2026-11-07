# 0921. Structure templates: atomic instantiation, id remapping and caps

- Status: Accepted
- Date: 2026-11-07

## Context
A template may hold a page tree (e.g. Project = overview document + Tasks database with a board
view + Meeting notes folder). Creating it must not leave half a tree behind, must obey the page
tree invariants (ADR 0800: tree lock, depth cap, public-folder rule, child scope = parent scope)
and must not keep references to the template's source pages.

## Decision
- **Node ids are local keys.** Saving a subtree keeps the source page ids as keys; built-ins and
  imports get fresh uuids. Instantiation maps every key to a new page id and rewrites, in place:
  internal link hrefs `/w/<ws>/p/<key>` (on the Yjs link mark; the workspace segment is rewritten
  too), relation `targetPageId`, relation values in row `props`, canvas `page` cards. References to
  pages outside the template are kept as they are (same workspace).
- **Relations leaving the template** become one-way on save (their two-way pairing belongs to the
  original collection); on import into another workspace they become text fields.
- **Person values** are not stored in templates.
- **One transaction.** All conversions (variables, remapping, Yjs encoding) run first, outside the
  database. Then `withTreeLock` → `assertPlacement(height)` → pages (parents first, chunked),
  `page_docs`, `collections`, `collection_views` in one transaction; any failure rolls back the
  whole tree. Search/tag/task/link indexing follows after commit, best-effort, like page creation.
- **Caps:** 200 pages and 12 levels per template (save, import and instantiate), 20 MB serialized;
  placement still enforces the global depth of 64 and the public-folder rule. One scope for the
  whole instance: the parent's under a parent, otherwise the requested section.
- **Save options:** include sub-pages (folders, docs, canvases, collections) and, separately,
  collection rows as starter rows. Without rows a collection keeps its fields and views.

## Trade-offs
Instantiation holds the workspace tree lock for one multi-row insert of at most 200 pages, which
is short; larger copies remain the job of duplicate/import.
