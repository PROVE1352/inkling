# 1524. create_row writes relation links in the row's transaction

- Status: Accepted
- Date: 2026-11-09

## Context
AGENT-C2: `POST /pages/:id/collection/rows` dropped relation values (`sanitizeBatchProps` leaves
relations to `PATCH /props`, which validates targets and mirrors two-way links), so `create_row`
made the row first and set its links with a second request. When the second request failed (a
locked target row of a two-way relation, a race) the row stayed, without links.

## Decision
- `createRow` (`rowTemplates.ts`) takes relation values from `props` and writes them inside its
  existing tree-lock transaction, with `PATCH /props`'s rules: `normalizeRelationWrite` keeps only
  live, visible rows of the target collection; target rows of two-way relations must be editable for
  the actor (`assertAllEditable`, edit lock 0970) or the whole create is refused; the mirror is
  written with `syncPairedLinks` after the insert. No row, no links, or both.
- `create_row` sends the resolved link ids in the single POST and reports links the server dropped
  (not a visible row of the target), as before.
- The route's input shape is unchanged (`createRowSchema.props` already accepted any value); web
  and REST clients that send relation values on create now get them stored instead of dropped.

## Alternatives considered
- **Compensate** (trash the row when the link write fails): leaves a trash entry and a window where
  the half-made row is visible to others and to webhooks.
- **A transaction across the two requests**: requests through `app.inject` do not share a
  transaction.

## Consequences
- AGENT-C2 is closed. Tests: `apps/server/src/mcpTools/structureTools.db.test.ts` (two-way link and
  mirror in one call; a locked target row leaves no row).

## References
- apps/server/src/rowTemplates.ts (`createRow`), apps/server/src/mcpTools/collectionTools.ts
