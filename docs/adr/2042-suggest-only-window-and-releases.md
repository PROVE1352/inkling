# 2042. Suggest-only for 60 minutes; the owner or an admin lifts it; no "new session"

- Status: Accepted
- Date: 2026-11-10

## Context
A suggest-only connection (ADR 2040) needs to become a normal one again. Candidates: time, a person,
a new session.

## Decision
- **Window: 60 minutes after the last flagged read** (`TAINT_WINDOW_MINUTES`). Reading flagged content
  again restarts it. An injected instruction acts in the turn that read it or soon after; an agent task
  rarely runs for more than an hour without a person looking; and the cost of a false positive (edits
  wait, other writes refused) should end on its own within a working session. A longer window makes
  every false positive a support case; a shorter one lets a long agent loop outlast it.
- **People lift it early** (browser only; no MCP tool, an agent never lifts its own limit):
  - the connection's owner, for every source (`POST /api/connections/release`; their list:
    `GET /api/connections/suggest-only`, and `suggestOnly` on `GET /oauth/grants` and `GET /tokens`);
  - a workspace owner/admin, or the owner, for the sources **in that workspace**
    (`POST /api/workspaces/:id/agent-connections/release`). An admin judges their workspace's content;
    a source in another workspace keeps the connection suggest-only until its owner, that workspace or
    the window says otherwise. `suggestOnly.sourcesHere` tells the admin what they can lift.
- **A release is remembered per source with the content's fingerprint** (md5 over the flagged
  sections' anchors and versions, or over the whole file's bytes, whatever page range was read).
  Reading the same flagged content again does not taint again — otherwise a release would last until
  the agent's next read of a page it needs.
  Changed flagged content (a new fingerprint) taints again. Rows older than 30 days are pruned by
  housekeeping (a released page read again after that taints again).
- **No "new session" release.** The MCP endpoint is stateless (`sessionIdGenerator: undefined`, one
  server per request); OAuth refreshes run on the token's schedule, not per conversation; API tokens
  have no session at all. The server cannot tell a new conversation from the old one, and an agent
  could fake one by reconnecting.

## Alternatives considered
- **Clear `tainted_at` on release**: the next read of the same page taints again immediately.
- **Admins lift every source**: an admin of workspace B would lift what workspace A's content caused,
  without seeing it.
- **A per-workspace window setting**: one more knob for a heuristic; the switch (ADR 2043) covers
  workspaces where it misfires.

## Consequences
- Lists: `suggestOnly: { until, sources, sourcesHere? } | null` on `GET /oauth/grants`, `GET /tokens`,
  `GET /workspaces/:id/agent-connections`; `suggestOnly: { [connectionKey]: … }` on the team agents
  board (`GET /workspaces/:id/team-agents`).

## References
- apps/server/src/agentTaint.ts (`noteSource`, `releaseTaints`, `suggestOnlyStates`),
  apps/server/src/routes/agentTaint.ts, apps/server/src/db/schema-taint.ts
