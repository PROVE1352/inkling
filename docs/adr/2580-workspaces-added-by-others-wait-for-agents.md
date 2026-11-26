# 2580. Workspaces someone else added you to wait before your agents see them

- Status: Accepted
- Date: 2026-11-26

## Context
Any member who shares one workspace with a person can add that person to a workspace of their own
(`POST /api/workspaces/:id/members`, docs/adr/0948-*), without the person agreeing. A connection whose
range is "all" (the default for OAuth grants, agent connection tokens and API tokens, docs/adr/1200-*)
took such a workspace in at once. Its pages then came back from `find_context`, its locked "always"
pages reached the person's agents as `<instructions>` (docs/adr/0975-*), and its inbox items, changes and
notifications reached them too. The 0.25.3 security review (C-mcp M1) wrote this up: whoever adds you
writes rules for your agents.

People still need the direct add: a team admin puts a colleague into a team workspace, and the colleague
should see it in the web app at once.

## Decision
- `workspace_members.agents_pending` (boolean, default false) and `added_by` (uuid, ON DELETE SET NULL),
  migration 0064, with a partial index on `user_id` where `agents_pending`. Rows that exist when 0064
  runs keep false: nobody's agents lose a workspace on upgrade. The state belongs to the membership, not
  to a connection, so a connection made after the add leaves the workspace out too.
- Whose step made the membership. `agentInclusionSites.test.ts` lists every insert into
  `workspace_members` and fails on a new one until it is classified:

  | Site | Whose step | agents_pending |
  |---|---|---|
  | `routes/workspaces.ts` create | the creator's | false |
  | `routes/workspaces.ts` join with an invite code or link | the person's (browser only) | false |
  | `routes/workspaces.ts` direct add | someone else's | **true**, `added_by` = the adder |
  | `routes/auth.ts` sign-up workspace | the person's | false |
  | `routes/oidc.ts` first OIDC login | the person's | false |
  | `account/trial.ts` trial workspace | the person's | false |

  Joining with a code while already a member changes nothing (the insert does not happen).
- One place reads it: the token lookups (`oauth.ts getBearerUser`, `apiTokens.ts getApiTokenUser`) select
  `agentMembershipsSql` in the same statement. For a stored range "all" whose owner has a waiting
  membership, `scopeFromColumns` returns a workspace range of the other memberships, marked `implicit`,
  with the waiting ids beside it. Everything that already honours a range (requireMembership,
  `visibleTo`, `agentAllowedSql`, notifications, inbox, catch_up, find_context, get_instructions, MCP
  resources) leaves the workspace out with no change of its own. Without a waiting membership nothing
  changes: no scope, no SQL, the same plans.
- Ranges the person chose (some workspaces, one subtree) are not touched: the person picked them.
- The refusal keeps the code `OUT_OF_RANGE`, with its own message: someone else added the person, only
  the person can include it in the web app (Settings › Connections, or the notification). The MCP server
  instructions of such a connection say the same in one line, so an agent asked about a team workspace
  tells its person what to do instead of guessing.
- An implicit range is not a chosen limit for the bearer route policy: `RANGED_DENY` (creating a
  workspace, invite previews, member candidates) stays allowed as for "all".
- Agent connection token audits (`agent.token_created`, `agent.token_revoked`, range changes) are not
  written into a waiting workspace: its admins learn nothing about the person's connections.
- Including: `POST /api/workspaces/:id/agent-include` (idempotent) and `GET /api/me/agent-pending-workspaces`
  (names and who added), both in `SESSION_ONLY` and checked again in the handlers. No token can include a
  workspace or read the list (the names are chosen by whoever added the person). The web app shows one
  line with an Include button under the `workspace_added` notification (`NotificationDTO.agentsPending`)
  and on Settings › Connections; the button asks first, naming what including means.

## Consequences
- A team admin who adds a colleague must tell them to press Include once before their agent sees the
  team workspace; the agent's refusal says the same.
- Adding, removing and re-adding someone only ever produces a waiting membership: the attacker cannot
  make a membership "included" (only the person's session clears it), and removing the person deletes the
  row. Repeated adds send `workspace_added` notifications, as before.
- Left to follow-ups: the team agents board (`teamAgents.ts rangeCoversSql`) still lists a waiting
  member's "all" connections in that workspace, and archiving (`workspaceListing.ts archiveApplies`)
  should treat an implicit range like "all".
