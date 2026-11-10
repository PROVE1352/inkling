# 1825. Same formula results on the server and the web; errors in the cell

- Status: Accepted
- Date: 2026-11-10

## Context
Rows come from the server with computed values, but the web edits cells optimistically: a formula
that waited for the server would show a stale value after each edit.

## Decision
- One engine in `packages/shared`. The server computes formulas in `resolveRelations` (after rollups)
  for every read: GET /collection, PATCH props response, query_rows, /pages/:id/row, chart
  aggregates, exports. The web recomputes them in `CollectionView` (`lib/formulas.ts withFormulas`)
  from the rows it holds, after every cache change.
- One `now` per request (server) or per recompute (web): every row of a response sees the same instant.
- Errors are short codes (`syntax`, `unknownProp`, `ambiguousProp`, `unknownFunction`, `args`,
  `cycle`, `type`, `divZero`, `tooLong`, `tooComplex`, `badDate`, `badUnit`). The server sends null in
  props (and `#error(code)` in agent cells); the web keeps `{ formulaError }` in props for the cell,
  which shows a short localized label. Filters, sorts and exports read an error as empty.
- Cycles are found when saving (refused) and again when evaluating (every member of the cycle errors).

## Alternatives considered
- Compute only on the server: every edit would show the old value until the next fetch.
- Errors as values in the server's props: every reader (CSV, sheets, exports) would have to know them.

## Consequences
- `now()` can differ by the time between the server's answer and the web's recompute.
- Tests: `apps/web/src/lib/forms.test.ts` (formula cells), `formula.test.ts`.
