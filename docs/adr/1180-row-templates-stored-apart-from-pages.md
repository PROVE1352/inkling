# 1180. Row templates: a table of their own, never pages

- Status: Accepted
- Date: 2026-11-07

## Context
A database "New row" should start from a prepared row: a title pattern, property values and a body,
several per database, one of them the default (Notion database templates; AppFlowy, SiYuan, Anytype,
Tana and Capacities have the same idea). The body should be edited with the page editor.

The obvious model, a template that *is* a page (a hidden child of the collection), is the one
ADR 0920 removed: `pages.is_template` needed exclusion filters in query blocks, public folder
shares, webhooks, review, digests and mentions, and migration 0032 dropped it. A hidden row would
also be a child of the collection, so every reader of `parent_id = collection` (the row list, row
cap, covers, CSV export, calendar, iCal, `query_rows`, relation pickers, sheet sync) would need the
filter too, plus search (`page_texts`, `page_chunks`), backlinks (`page_links`), tags, tasks, the
graph, trash, sharing and the MCP page lists. Missing one filter shows a template as a row or leaks
it into search.

The gallery's `templates` table was the other candidate (a `collection_id` column on it). Its rules
do not fit: gallery templates are visible by `scope`/creator and deleted by the creator or a
manager, while a row template belongs to a database and follows that database's visibility and
edit lock. Sharing the table would need `collection_id IS NULL` in the gallery list, resolve,
from-template and delete paths, and a mistake there would make a row template usable through the
gallery with the gallery's permission rules.

## Decision
- New table `collection_row_templates` (`apps/server/src/db/schema.ts`): `id`, `collection_id`
  (→ `pages.id`, `ON DELETE CASCADE`), `name`, `icon`, `title` (pattern), `props` (jsonb, defaults
  by field id), `state` (bytea, Yjs V1 update of the `document` fragment, null = empty),
  `is_default`, `sort_order`, `created_by`, `created_at`, `updated_at`. Index
  `(collection_id, sort_order)`; partial unique index `(collection_id) WHERE is_default`, so a
  database has at most one default and setting a new one clears the old in the same transaction.
- At most `ROW_TEMPLATES_MAX = 20` per database, bodies up to `ROW_TEMPLATE_BODY_MAX_BYTES = 2 MiB`
  (`packages/shared/src/rowTemplates.ts`).
- The only readers are `routes/rowTemplates.ts`, `createRow` (`rowTemplates.ts`), duplicate and the
  structure-template snapshot/instantiate/file code. Nothing that indexes, lists or exports pages
  reads this table, so templates are absent from search, backlinks, query blocks, the graph,
  webhooks, the sidebar and MCP `list_pages`/`search` by construction, with no filter to forget.
- Trash keeps them (the collection row still exists); purge removes them through the cascade.
  Backups are `pg_dump`, so they are included.

## Alternatives considered
- **Hidden page rows** (above): editor and attachments for free, at the cost of a filter in every
  reader of pages; rejected for the reasons ADR 0920 already recorded.
- **`templates.collection_id`**: one table for both kinds of template; rejected because the
  visibility and delete rules differ and the gallery paths would need exclusion filters.
- **Template id on views** (Anytype's per-view default): kept for later; it is one optional
  `ViewConfig.rowTemplateId` on top of this table.

## Trade-offs
- The editor cannot simply open a page; it edits a local Yjs document (ADR 1182).
- A body is a Yjs update in bytea, not Markdown: what the editor writes (callouts, mentions,
  embeds) survives, but SQL cannot read it.

## Consequences
- Migration (generated SQL to commit with the change): one `CREATE TABLE`, two foreign keys, two
  indexes; no change to existing tables.
- A database's templates go wherever the database goes when it is copied (ADR 1183).
