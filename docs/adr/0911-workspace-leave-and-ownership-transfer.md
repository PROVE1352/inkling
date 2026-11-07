# 0911. Leaving and ownership transfer

- Status: Accepted
- Date: 2026-11-07

## Context
Leaving was only reachable from inside the members dialog, and a sole owner who tried got a
server error (400 "The last owner cannot leave"). Handing a workspace over meant promoting
someone and then demoting yourself in two separate requests. The admin's `SOLE_OWNER` message
told people to "transfer ownership" although no such action existed.

## Decision
- `POST /api/workspaces/:id/transfer { userId }`: in one transaction holding `ws-members:<ws>`
  the caller's role is re-read (must be owner, else 403), the target must already be a member
  (400; delegated accounts are members like any other), the target is set to owner and the caller
  to member. Two concurrent transfers by the same owner serialise on the lock; the second sees the
  caller demoted and gets 403, so there is always exactly one new owner and never zero.
- The server rule stays: the last owner leaving is refused with **400** (`VALIDATION`, as
  documented in API.md since M8). The web stops it before the request instead: "Leave workspace"
  in the workspace menu checks the member list and, for a sole owner, offers transfer
  (optionally followed by leaving), delete (0910) or cancel. When the owner is the only member,
  leaving is deleting, and the dialog says so and goes to the delete flow.
- The leave confirmation now states the actual policy: the leaver's private pages go to the
  trash, nobody else can see them, and the 30-day trash purge removes them.
- Admin forced deletion: the `SOLE_OWNER` message and hint now point to "Transfer ownership" in
  the workspace menu and say that an admin who is not an owner of that workspace cannot do it.

## Consequences
- An owner who demotes themself through the transfer cannot undo it alone; the new owner has to
  promote them again.
- Tests: `workspaceDelete.test.ts` (403/400 cases, transfer then leave 204, delegated target,
  concurrent transfers keep one owner, sole owner leave stays 400).
