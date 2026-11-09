# 1352. Query blocks compare people by name and relations by title

- Status: Accepted
- Date: 2026-11-09

## Context
Since ADR 1320 a query block shows a person field as the member's name and a relation field as links
to the linked rows, but WHERE and SORT still worked on the stored values. `SORT Owner` ordered the
rows by user id, which looks random next to the names in the column, and `WHERE Owner = "Priya Nair"`
matched nothing; the only filter that worked was `Owner = "<user id>"`, an id the block no longer
shows anywhere. Relations had the same problem: ``WHERE `Blocked by` = "Search ranking v2"`` matched
nothing, and a filter on the stored ids could still tell a viewer that a row links to a row that is
private to someone else.

## Decision
- WHERE, SORT, `contains()` and the truthiness of a property use a comparison key. For a person or
  relation field of the row's collection holding the stored shape (a uuid, a list of uuids; the same
  rule as the display pass in `query/cellRefs.ts`) the key is
  - person: the member's name; not a member of the workspace (C-L11): no value;
  - relation: the titles of the linked rows that are alive, in this workspace, children of the field's
    target collection and visible to the viewer (`visibleTo`), in stored order; none visible: `[]`.
  Every other value (select labels, numbers, dates, free page properties, a text field holding an id)
  is its own key, so those queries mean what they meant before.
- SORT on a relation orders by the titles joined with ", " (a string). The jsonb order of arrays
  compares the length first, which would put every one-link row before every two-link row.
- `=`, `!=` and `contains()` with a string literal also match the stored id of a member or of a
  visible linked row, so a query written with ids before this change keeps working. An id of a
  non-member or of a hidden or trashed row no longer matches anything.
- Name and title matching is exact and case-sensitive, like select labels in query blocks.
- TABLE columns and the LIST value still return the stored value; the display pass of ADR 1320 turns
  it into names and links after LIMIT, as before.
- In SQL (`query/compile.ts`): the key is computed in its own lateral (`fk`, `OFFSET 0`) after the value
  lateral, only for properties that WHERE / SORT / a comparison column use. Those properties read the
  collection's field definition once (`fd` lateral) for both the value and the key; queries that compare
  no property produce the same statement as before. The subqueries name `users` and `pages` without an
  alias so that the visibility and membership predicates bind to the linked row, never to the result
  row. Each link is one primary-key probe with `LIMIT 1`; without it the planner flattened the probe
  into a join and scanned the whole target collection for every result row.

## Alternatives considered
- Resolve after LIMIT (like the display pass). WHERE and SORT decide which rows survive LIMIT, so they
  cannot run after it.
- Change the value itself to the name / titles (one column instead of value + key). The display pass
  needs the stored ids to build links, and the block would show `Owner` differently in a column and in
  an expression.
- Name only, no id fallback. Cleaner, but it silently empties every query block that was written with
  ids, which was the only form that worked in 0.9.0 and is what ADR 1320 promised to keep.
- Case-insensitive name matching (the table view's filter and `query_rows` match names and e-mail
  addresses case-insensitively). The query block compares every other string case-sensitively; a
  second rule for two field types would be harder to explain. Revisit together with a `lower()`
  function in the query language.
- An uncorrelated map of all visible linked titles computed once per statement. The relation target
  depends on the row's collection (the same field name can point to different collections), so the
  map would cover every collection's targets; not measured.

## Consequences
- `SORT Owner` follows the names shown; `WHERE Owner = "Priya Nair"` and
  ``WHERE `Blocked by` = "Search ranking v2"`` match.
- Rows whose linked rows are all hidden from the viewer compare as having no links, so a filter or a
  sort no longer reveals hidden links.
- Cost (docs/PERFORMANCE.md, 2,000 candidate rows): person keys +0.4 to +1.5 ms; relation keys about
  20 µs per candidate row (`SORT Depends` 11.3 → 48.7 ms, `WHERE Depends = "…"` 10.8 → 59.2 ms);
  WHERE / SORT on any other collection field +1.8 ms (the shared key path); queries that compare no
  property unchanged.
- A link stored twice compares as two equal titles (the display shows it once).
- API clients see the same result shape; only which rows match and their order change for person and
  relation fields.

Tests: `apps/server/src/query/compareByName.db.test.ts` (sort and match by name with id order opposite
to name order, id fallback, non-members, relation titles in WHERE / SORT / contains, a hidden linked
row neither matches nor moves the order, its author sees it), `apps/server/src/query/query.test.ts`
(keys only for compared properties, visibility inside the key), `apps/server/src/query/cellRefs.db.test.ts`
(display unchanged).
