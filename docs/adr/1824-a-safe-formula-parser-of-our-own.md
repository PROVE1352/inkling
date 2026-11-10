# 1824. A small formula language with our own parser and evaluator

- Status: Accepted
- Date: 2026-11-10

## Context
The expression comes from any member (and agents). It runs on the server for every row of a
collection. It must not run code, and its cost must be bounded. No new dependency (ADR 0882).

## Decision
- `packages/shared/src/formula.ts`: a tokenizer, a recursive-descent parser into a small AST and a
  tree-walking evaluator. No `eval`, no `new Function`, no property access on JavaScript objects:
  function names come from a fixed table, `prop()` takes a string literal (dependencies are known
  before evaluation).
- Language: numbers, strings ("…", '…', “…”), true/false; `+ - * / %`, comparisons
  (`= == != <> < <= > >=`), `and or not` (also `&& || !`), parentheses; functions `if`, `and`, `or`,
  `not`, `concat`, `length`, `round`, `min`, `max`, `abs`, `now`, `dateAdd`, `dateBetween`, `prop`.
  Values: number, text, boolean, date, empty. `+` with text concatenates; empty is 0 in `+`/`-` and
  empty in `*`/`/`; division by zero is an error, never Infinity.
- Dates: `YYYY-MM-DD` or with a time; all date arithmetic in UTC; `dateAdd` with months/years clamps
  to the month's last day; `dateBetween(a, b, unit)` is a − b truncated toward zero. Output is
  `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mmZ` with a time.
- Caps: 2,000 characters, 300 AST nodes, nesting depth 40, 50 arguments per call, 10,000 characters
  for any text built, `dateAdd` amount within ±10⁷. The evaluator never loops: its work per row is
  bounded by the node counts of the collection's formulas.

## Alternatives considered
- A JavaScript sandbox (vm, workers): still code execution, a larger attack surface, per-row cost.
- An expression library: a dependency for a few hundred lines, and its grammar would be the contract.

## Consequences
- Person names and relation titles are not readable in formulas (KNOWN-ISSUES).
- Tests: `formula.test.ts` (precedence, every function, caps, cycles, renames).
