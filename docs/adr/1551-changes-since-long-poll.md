# 1551. changes_since long-poll: wake-ups from the change log consumer, no new NOTIFY

- Status: Accepted
- Date: 2026-11-09

## Context
Agents that follow a workspace call `changes_since(cursor)` in a loop. Each call costs a cursor
reservation (a transaction under the change-log lock, ADR 1080) and a scan of the log, and almost all
of them return "No changes". The interval is a trade-off the agent cannot make well: short intervals
load the database for nothing, long ones see changes late. Three agents polling every 2 seconds are
90 calls and 180+ transactions a minute while nothing happens.

## Decision
**`wait` argument** on the MCP tool (seconds, 0–25, only with a cursor). The tool reads as before; if
the answer is an `ok` with no changes and nothing more, it waits for a wake-up, reads again from the
cursor of that empty answer, and repeats until it has something or the time is up (then it returns the
last empty answer, whose cursor is valid). The REST route is unchanged; the wait lives in the MCP layer
(`mcpTools/changeTools.ts`, `context/changeWait.ts`).

**Wake-ups reuse the change log path** (ADR 1080, 1150): the change consumer, after a pass that
committed rows, calls `notifyChangesCommitted(workspaces of those rows)`. Only waiters whose workspaces
(the given `workspaceId`, else the person's memberships — a superset is fine, a wake-up only means
"read again") intersect are woken. Another process's commit reaches this one as the existing 'change'
announcement on LISTEN; it wakes every waiter, whose read then drains the row or waits on the change-log
lock for that process's pass (`reserveCursor`), so nothing is read half-applied. The other direction
needs one more rule: when this process commits change rows, another process's consumer may apply them
(any consumer takes pending rows under the lock, `SKIP LOCKED`), and no local pass would report them.
So local commits are numbered, each consumer pass notes the number when it starts, and if no local pass
that started after the commit reported rows within 250 ms, every waiter reads again (`fallbacks` in the
stats). With one process the kicked local pass reports first and the fallback does not fire; the
parallel test runs (several processes on one database) found the case. No extra NOTIFY, no timer per
waiter besides its deadline: a waiting call costs no statement until something happens.

**No lost wake-up:** a position (`changeMark`) is taken before the read that came back empty; a wait whose
workspaces were notified after it returns at once.

**Limits:** 256 waiting calls per process, 4 per connection. A call over a limit, or during shutdown,
answers at once with a `wait skipped:` line before the usual text (it degrades to a plain read, never an
error). Shutdown releases every waiter right after the listener closes and before the HTTP close
waits for in-flight requests (`index.ts`). A client that disconnects aborts the MCP request (the SDK's
abort signal, raised when `/mcp` closes the server on socket close), which ends the wait and frees the
slot.

**Timeouts on the way:** Fastify `connectionTimeout` 30 s (socket inactivity; nothing is written while
waiting), `requestTimeout` 300 s; Caddy `reverse_proxy` has no response timeout by default
(`deploy/Caddyfile` sets none); MCP clients default to a 60 s request timeout (TypeScript SDK
`DEFAULT_REQUEST_TIMEOUT_MSEC`). Hence the 25 s maximum. Checked over a real socket on a running server
(25.0 s answer, no reset).

## Alternatives considered
- **`wait` on `GET /api/changes`:** the same mechanism for API-token clients, but a REST contract
  change; left for when a REST client asks for it.
- **SSE / a stateful MCP session with notifications:** the MCP endpoint is stateless (one server per
  request); a stream would need session affinity and a new transport mode.
- **Per-waiter polling every second inside the server:** moves the load from the client to the
  server without removing it.
- **NOTIFY per change for waiters:** the change announcement already exists; ADR 1150 measured the
  commit-time lock a NOTIFY adds to writers.

## Consequences
- Calls and transactions while idle drop to about one per agent per 25 s; a change is seen within the
  consumer's kick (milliseconds) instead of half the poll interval. Measured in docs/PERFORMANCE.md
  ("changes_since, three agents watching").
- The wait is reported to the connection's usage as wait time, not latency (ADR 1552).
- Over-waking is possible (a change in a page the agent cannot see, in a shared workspace) and costs
  one read; the visibility filter stays in the read.
- Tests: `apps/server/src/mcpTools/agentEfficiency.db.test.ts` (early return, deadline, invisible change,
  change between read and wait, a change no local pass reports, schema maximum, per-connection cap,
  shutdown release, abort; waits are observed through the registry, not sleeps),
  `apps/server/src/connectionUsage.test.ts` (registry).

## References
- apps/server/src/context/changeWait.ts, apps/server/src/mcpTools/changeTools.ts,
  apps/server/src/context/changeLog.ts (`changePass`), apps/server/src/outbox.ts (`onOutboxAnnouncement`,
  `onOutboxCommitted`),
  apps/server/src/index.ts (shutdown)
- ADR 0932, 1080, 1150
