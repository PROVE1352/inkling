# 0934. Collection query and row-update tools for agents

- Status: Accepted
- Date: 2026-11-07

## Context

Agents could only read a collection (database) through `read_page`. That tool renders the whole
table as Markdown, with no row ids, no filter and no paging. A 200-row, 8-column collection costs
about 7,100 tokens even when the agent needs 3 rows, and since the table has no row ids, the agent
cannot address a row it wants to change. Writing a cell meant the raw REST body
(`PATCH /pages/:id/props`), which is keyed by field id, stores scalar values without a type check,
and has no concurrency check. Two agents, or an agent and a person, could overwrite each other's
cells on a stale read.

Constraints: data access goes through the REST routes so permissions equal the web app's (ADR
0811). Read tools must be GET because read-only tokens may only use GET (ADR 0935). Relation
values live in row props and rollups are computed per request (ADR 0300 / 0301). Row props
writes are already merged in SQL under a row lock (ADR 0809). No schema change.

## Decision

**Three MCP tools** (`apps/server/src/mcpTools/collectionTools.ts`):

| Tool | Params | Notes |
|---|---|---|
| `query_rows` | `collectionId, filter?, sort?, fields?, limit? (25, max 200), cursor?, describe?` | read-only; header `Collection "…" (id)` and, on the first page, a `Fields:` line (types, up to 10 option names, relation targets), then one line per row `rowId \| version \| Title \| …`, then `N row(s)` and `next cursor: …` or `(end of results)`. `describe=true` returns the schema plus operators per type. |
| `update_row` | `rowId, properties {name: value}, baseVersion` | write; version-checked; on conflict nothing is written and the error carries the current values and version |
| `create_row` | `collectionId, title?, properties?` | write; returns the new row id, version and values |

**Filter language** (`collectionQuery/filter.ts`, pure). Property names, case-insensitive. A
multi-word name needs no quotes because the parser resolves the field words against the known
schema. `"…"` / `` `…` `` quote names or values, and `#fieldId` handles duplicate names or a user
field named `Title` (the reserved `Title` is always the row title).

```
expr   := or ;  or := and (OR and)* ;  and := unary (AND unary)* ;  unary := NOT unary | ( or ) | cond
cond   := field op value | field is [not] empty | field [not] empty
op     := = != < <= > >= ~ !~ has !has | is | is not | contains | not contains
```

| Type | Operators | Value |
|---|---|---|
| Title, text, url | `= != ~ !~` (case-insensitive), empty | text |
| number | `= != < <= > >=`, empty | number |
| date | `= != < <= > >=`, empty | `YYYY-MM-DD`, `today`, `today+N`, `today-N` (UTC) |
| checkbox | `= !=` | true/false (yes/no); a missing value is false |
| select | `= !=`, empty | option name (case-insensitive) or id |
| multiSelect | `has !has` (`=`/`!=` are aliases), empty | option name |
| person | `= !=`, empty | `me`, member name, email or user id |
| relation | `has !has` (aliases `=`/`!=`), empty | linked row title or row id |
| rollup | none (computed, read-only) | |

`!=` matches empty values (Notion semantics), and `<`/`>` never match empty values. An unknown
field, operator, option or a bad value is an error that lists the valid fields, operators or
options. Limits: 2,000 characters, 30 conditions, 3 sort keys.

**SQL compilation** (`collectionQuery/compile.ts`). Filter and sort compile to one parameterized
statement over `pages WHERE parent_id = $collection AND deleted_at IS NULL AND visibleTo(user)`,
run with `SET LOCAL statement_timeout = 3000` and `jit = off` like the Dataview route. Field ids,
option ids and values are bind parameters. Numbers and dates use guarded CASE expressions, so a
malformed stored value yields NULL instead of failing the statement. Relation conditions count
only links to live rows of the target collection that the viewer can see. The sub-query opens its
own `FROM pages`, so the shared `visibleTo()` applies to the linked rows. "Project is empty" is
therefore true for a row whose only link is someone else's private row, matching what the cell
shows (ADR 0300: hidden links are never revealed). Person names match workspace members only
(`isWorkspaceMember`, C-L11).

**Sort and keyset pagination.** For each sort key the ORDER BY is `(expr IS NULL), coalesce(expr,
·) <dir>` (empty values last in both directions). After that comes the manual order `sort_order`,
`created_at` and `id` as the unique tie-break. The cursor is opaque: base64url JSON holding the key
values of the last row plus a hash of collection, filter and sort. A cursor from a different query
is refused, and every key value is validated against its cast before it reaches SQL. The next page
is `(k1 > c1) OR (k1 = c1 AND k2 > c2) …` (mixed directions), fetching `limit + 1` rows to detect
more. No COUNT(*).

