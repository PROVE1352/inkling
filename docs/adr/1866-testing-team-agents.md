# 1866. Testing team agents

- Status: Accepted
- Date: 2026-11-10

## Context
The rules are about who may be a target and who sees what; they need a real database with several
people, connections and workspaces.

## Decision
- `teamAgents.db.test.ts` mints real grants (one MCP client per connection) and checks: only live,
  in-range, unblocked connections of members are listed; another person's connection, a non-member's
  and an out-of-range one are refused with nothing written; a hand-off lists in one connection's inbox
  only and survives another connection's ack; the copy setting; revoke hands back; person cells keep
  the 0.14 shape, `this connection` matches only its rows, a stale key never counts; agent chips in
  to-dos; the board hides titles and anchors of pages the viewer cannot see; catch_up is unchanged
  without `team` and prints its token cost with it.
- `teamAgents.test.ts` (pure): the ref value, the cell rule a 0.14 client exercises, chip scanning, the
  inbox marker (other lines byte-identical) and the exact catch_up team lines. The notation round-trip
  table gains the agent chip.

## References
- apps/server/src/teamAgents.db.test.ts, apps/server/src/teamAgents.test.ts,
  apps/server/src/context/notationRoundTrip.test.ts
