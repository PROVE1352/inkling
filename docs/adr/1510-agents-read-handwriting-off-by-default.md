# 1510. Agents read handwriting only where the workspace allows it (off by default)

- Status: Accepted
- Date: 2026-11-09

## Context
Pages carry an ink layer (pen and highlighter strokes, `page_ink`, ADR 0815, 1340). Until 0.12 no
MCP tool returned it. People write things by hand they would not type: margin notes, personal
marks over someone else's text, sketches. Handing those to an agent is a different decision from
handing it the page text, and the people who wrote the ink are not always the person whose agent
reads it. The product decision for 0.12: a tool that reads ink exists, but it is off unless a
workspace turns it on, and agents call it only when needed.

## Decision
- Workspace setting `workspaces.agent_ink_read` ("Agents can read handwriting"), boolean, default
  false (migration `0040_v012_agent_ink_setting`). Shown to every member in Workspace settings ›
  Connected agents; owners and admins change it with `PUT /workspaces/:id/settings/agent-ink`
  (`{ enabled }`, browser sessions only like the other settings routes, audited as
  `settings.updated` with `agentInkRead` before/after). Owners and admins, not owners only: it is
  an agent-access decision like blocking an agent (0947), which admins already make, not a policy
  such as export or public links.
- The gate is in the route, not only in the tool: `GET /pages/:id/ink` answers 403
  `AGENT_INK_OFF` for agent requests (`currentAgent()`, i.e. OAuth connections through `/mcp`)
  while the setting is off. `read_ink` turns that code into a polite refusal that says nothing is
  wrong with the page and how an owner or admin turns it on.
- Not affected: people in the app, and personal API tokens (ADR 1201: the person's own REST
  access, not an agent connection; agent blocks and agent lock rules do not apply to them either).
- Turning it off takes effect on the next call; nothing is cached per connection. The setting is a
  read permission, not a lock, so it does not bump the workspace access version (1071).

## Alternatives considered
- **On by default** (ink is page content like text): the people who wrote the ink never agreed to
  an agent seeing it, and the user decision was "off by default, call only when needed".
- **Per-page or per-member switch**: finer, but another permission dimension next to visibility,
  locks and agent blocks; a workspace switch matches how agent access is managed today (0947).
- **Gate API tokens too**: the token is the person's own REST access and could already read ink;
  closing it would break existing scripts without making agents safer. Recorded as an option if
  API tokens get an "agent" flag later.
- **Owner-only (the `PATCH /settings` policy route)**: admins manage agents everywhere else.

## Consequences
- An agent asked "what did I scribble here?" in a workspace with the setting off answers that it
  cannot see handwriting and names the setting.
- Tests: `apps/server/src/mcpTools/agentTools012.db.test.ts` (off → refusal and no marker, member
  403 / admin 200 / audit row, token refused at the settings route, on → images, off again → refusal,
  read-only tokens may read, private pages, two-step requirement, subtree range).

## References
- apps/server/src/agentInk.ts, apps/server/src/routes/ink.ts, apps/server/src/routes/workspaceAdmin.ts
- apps/web/src/pages/WorkspaceSettings.tsx (`AgentInkGroup`)