**Row version.** `substr(md5(coalesce(props,'{}')::text), 1, 12)`, one SQL expression
(`rowVersionSql`) used by the read routes and inside the PATCH transaction (jsonb text output is
canonical, so the two can never disagree). It covers props only. The title is not part of it, and
`update_row` does not rename (use `rename_page`). `updated_at` was rejected because body edits bump
it (false conflicts), while two-way relation sync changes paired rows' props without touching it.
A props hash changes exactly when the values change, so a paired row's version legitimately moves
when a link to it is added.

**REST** (registered from `registerCollectionExtRoutes`, so the app and the test harness get them
without new wiring):

- `GET /api/pages/:id/collection/query?filter&sort&fields&limit&cursor&describe=1` returns
  `{collection, workspaceId, fields: FieldSummary[], definitions? (describe only), columns,
  rows: [{id, version, cells: string[]}], nextCursor}`.
- `GET /api/pages/:id/row` returns one row with its collection's full field definitions, display
  cells and version. A page that is not a collection row returns 400 `NOT_A_ROW`.
- `PATCH /api/pages/:id/props` accepts an optional `baseVersion`, checked after `SELECT … FOR
  UPDATE` inside the existing transaction. A mismatch returns 409 `ROW_VERSION_CONFLICT` with
  `currentVersion` and writes nothing. The response gains `version` only when `baseVersion` was
  sent, so the web app's response is unchanged. The write is wrapped in
  `withEditActor([id], actorOf(user))`.

**Writes.** `update_row` / `create_row` map names to field ids and validate strictly in
`collectionQuery/values.ts`: option names to ids, `me`/name/email to a member id, dates, numbers
and booleans. Every invalid key is reported together with the valid choices, and nothing is sent.
As a defensive check the result must survive the batch route's own `sanitizeBatchProps`
unchanged. `update_row` first compares `baseVersion` with `GET /row` and returns the conflict
without a write. The authoritative check is the one under the row lock, so a race between the
pre-check and the PATCH still conflicts. Two parallel calls with one base version produce exactly
one winner (tested with 6). `create_row` uses the batch insert route (row cap, tree lock) and then
PATCHes relation links.

**Deterministic output (prompt-cache friendly).** The same input over the same data gives
byte-identical text. The stable part (collection header, field schema in collection field order)
comes first, then rows in SQL order, which always ends with the unique row id. The data-dependent
footer (`N row(s)`, cursor) comes last. Multi-value cells follow the stored array order, and
numbers are rounded to 12 significant digits (rollups to 1e-6 by `computeRollup`). No clock,
request id or Map/Set iteration order reaches the output, and tool descriptions are constant
strings. The cursor encodes only key values and a hash of the query. Editing a row outside the
result set leaves the output unchanged (tested). The only time input is `today` in a filter, which
the agent chose to write. Reads are GET routes, so read-only tokens pass the scope check without
`bearerReadOnlyOk`; the write tools use `wrapWrite`.

**Relations and rollups scope.** Relation cells are shown as linked row titles, visible links
only, at most 10 then `(+N more)`. They are settable as a full replacement list of row ids or exact
titles. Titles are resolved through the relation picker route (`row-options`, visible rows only).
An ambiguous title is an error listing the row ids. Ids the server drops (not visible or not in
the target) are reported back. Hidden existing links are preserved by `normalizeRelationWrite`.
Rollups are shown (computed by `resolveRelations` for the returned page only) but are read-only
and not filterable or sortable. They are computed in JS per request (ADR 0301), so filtering would
mean loading every row.

## Alternatives considered

- **Reuse the Dataview compiler** (`query/compile.ts`). It targets a workspace-wide page set, and
  each row looks up collection field names by joining `collections.fields` (query/compile.ts:386).
  It has no keyset pagination, and its language (`WHERE`/`SORT` with `file.*` fields) is longer for
  an agent. A single-collection compiler knows the schema up front. It resolves names once,
  rejects wrong operators before SQL and binds option ids directly. It does reuse
  `visibleTo`, `isWorkspaceMember`, `escapeLike`, the guarded casts and the timeout pattern.
- **Filter in JS after loading the collection** (like `GET /collection`). That is simple, but it
  loads up to 100k rows (about 4 MB) per call, and paging would not be stable.
- **Offset pagination.** Rows inserted or removed between pages shift the window and cause
  duplicates or gaps. Keyset does not, and the test inserts rows between pages to prove it.
- **JSON filter objects (Notion style).** They are unambiguous, but an agent writes several times
  the tokens, and the error messages are the same either way. A compact string with schema-aware
  errors was preferred. The structure is internal (`Expr`), so a JSON form can be added later.
