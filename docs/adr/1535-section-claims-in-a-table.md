# 1535. Section claims live in a table

- Status: Accepted
- Date: 2026-11-09

## Context
`claim_section` lets an agent connection say "I am working on this section for a few minutes".
Claims live for minutes, so memory looked enough.

## Decision
- `section_leases (page_id, anchor) → connection, user, client name, block id, expires_at`. A claim
  is an upsert that succeeds when the row is free, expired, or already this connection's (then it is
  extended): one statement, no read-then-write race.
- Time comes from the database clock (`now()`), so processes with skewed clocks agree. Reads
  ignore expired rows; housekeeping deletes rows that ended over a minute ago.
- A claim belongs to a connection (`grant:<id>`, `token:<id>`); browser sessions do not claim.
  Default 5 minutes, at most 30, at most 20 live claims per connection. Releasing deletes the row.
- `read_page` prints `claimed by <client> until <time>Z` (or `this connection`) on the outline line
  and the section header; the web app shows "<client> is working on this section" next to the
  heading.

## Alternatives considered
- **In-process map**: lost on restart and invisible to a second server process (the reason ADR 1522
  gave for not keeping catch_up markers in memory either).
- **Postgres advisory locks**: tied to a session, not to an MCP connection that makes one HTTP
  request per tool call.

## References
- apps/server/src/leases.ts, apps/server/src/housekeeping.ts, apps/server/src/mcpTools/collabTools.ts
