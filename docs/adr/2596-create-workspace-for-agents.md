# 2596. Agents can create a workspace for their person (create_workspace)

- Status: Accepted
- Date: 2026-11-27

## Context
An agent asked to set up a new workspace for a project had no tool for it and had to ask its person to do it in the
web app. No earlier decision said agents must not create workspaces: docs/adr and docs/KNOWN-ISSUES.md had none. Two existing checks touched it: the bearer route
policy's `RANGED_DENY` already refused `POST /api/workspaces` to a connection limited to some workspaces or a
subtree ("a new workspace is outside the range"), and a trial-account test checked that no MCP tool calls a route
that refuses trial accounts.

## Decision
- MCP tool `create_workspace(name)` (1–60 characters). It calls the web app's `POST /api/workspaces`, so the name
  check, `LIMIT_WORKSPACES`, `LIMIT_WORKSPACES_TOTAL`, restricted mode, the trial refusal and rate limits apply as in
  the browser. The connection's person owns the workspace. The answer is JSON `{ id, name, role, url, next }`.
- Listed in the full profile only. In core it is in the hidden group `workspaces` and runs through `more_tools`, like
  `upload_file` and the other hidden tools (docs/adr/2000-*). Annotations: readOnly false, destructive false,
  idempotent false, openWorld false (docs/adr/2460-*).
- Refused for: a read-only connection; a connection limited to some workspaces or a subtree ("This connection is
  limited to some workspaces (or one page tree), so it cannot create workspaces: that would widen what the person
  allowed. …"; over REST it stays 403 `OUT_OF_RANGE`); trial accounts (the route's refusal); an account that is only a
  guest elsewhere and has no workspace of its own.
- A daily cap: one account's agent connections (OAuth grants and agent connection tokens; personal API tokens and the
  browser are not counted) create at most 5 workspaces in 24 hours, deleted ones included. Past it: 429
  `AGENT_WORKSPACE_LIMIT`. `workspaces.created_via` (migration 0065) keeps the client's name.
- The person gets one notification, `agent_workspace` ("An agent created the workspace "X" for you", with the
  client), which opens the workspace.
- The connection works in the new workspace at once: `agents_pending` (docs/adr/2580-*) is only for workspaces
  someone else added the person to, so a workspace the person's own connection made has it false.
- The trial-account test lists `create_workspace` as the one tool that calls a route with the trial refusal.

## Alternatives
- Allow it with no cap. An agent stuck in a loop could create workspaces up to the account's limit, which is
  unlimited by default.
- Let ranged connections create too and add the new workspace to their range. The agent would widen a range the
  person narrowed on purpose.
- Rely on `LIMIT_WORKSPACES` only. It is off by default, so a daily cap of its own is still needed.

## Consequences
- An agent can create up to 5 workspaces a day per account; more need the web app.
- Deleting a workspace an agent made does not give the allowance back within the 24 hours.
- A person who narrowed a connection's range creates workspaces themselves and includes them in the connection
  (Settings › Connections).
