# 2140. Collection fields: automatic values, email and phone, unique IDs from a trigger

- Status: Accepted
- Date: 2026-11-10

## Context
The 0.16 evaluation listed the Notion field types Inkling lacked: created and last edited time, created by
and last edited by, a unique ID, email and phone (files: ADR 2143). Rows already carry most of what the
automatic values need (`pages.created_at`, `updated_at`, `created_by`, `created_via`); a last editor and a
per-collection number did not exist. Every reader of rows (the web views, charts, formulas, query_rows,
exports, forms) reads values from `props`.

## Decision
- **Seven new `fieldTypeSchema` values.** `email`, `phone`: stored text like `url` (light checks:
  `looksLikeEmail`, `looksLikePhone`, used by forms and MCP writes; the web links them with `mailto:` /
  `tel:`). Automatic, read-only: `createdTime`, `editedTime`, `createdBy`, `editedBy`, `uniqueId`.
- **Automatic values are never stored.** Every route that serves rows fills them into `props` from the
  page columns (`fillAutoProps` in packages/shared; `fillAutoInto` / `autoPropsSql` in
  `collectionQuery/autoValues.ts`), the way rollups are computed: timestamps as fixed-width ISO UTC
  strings (`2026-11-10T09:12:33.120Z`, `to_char` in SQL gives the same text as `toISOString`), people as
  user ids with the via label next to them under `via:<fieldId>` (ADR 2141), the ID as a number. So sort,
  filter, group, charts, formulas and exports need no special path. Writes to them are dropped by
  `PATCH /pages/:id/props`, the batch sanitizer, CSV/paste coercion and row templates; MCP `create_row` /
  `update_row` refuse them with `"X" is an automatic value (type, read-only)`. Forms never ask for them
  (`FORM_FIELD_TYPES`).
- **Unique ID.** `uniqueId: { prefix }` on the field (letters and digits, at most 12; one ID field per
  collection). Shown as `PREFIX-n` (`formatUniqueId`); filters and agents accept `TASK-12`, `task-12`,
  `#12` or `12` (`parseUniqueId`). The number lives in `pages.row_number`; the counter in
  `collections.row_seq` (migration 0051, with a partial unique index on `(parent_id, row_number)` as a
  backstop).
- **One assignment point: triggers.** Thirteen code paths insert pages and rows also arrive by moves,
  duplicates, imports, sheet sync, templates and forms. `pages_row_number_ins` (BEFORE INSERT) and
  `pages_row_number_move` (BEFORE UPDATE OF parent_id, when it changes) run
  `UPDATE collections SET row_seq = row_seq + 1 WHERE page_id = NEW.parent_id AND fields @> '[{"type":"uniqueId"}]'
  RETURNING row_seq`: the row lock on the collection serializes parallel creates until commit (no
  duplicates), the counter only grows (a trashed or purged row's number is never handed out again; a
  rolled-back insert's number was never visible), and the WHERE is re-checked after a lock wait, so a
  create that waited for a fields update that added the ID gets a number. A row that leaves a collection
  loses its number; one that enters another collection gets that collection's next number.
  `collections_row_number_backfill` (BEFORE INSERT OR UPDATE OF fields, when the fields contain an ID)
  numbers the rows that have none, in manual order (sort_order, created_at, id), trashed rows included —
  this covers a new ID property and the trees (templates, Notion import, duplicates) that insert rows
  before their collection row.
- **Behaviour per consumer**: see the table in the 0.17 notes (CHANGELOG, docs/MCP.md). query_rows maps
  email/phone → text, created/edited time → date (UTC day; sort by the whole timestamp), created/edited
  by → person (filter by member name, email, `me`), uniqueId → number. Rollups may only count automatic
  values of linked rows (like formulas, ADR 1824). Formulas: `prop("ID")` is the number, the times are
  dates, the people are not readable (as person, ADR 1824). query_rows computes them in SQL only for the
  fields a filter or sort reads (ADR 2192); public pages and the Markdown download fill them too (ADR 2190).

## Alternatives considered
- **Number in props**: PATCH merges arbitrary keys, duplicate and templates copy props, and the row
  version hashes props; a column cannot be overwritten by any of them.
- **Assign in application code**: one helper called from every insert path — thirteen today, and the next
  path that forgets it creates rows without IDs. A sequence per collection: DDL per collection.
- **Store automatic values in props on write**: every writer of `updated_at` (about 30) would have to
  keep them in step.

## References
- apps/server/drizzle/0051_v017_collection_rows.sql, packages/shared/src/collectionFields.ts,
  apps/server/src/collectionQuery/{autoValues,values,filter,compile}.ts, routes/collections.ts,
  routes/collectionQuery.ts, rowTemplates.ts
- apps/server/src/collectionQuery/rows017.db.test.ts, fields017.test.ts
- ADR 1823–1828 (formulas), 2141 (last editor), 2143 (files)
