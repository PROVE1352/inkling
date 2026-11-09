# 1651. Many rows added to one collection are one line

- Status: Accepted
- Date: 2026-11-10

## Context
With rows in the feed (ADR 1650), an import or a paste of 500 rows would be 500 `row added:` lines:
the budget fills, the answer is cut, and the agent pages through hundreds of lines that say less than
one `query_rows` call.

## Decision
- In one `changes_since` answer, when **10 or more** rows of the same collection are added
  (`ROW_GROUP_MIN`), they become one unit: `rows added: N to collection "Title" <id> (by …): query_rows(<id>)
  lists them`. Fewer are listed one per line (a handful of new tasks is worth naming).
- The unit takes the place of the first row and its `firstSeq` is the smallest seq of its rows. The
  packer is unchanged: a cut before the unit puts the next cursor before all its rows (they come back,
  grouped again); a listed unit covers them all. A row's later edits in the same window are part of its
  `page_added` (as before for pages).
- `catch_up` applies the same rule per collection (one item, "query_rows(<id>) lists them"), ranked in
  "others" when any of the rows is.
- Grouping is per answer, not per log row: the log keeps one `page_added` per row, so activity, revert
  facts and provenance are unchanged.

## Alternatives considered
- Always group (even one row): loses the row id and title an agent wants for a single new task.
- A threshold on the token budget instead of a count: the same window would read differently at
  different budgets, against ADR 0937.
- Grouping in the log (one row for the batch): the activity screen and catch_up's per-page counts would
  lose the rows.

## Consequences
- Ten rows added one by one over a day still read as one line when they fall in one window; the ids are
  one `query_rows` away.
