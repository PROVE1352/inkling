# 1623. A revert is an ordinary change of the person, linked by an audit event

- Status: Accepted
- Date: 2026-11-10

## Context
"Who reverted what" must be visible, and a revert must itself be revertable, without a schema change.

## Decision
- The revert writes each page through the same batch path as `patch_sections` (ADR 1542, all
  sections or none), as the person, under the write gate, after a "Before revert" version. The change
  log therefore records it as that person's edits (`via` null): `changes_since`/`catch_up` show it as
  a modification by that person with the inverse diff.
- The log is sealed around the write (`reserveCursor`): no later edit merges into the reverted rows
  or into the revert's own rows (the 10-minute merge rule, ADR 1080).
- One `workspace_audit_events` row per written page, action `page.changes_reverted`:
  `before.seqs` = the reverted changes (and the agents' client names), `after.seqs` = the revert's own
  change rows, `after.conflicts`. The audit log is about administrative actions (ADR 0946); a revert
  is a person's decision about other changes, so it fits, and owners/admins see bulk reverts there.
- History and activity items get `revert: {revertable, revertedBy, isRevert}` from those events; a
  revert's own rows are offered "Undo revert" (the same machinery on those rows).

## Alternatives considered
- A sentinel `via` on the revert's rows: `via_client IS NOT NULL` means "an agent" everywhere.
- A `revert_of` column: cleaner, schema change; kept for 0.14 with ADR 1620's rich rows.

## Consequences
- The marks disappear with the audit retention; the edits themselves stay in the log.

## References
- apps/server/src/revert.ts (`revertInfo`), apps/server/src/routes/activity.ts, apps/server/src/routes/revert.ts
