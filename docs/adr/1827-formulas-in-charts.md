# 1827. Formulas in charts and view filters: by what they yield

- Status: Accepted
- Date: 2026-11-10

## Context
The chart aggregate (ADR 1602) groups and measures properties by type; a formula's type is what it
yields.

## Decision
- A formula groups like a property of its result type and can be summed or averaged when it yields a
  number (`chartCanGroup`, `chartCanMeasure`; the server maps it with `asResultField`).
- When a chart or its view's filters use a formula, the aggregate reads whole rows (a formula may read
  any property) and computes formulas after rollups, for members; on public pages formulas are
  computed from stored properties only (rollups are not computed there).
- `matchesFilter` compares a numeric formula as a number.

## Alternatives considered
- Refuse formulas in charts: the totals people want to chart are often formulas.

## Consequences
- The 60-second chart cache keeps a `now()`-based formula's groups for up to a minute.
- Tests: `collectionQuery/formula.db.test.ts`.
