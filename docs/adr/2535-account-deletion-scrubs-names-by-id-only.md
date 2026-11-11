# 2535. Account deletion scrubs names by id only

- Status: Accepted
- Date: 2026-11-12

## Context
Leaving and the account lifetime remove the person's name from rows that copied it as text (ADR 2517).
The first version matched the display name as a string: in every workspace the person had been in, audit
`target_label` values, JSON values under name-like keys and workspaces named "<name>'s workspace" that
equalled the name were scrubbed. A display name is not unique, so someone who signs up as "Alice", joins
Alice's workspaces and leaves erased the real Alice's labels and renamed her workspace (security review
R3, R3b). This happens on every server: leaving needs no setting.

## Decision
- Only what is tied to the account's id changes: `actor_name` of rows whose `actor_id` is the account,
  `target_label` of rows whose `target_id` names it, and JSON values the write sites keep beside an id.
- Write sites keep ids beside names: a lock's `editors` with `editorIds` (same order), an agent block's
  `user` with `userId` (`account/auditIds.ts` lists the pairs). The audit screen leaves the id keys out.
  `workspace.transferred` has kept its shape since it was added: `before.owner` is the actor's name,
  `after.owner` the target's, so those are matched through `actor_id` and `target_id`, old rows included.
- Only workspaces the account created (`created_by`) and still named after it at sign-up are renamed. In
  the workspaces it created, audit rows that copied that sign-up name (the workspace label of delete,
  restore and export rows, a rename's `name`) get the new name too.

## Consequences
- A row about anyone else, a namesake included, never changes (`nameScrubById.db.test.ts`, leaving and
  expiry, with a snapshot of every row that does not name the deleted id).
- Names copied without an id stay: lock editor lists and agent block records written before this change
  (`page.locked`, `page.lock_editors_changed`, `agent.blocked`, `agent.unblocked`), and the admin
  deletion's audit names (unchanged since 0.21.1). The terms' list of what stays after leaving must say so.
