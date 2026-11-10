# 1823. Formula fields: computed from the same row, never stored

- Status: Accepted
- Date: 2026-11-10

## Context
People want computed columns (total = price × quantity, days left, a label from a condition).
Rollups (ADR 0301) compute from linked rows on the server; a formula computes from its own row.

## Decision
- `fieldTypeSchema` gains `formula` with `formula: { expression }` (up to 2,000 characters), the
  expression as typed: `prop("Name")` reads a property (`Title` reads the row title when no property
  has that name).
- Values are computed on every read and never stored: a write to a formula's id is ignored
  (PATCH props, batch, row templates, sheet sync, import) or refused with a message (update_row).
- Saving fields checks a formula that is new or whose text changed (parse, names, cycles) and answers
  400 with the reason. A formula broken by another change (a property it reads was deleted) is kept
  and shows an error in its cells, so it never blocks an unrelated schema edit.
- Renames: a formula whose text the editor did not touch follows renamed properties
  (`renameFormulaProps`, by field id); the rest of the text is kept as written.
- A formula reads other formulas (evaluated in dependency order) and rollups (computed first). It does
  not read person or relation cells (ids whose names differ between viewers). A rollup does not
  aggregate another collection's formula (only count), which keeps rollups at depth 1.

## Alternatives considered
- Store computed values in props and recompute on write: every write to any property, rollup source
  or the clock (`now()`) would have to rewrite rows.
- Expressions stored with field ids: renames would be free, but the stored text is not what people
  typed, and agents read and write names.

## Consequences
- Exports compute formulas from stored properties (a formula over a rollup is empty in an export).
- Tests: `formula.test.ts`, `collectionQuery/formula.db.test.ts`.
