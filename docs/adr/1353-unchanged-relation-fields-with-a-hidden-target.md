# 1353. Unchanged relation fields pass when their target is hidden from the editor

- Status: Accepted
- Date: 2026-11-09

## Context
`PUT /pages/:id/collection/fields` replaces the whole field list. Validation (`applyFieldsUpdate` in
`collectionRelations.ts`) looked up the target of every relation field with `visibleTo(editor)` and
answered 400 "Relation target collection not found" when one was missing. When a member added a
relation from a shared collection to their own private collection, every other member's schema edit
of the shared collection failed from then on, also when it only added a date field: the list they
send back contains that member's relation, whose target they cannot see. The same held for a rollup
over that relation (its target property cannot be checked without the target's fields).

## Decision
- A relation field needs a target the editor can see only when it is new (its id is not in the stored
  list), re-targeted, switched to two-way, or two-way with a different pair id (pairing writes a field
  into the target). A relation stored as it was passes even when its target is hidden; renaming it is
  not a change of target.
- A rollup over a relation whose target is hidden passes only when it is stored as it was (same
  relation, target property and function); a new or changed one gets the same 400 as a hidden target.
- Hidden and missing targets get the same answer (status, code and message), so the endpoint does not
  tell whether an id belongs to someone's private collection. The check for a new field still runs
  against `visibleTo`, as before.

## Alternatives considered
- Skip the check for every target the editor cannot see. Lets a member point a new relation at an id
  they guessed and learn from a later read whether rows link there; also lets them create a two-way
  pair inside another member's private collection.
- Merge on the server: keep the stored definition for fields the request leaves out, so clients never
  send fields they cannot see. Changes the replace semantics of the route that `docs/API.md`, the web
  client and the MCP tools rely on.
- Look up the target without `visibleTo` for unchanged fields. Gives the same result for this route but
  reads another member's private page for nothing; the unchanged comparison needs no lookup at all.

## Consequences
- Members can edit a shared collection's schema while it holds another member's relation to a private
  collection; that relation and its rollups are kept as they are.
- Removing such a field works as for a visible target: a two-way partner in the hidden collection is
  turned into a one-way relation (its links are kept). That write goes through the edit-lock check
  (`assertAllEditable`) like any pairing edit, so a lock on the hidden collection refuses the removal
  with whatever that check answers (not tested here). That can tell the editor that the collection
  named by the field, whose id they already hold, is locked; it says nothing about ids they do not
  hold, so it is left as is.
- Unchanged validation for everything else: re-targeting into a hidden collection, a new two-way
  relation to it, or a changed rollup over it are refused with the "not found" answer.

Tests: `apps/server/src/relationTargetHidden.db.test.ts` (unchanged list plus a new field, a renamed
field, an unchanged rollup over the hidden relation, a new relation to a hidden and to a missing target
with equal bodies, re-targeting, switching to two-way, a two-way relation kept, re-paired and removed,
a changed and a new rollup refused, removal of the one-way field).