- **`updated_at` or a version counter column as the row version.** `updated_at` gives false
  conflicts on body edits and misses pair-sync writes. A counter needs a migration and must be
  maintained by every props writer (batch, sheet sync, pair sync).
- **Name mapping on the server** (a new write route). It would duplicate the PATCH logic (lock,
  relation diff, pair sync). Instead the tool maps names, and the existing route only gained an
  optional field.

## Trade-offs

- Filters scan the collection's live rows (`pages_parent_idx`, then a jsonb predicate per row). A
  custom sort orders the filtered set on every page. That is fine up to the 100k-row cap within
  the 3 s timeout, and a timeout becomes 400 `QUERY_TIMEOUT` telling the agent to narrow the
  filter. Expression indexes per field were not added (no schema changes, and fields are
  user-defined).
- Each row line carries `id | version` (about 13 tokens), which read_page has no equivalent of.
  For a full dump of every column of 200 rows, query_rows costs more than read_page (9,679 vs
  7,083). It is cheaper as soon as the agent filters, pages or picks columns (below), and it is
  the only path that lets the agent then write.
- `today` is the server's UTC date. Agents in far-off time zones should pass explicit dates.
- Relation refs given as a comma string are split on commas. Titles containing commas must be
  passed as an array.
- `create_row` with relations is two writes (insert, then link). If the link step fails, the row
  exists without links, and the error says so.
- The version is a 48-bit hash of the props. An ABA collision (different values, same hash)
  between a read and a write is about 2⁻⁴⁸.

## How others solve it

- **Notion API**: `POST /databases/{id}/query` with a JSON `filter` (`{property, select: {equals}}`,
  `and`/`or` compound), `sorts`, `start_cursor`/`page_size` (max 100) and an opaque `next_cursor`.
  Property values are typed objects. There is no optimistic concurrency on page property updates
  (last write wins). We follow the cursor model and the per-type operator sets, but use a compact
  string and add a version check.
- **Airtable**: `filterByFormula` (a spreadsheet formula string, e.g. `AND({Status}='Done', …)`),
  `sort[]`, `fields[]`, `pageSize`/`offset` (an opaque token). Updates are field-name keyed with
  `typecast` for option names, and there is no concurrency check. Our name-keyed writes and
  name-based select values match this.
- **Coda / Baserow / NocoDB**: column-name query params (`where=(Status,eq,Done)`), offset or
  token paging. NocoDB's `where` grammar is the closest to ours.

## Consequences

- Measured on a 200-row, 7-field collection (estimateTokens; `collectionQuery.db.test.ts`):
  read_page 7,083 tokens. query_rows first page (25 rows, default columns) 838 (12%). 200 rows
  with default columns 5,976 (84%). 200 rows with all columns 9,679 (137%). A 3-condition filter
  (17 rows, 2 columns) 519 (7%), with 17 of 17 expected rows returned.
- Correctness: 43 filter cases across every type and operator are compared with an in-memory
  oracle, 702 matching rows with no mismatches. Sorts are checked for 4 orders. Pages are identical
  at page sizes 1, 3, 7, 13 and 200. Rows inserted between pages cause no duplicates or gaps.
- Same call twice gives byte-identical text, and an edit to a row outside the result set leaves it
  identical (deterministic-output test).
- Non-members get 403 and other users' private collections get 404. Read-only tokens can query
  but `update_row`/`create_row` refuse. A stale `baseVersion` writes nothing, and the other
  writer's value is kept.
- The web app is unaffected: the PATCH response and validation are unchanged unless `baseVersion`
  is sent.

## References

- `apps/server/src/collectionQuery/filter.ts:69` operators per type, `:116` name resolution, `:285` parser, `:475` sort
- `apps/server/src/collectionQuery/compile.ts:35` rowVersionSql, `:62` visible relation targets, `:79` conditions, `:217` order keys, `:248` keyset predicate, `:284` cursor validation
- `apps/server/src/collectionQuery/values.ts:46` cell display, `:164` name → id write mapping
- `apps/server/src/routes/collectionQuery.ts:115` set-wise formatting (resolveRelations + one member query), `:200` query route, `:278` row route
- `apps/server/src/routes/collections.ts:47` baseVersion, `:336` withEditActor + lock, `:344` 409, `:390` response
- `apps/server/src/routes/collectionsExt.ts:103` route registration
- `apps/server/src/mcpTools/collectionTools.ts:73` relation refs, `:102` sanitizer cross-check, `:127` query_rows, `:189` update_row, `:241` create_row
- `apps/server/src/collectionRelations.ts:100` resolveRelations, `:274` normalizeRelationWrite, `:513` isWorkspaceMember
- `apps/server/src/query/compile.ts:386` Dataview per-row field-name lookup (not reused)
- ADR 0203, 0300, 0301, 0809, 0811, 0935
