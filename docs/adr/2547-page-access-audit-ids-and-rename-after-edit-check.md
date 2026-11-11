# 2547. Page access audit rows keep the person's id; a rename checks storage after the edit check

- Status: Accepted
- Date: 2026-11-12

## Context
The second review found two problems in the audit and rename paths.
- N6: page access audit rows (`page.access_granted`, `page.access_changed`, `page.access_removed`, and the
  grant written when a guest invitation is accepted) kept `person: <name>` with no id. ADR 2535 removes
  names by id only, so these names stayed after the account was deleted. The earlier "no trace" test
  checked rows written by hand, not rows written by the routes.
- N7: `PATCH /pages/:id` ran `assertWorkspaceGrowth` before the edit check. Someone who could only read the
  page moved the workspace's cached use up, and read `used` and `limit` from the 413.

## Decision
- The page access rows keep `personId` beside `person` (`routes/pageAccess.ts`). `{ person, personId }` joins
  the name–id pairs of `account/auditIds.ts`. Account deletion clears both by id, and the audit screen leaves
  `personId` out (`hideAuditIds`). The audit route is the only reader that shows audit JSON: export, MCP and
  the CLI do not show it.
- `page.guest_invited` keeps the invited address and no id, because the account may not exist yet. Deletion
  clears that address in rows whose address is the account's own sign-in address. No other account has that
  address, so a namesake is never touched. The invitations themselves were already deleted.
- Every place that writes audit rows was checked (the table is in the 0.22.1 report). The other names written
  as text are matched by an id in the same row (actor, target, the transfer's owners), by the pairs of
  ADR 2535, or are the account's own sign-up workspace.
- `PATCH /pages/:id` checks storage inside its transaction, after `assertEditable`. It still uses the bare
  `db`, because a recount writes the workspace row, which this transaction does not hold.
- A 413 `LIMIT_STORAGE` to a page guest of that workspace carries the code and the message but not `used`
  and `limit` (`quota/room.ts storageError`, read from the request's guest scope). Members still get the
  numbers, as `GET /workspaces/:id/usage` gives them anyway.
- The other write routes in `quota/writeSweep.test.ts` were checked for a storage check or a cache move
  before the permission check. The cache-moving checks (`assertWorkspaceGrowth`, reservations in
  `assertWorkspaceRoom`) all run after the edit, comment, placement or manager check. Two routes have no
  edit-level check for members at all (unchanged since before 0.22): `POST /pages/:id/snapshots` (any
  member may take a version) and `POST /files` without a page. They read the full flag for members only.
  The upload reserves its bytes only in the transaction that inserts the file.

## Consequences
- Rows written before 0.22.1 keep their `person` names with no id, so deletion cannot remove those. Only
  servers that ran 0.22.0 or older have such rows; a new demo has none.
- Another member's comment that mentions the person by name is that member's writing and stays (contract §13).
