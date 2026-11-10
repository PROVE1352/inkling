# 2065. Uploads by AI agents: a server default, a workspace switch, limits from the environment

- Status: Accepted
- Date: 2026-11-10

## Context
0.16 lets connections attach files (`upload_file`, a bearer `POST /api/files`; ADR 2044, 2045) with a
fixed 5 MB cap and a 200 MB daily budget per account. Operators asked for three things: turn agent
uploads off for the whole server or let each workspace decide; raise the per-file cap; and not have a
budget at all. The 2045 budget also summed every file the account added, so people who had never had a
limit on browser uploads got one through their agents' rule, and a person who uploaded a lot in the
browser stopped their own agents.

## Decision
- **`AGENT_UPLOADS`** = `on` (default: allowed unless the workspace turns it off), `off` (refused unless
  the workspace turns it on) or `never` (refused everywhere; the workspace setting cannot turn it on).
  Any other value boots with a warning and counts as `off`: the side that a workspace can still open, and
  a typo never opens uploads on a server that meant to close them.
- **Workspace setting** `workspaces.agent_uploads` (`null` = follow the server, `'on'`, `'off'`), next to
  the suggest-only switch in Workspace settings › Connected agents, changed by owners and admins in the
  browser (`PUT /api/workspaces/:id/settings/agent-uploads { value: 'default' | 'on' | 'off' }`), audited as
  `settings.updated`. `'on'` under `never` is 409 `AGENT_UPLOADS_NEVER`; the screen shows the control
  disabled with the reason. `WorkspaceSettingsDTO` carries `agentUploads` and the read-only
  `agentUploadsServer`.
- **Refusal**: 403 `AGENT_UPLOADS_OFF` with one line naming who can change it (the workspace, or the
  server for `never`). upload_file checks it before size and type and says "Nothing was stored; do not
  retry". The tool stays in tools/list: the list is fixed per profile (ADR 2000), and a per-workspace list
  would differ between connections of one server.
- **Not affected**: people's uploads in the browser, read_file and PDF text.
- **Per-file cap** `AGENT_UPLOAD_MAX_MB` (default 5, at most 64, above that cut with a warning; 0 or a
  non-number keeps the default — there is no "unlimited", the whole file is in memory). upload_file sends
  the file as base64 inside one MCP request, so the `/mcp` body limit is `max(12 MB, base64(cap) + 1 MB)`,
  and a body over 12 MB is accepted only for a `tools/call` of upload_file (directly or through
  `more_tools`); every other request keeps 12 MB (refused with 413 after parsing). The bearer multipart
  route takes the cap per request (it may be above the browser's 25 MB). When the limits differ from the
  defaults the boot log prints the values in use, including the MCP body limit for upload_file calls.
- **Daily budget** `AGENT_UPLOAD_DAILY_MB` (default 200; `0` = no budget) counts only files uploaded
  through a connection: `files.uploaded_via` holds the connection key (`grant:<id>`, `token:<id>`) and a
  partial index on `(created_by, created_at) WHERE uploaded_via IS NOT NULL` serves the sum. People's
  browser uploads count for nothing and have no budget, as before 0.16.
- Admin › Status (security group) shows the mode, the cap, the budget ("no daily budget" for 0), the MCP
  body limit for uploads, and a warning when a value was not taken as written.
- Migration 0050 (`workspaces.agent_uploads`, `files.uploaded_via`, the partial index).

## Alternatives considered
- **A second budget for people's uploads** (`UPLOAD_DAILY_MB`, default 0): no one asked for a limit on
  people, and 0.15.1 had none; a knob with a default of "off" can be added when there is a need.
- **Keep counting every file of the account** (ADR 2045 as written): one rule for both, but it put a
  limit on people through a setting about agents, and the 0 = off escape would also have been needed for
  people who upload a lot. Rejected.
- **A separate `MCP_MAX_BODY_MB`**: two values that must agree; deriving the body limit from the file cap
  cannot disagree, and limiting it to upload_file calls keeps the 12 MB rule (and its parse cost bound,
  ADR 1526) for every other request.
- **Hide upload_file when uploads are off**: the list would depend on the workspace and the server, while
  one connection reaches several workspaces; the refusal line tells the agent what to do instead.
- **A JSON settings column** for this and later switches: there is none on `workspaces` today; one
  nullable text column follows the existing per-setting columns.

## References
- apps/server/src/agentUploads.ts, apps/server/src/routes/agentUploads.ts, apps/server/src/routes/files.ts,
  apps/server/src/mcpBody.ts, apps/server/src/mcpTools/historyInkFileTools.ts
- apps/server/src/agentUploads.test.ts, agentUploads.db.test.ts, agentUploadsLimits.db.test.ts
- ADR 1526 (MCP body), 2000 (profiles), 2044, 2045 (upload_file and its limits)
