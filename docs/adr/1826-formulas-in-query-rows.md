# 1826. Formulas in query_rows filters and sorts: decided in memory, handed to SQL

- Status: Accepted
- Date: 2026-11-10

## Context
query_rows compiles filters and sorts to SQL with keyset pagination (ADR 0934). Formula values are
not in the database.

## Decision
- A formula condition or sort key uses the operators and order of what the formula yields
  (`formulaResultType`: number, text, checkbox, date).
- Only when a query names a formula, the viewer's visible live rows are read once (id, title, props),
  rollups computed when a formula reads one, and formulas evaluated. Each formula condition becomes
  the set of row ids it keeps (`jsonb_exists(ids, pages.id::text)`), each formula sort key a dense rank
  per row (`(ranks ->> pages.id::text)::int`, empty = absent = last). The rest of the query, the
  keyset and the cursor format are unchanged, so queries without formulas cost nothing more.
- Comparisons follow the SQL compiler for the same kind (text case-insensitive, dates by their
  `YYYY-MM-DD` prefix).
- The web's view filters and sorts read the computed values the rows already hold.

## Alternatives considered
- Compile formulas to SQL: a second implementation of the language that must agree with the first,
  and formulas over rollups could not be compiled.
- Evaluate the whole filter in memory: a second implementation of every operator of every type.

## Consequences
- A formula filter or sort reads every visible row of the collection once per call (bounded by the
  row cap). Measured (median of 7, in-process, local Postgres 16): filter + sort + limit 25 on a
  formula 16.2 ms at 2,000 rows and 96.1 ms at 20,000 rows, against 7.6 / 35.2 ms for the same query
  on a stored number. 100k rows were not measured. A cursor page repeats the rank map once per key
  part (≈165 ms at 20,000 rows); parsing it once through an InitPlan was measured and changed nothing.
- Cursors over a formula sort are positions in that order: they stay valid while the values do not
  change, like any keyset cursor.
- Tests: `collectionQuery/formula.db.test.ts`.
