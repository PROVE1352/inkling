# 0804. Workspace membership changes under a member lock; invite code is an owner secret

- Status: Accepted
- Date: 2026-11-07
- Audit: A-H2, C-M3

## Decision
- Role change, removal and leaving run in one transaction holding `pg_advisory_xact_lock(hashtext('ws-members:' || workspace_id))`; the actor's role, the target's role and the owner count are re-read inside it (`changeMemberRole`, `removeMember`). Account deletion takes the same locks for all of the user's workspaces (sorted).
- When an owner removes someone else, the invite code is regenerated in the same transaction.
- `inviteCode` is returned only to owners (`""` otherwise — the shared DTO stays a string).

## Consequences
Tests: 10 rounds of two owners demoting each other at once and both owners leaving at once always keep ≥ 1 owner. Remaining: any member can still add existing users directly (KNOWN-ISSUES).
