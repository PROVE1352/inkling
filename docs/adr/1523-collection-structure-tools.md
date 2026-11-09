# 1523. Agents create collections and change their properties by name

- Status: Accepted
- Date: 2026-11-09

## Context
Agents could add and update rows (0934) but not make a collection or change its properties: a
"set up a project tracker" request ended with a page asking the person to click. The web app does
it with `POST /pages` (kind `collection`: default Status/Assignee/Due fields and a table view) and
`PUT /pages/:id/collection/fields` (the whole list; relation targets, the hidden-target rule of
1353, rollups, two-way pairing and the edit lock are checked there). The shared field schema
(`collectionFieldSchema`) needs ids for fields and options, which an agent should not invent.

## Decision
- `create_collection(workspaceId, title, fields[], parentId?, private?)`: field specs by name —
  `{name, type, options?, target?, twoWay?, relation?, property?, fn?}` with the shared enums
  (`fieldTypeSchema`, option colors, `rollupFnSchema`). The tool generates ids, maps rollups to the
  relation and target property by name, checks relation targets with `GET /collection?rows=0` (same
  answer for hidden and missing), validates the list with `updateFieldsSchema`, and only then
  writes: `POST /pages` then `PUT …/collection/fields`. If the PUT is still refused (a race, a lock
  on the target of a two-way relation), the new page is moved to the trash and the error says so.
  Empty `fields` keeps the default properties.
- `update_fields(collectionId, add?, change?, remove?, order?)`: the current list from
  `GET /collection?rows=0`, the operations applied in memory (rename; switching between simple types;
  set/add/remove select options, existing option names keep their ids and colors so stored values
  survive; two-way on/off; remove refuses while a rollup still uses the relation; order puts names
  first), one PUT. Any error writes nothing.
- The route decides: the PUT's validation, ADR 1353's hidden-target rule, two-way pairing and its
  `assertAllEditable` on the other collection stay the only checks that matter.
- `PUT /pages/:id/collection/fields` gets the write gate (1071) like `PATCH /props`: the edit lock is
  checked with the role and access version read by `requireMembershipAcl`, and the transaction takes
  `gateWrite` before its row locks and re-checks agent blocks and the lock when the version or role
  changed in between.
- Views are not created or changed by agents in this step (the default table view comes with every
  collection).

## Alternatives considered
- **Create with fields in one route** (`POST /pages` taking `fields`): atomic, but changes a route the
  web client and API users depend on, and duplicates the PUT's validation path; the pre-check plus
  trash on refusal leaves nothing half-made in the tree in practice.
- **Pass raw `CollectionField[]`**: agents would invent ids and option ids and could break pairing
  ids; name-based specs keep the ids server-made.
- **A version check on PUT fields**: the web app does not send one either; two schema edits within
  the same second still replace each other (unchanged, noted in KNOWN-ISSUES).

## Consequences
- Proposed next step, out of scope here: `create_view(collectionId, name, type, filters/sorts by
  property name)` over `POST /collection/views` and `PATCH /collection-views/:id`.
- Tests: `apps/server/src/mcpTools/structureTools.db.test.ts` (specs with select, relation two-way and
  rollup; hidden target, bad rollup and duplicate names write nothing; read-only token; update
  operations keep option ids; rollup dependency; locked collection and locked parent).

## References
- apps/server/src/mcpTools/structureTools.ts, apps/server/src/routes/collections.ts
- docs/adr/0934-*, 1353-*, 1071-*, 0970-*
