# 0203. Query blocks: hand-written parser, parameterized SQL, no new indexes

- Status: Accepted
- Date: 2026-11-07

## Context
Query blocks (docs/QUERY.md) run user-written Dataview-style queries against a workspace with
thousands of pages. The query text is untrusted input reaching Postgres, so the parser must not
be a ReDoS vector, SQL must never be built by string concatenation, the result must respect page
visibility (shared vs private sections), and a pathological query must not hold a connection.

## Decision
- **Parser** (`packages/shared/src/query.ts`, shared by browser and server): character-by-character
  tokenizer (regexes are only ever applied to a single character) + recursive descent. Caps:
  2 000 chars, 400 tokens, nesting depth 24, 20 columns, 5 sort keys, LIMIT ≤ 500. Errors carry
  a 0-based offset → line/column; unknown `file.*` fields are rejected at parse time.
- **Compiler** (`apps/server/src/query/compile.ts`): AST → ONE statement through drizzle's `sql`
  template. Every literal, tag, folder path, property name and date is a bind parameter; the only
  raw SQL fragments are constants from the compiler (column aliases `p0…p23`, operators from a
  fixed set). The row filter always includes `workspace_id`, `deleted_at IS NULL`,
  `is_template = '0'` and the shared `visibleTo(userId)` predicate — also inside the recursive
  folder-path CTE, so `file.folder` never reveals a private parent's title.
- **Value model**: every field is `jsonb`; page properties are matched by name (case-insensitive)
  or id, then collection fields of the parent collection (select ids → option names). Date
  comparisons use the `YYYY-MM-DD` text prefix (never a cast that could abort the statement on a
  malformed value); `file.ctime/mtime` compare against local midnight using the viewer's UTC
  offset. Each referenced property is computed once per row in a `LEFT JOIN LATERAL (… OFFSET 0)`
  (without the fence the planner inlined the subqueries into WHERE, ORDER BY and SELECT and
  evaluated them up to three times).
- **Execution** (`routes/query.ts`): membership check, then a transaction with
  `SET LOCAL statement_timeout = 3000` and `SET LOCAL jit = off`, `LIMIT n+1` to report truncation.
  57014 (timeout) → 400 `QUERY_TIMEOUT`. A per-process LRU (200 entries, 60 s) keyed by
  user + workspace + query + viewer date is valid only while the workspace version
  (`max(updated_at|deleted_at)`, live count, collection field changes) is unchanged.
- **Indexes: none added.** Measured on 5 000 docs + 50 folders + a 500-row collection
  (Postgres 16, laptop), median SQL time of 7 runs:

  | Query | rows | before tuning | final |
  |---|---|---|---|
  | `TABLE status, due FROM #tag3 WHERE status = "blocked" SORT due DESC LIMIT 50` | 50 | 19.6 ms | 12.0 ms |
  | `LIST FROM "Folder 7"` | 100 | 10.6 ms | 4.6 ms |
  | `TABLE file.mtime SORT file.mtime DESC LIMIT 20` | 20 | 7.2 ms | 3.3 ms |
  | `TASK WHERE !completed AND due < date(today) LIMIT 100` | 100 | 3.4 ms | 1.7 ms |
  | `TABLE priority, file.tags WHERE priority >= 4 AND contains(file.tags, "#ptag5") …` | 100 | 72.6 ms | 29.1 ms |
  | `TABLE State, Deadline, Points FROM "Board" WHERE State = "In progress" …` (collection) | 50 | 13.8 ms | 7.8 ms |
  | `LIST due WHERE due >= date("2026-11-01") AND due <= date("2026-11-30") LIMIT 500` | 500 | 64.7 ms | 15.8 ms |
  | `TABLE status, priority, due, file.folder LIMIT 500` (no filter) | 500 | 90.5 ms | 29.2 ms |

  "Final" = lateral fence + `jit = off` (EXPLAIN showed the jsonb function scans push the
  estimate past `jit_above_cost`, and JIT compilation alone cost ~15–20 ms per query). The plans
  use `pages_workspace_deleted_idx`, the `page_tags` primary key `(page_id, tag)` for `#tag`,
  `pages_parent_idx` for the folder CTE and `page_tasks_ws_due_idx` for TASK. An expression index
  `page_tags (lower(tag))` changed nothing at this size (12.0 → 12.1 ms) and a GIN index on
  `pages.properties` cannot serve case-insensitive name lookups, so neither is added. If a
  workspace grows past ~50k pages, the first candidate is
  `CREATE INDEX page_tags_lower_tag_idx ON page_tags (lower(tag));` (semi-join for `FROM #tag`).

## Alternatives considered
- Regex/PEG-generated parser — generated parsers are fine, but a new dependency was not allowed and
  the grammar is small; regex-based tokenizing is where ReDoS usually comes from.
- Compile to an in-memory filter over all pages (Dataview's approach) — needs every page's
  properties in the Node process per query; Postgres already has them indexed by workspace.
- Materialized "page fields" table (one row per property) with btree indexes — fast lookups but a
  second write path for every property/collection change; not needed at the measured latencies.
- `jsonb_path_query` with user paths — would put user text into a jsonpath expression.

## Trade-offs
- Property names are resolved per row (case-insensitive), so equality filters on properties can't
  use an index; acceptable at < 30 ms for 5 000 pages.
- `TASK` only sees dated checklist items (the existing `page_tasks` index).

## How others solve it
- Obsidian Dataview: in-memory index of the vault's metadata cache, queries evaluated in JS.
- Notion database filters: server-side query planner over typed property tables.
- Logseq: Datascript (Datalog) in memory.

## Consequences
- Adding a field type means extending `fieldSql`/`compare` in compile.ts, not the parser.

## References
- packages/shared/src/query.ts (`tokenize`, `Parser`, `QUERY_LIMITS`)
- apps/server/src/query/compile.ts (`compileQuery`, lateral fence, visibility in CTE)
- apps/server/src/routes/query.ts (timeout, `jit = off`, cache, `workspaceVersion`)
- apps/server/src/pageDto.ts:92 (`visibleTo`)
- apps/server/drizzle/0009_perf_indexes.sql (indexes the plans use)
