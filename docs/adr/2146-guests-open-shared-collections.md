# 2146. Page guests open the collections shared with them

- Status: Accepted
- Date: 2026-11-10

## Context
Since 0.9 a guest invited to a page tree (ADR 1250–1253) reads and edits documents there by their level,
but collection pages answered 403: the collection routes called `requireMembership` without
`{ guests: true }` (KNOWN-ISSUES). Rows link to other collections (relations, rollups) and hold member ids
(person, created / edited by), and the web resolves names through the member list, which guests cannot
read.

## Decision
- **Opened to guests** (browser sessions only; tokens never carry a guest scope, so MCP is unchanged and
  guests still get no semantic candidates, ADR 1743): `GET /pages/:id/collection`, `GET …/row-options`,
  `GET …/covers`, `GET …/row-templates`, `POST …/collection/rows` and `PATCH /pages/:id/props`. What a
  guest reaches is decided as for documents: `findVisiblePage` / `visibleTo` are narrowed to their trees
  (anything else is 404), and writes go through `assertPageEditable` / `assertPlacement` with the grant
  level (view: read; comment: read and comment on row pages; edit: cells and new rows).
- **Still member-only**: the schema (`PUT …/fields`), views, batch insert/update (import, paste), sheet
  sync, the agent read routes (`…/collection/query`, `/pages/:id/row`) and the chart aggregate.
- **No leaks**: relation cells and `refs` hold only rows the guest can see; rollups aggregate only those
  (a link to a hidden row counts for nothing); the agent key next to a person cell is removed. Person,
  created-by and last-edited-by names come with the response as `people: { userId: name }` for the ids in
  the returned rows, members only, names only (no email, no other member). In the field definitions a relation
  whose target collection the guest cannot open names the nil uuid instead (no pair field), and the agent
  keys are removed from every row a guest gets back (GET, PATCH props, row create).
- The web hides properties, view settings, import, sheet sync, the sub-items switch, paste and row
  template management from guests.
- **Guests do not assign people**: a person value from a guest is 403 `GUEST_PERSON` (they cannot see the
  member list, and accepting ids would make the 400 for non-members an oracle for member ids).
- The web loads collections for guests (`useCollection` no longer waits for membership), merges `people`
  into the names it shows, and hides person pickers.

## Alternatives considered
- **Hide person values from guests**: the shared page shows who owns a task; comments already show
  authors' names to guests.
- **Open the member list to guests**: it would show every member, not the ones on the shared rows.
- **Open the schema to edit guests**: a schema change reaches rows the guest cannot see (relations,
  rollups, formulas over other rows); left for later.

## References
- apps/server/src/routes/collections.ts, collectionsExt.ts, rowTemplates.ts, collectionQuery/guestView.ts
- apps/server/src/guests.db.test.ts, collectionQuery/rows017.db.test.ts
- ADR 1250–1253 (guests), 0300 (relation visibility), 1743
