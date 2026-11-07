# 1007. Client names vs member names: exact, per workspace, warning for common apps

- Status: Accepted (supersedes the member-name part of ADR 0978)
- Date: 2026-11-07

## Context
ADR 0978 refused consent when a client's folded name matched any member of any of the person's
workspaces. A member named "Claude" therefore blocked the Claude connector for everyone in all their
workspaces, and look-alike folding (l→i, 0→o) made unrelated names collide.

## Decision
- Product/operator words (inkling, admin, system, …) keep the folded check and are refused at
  registration and consent, as before.
- Member names are compared exactly (NFKC, case, whitespace), never folded.
- The rule applies per workspace at request time (`assertAgentAllowed`): a connection whose name
  equals another member's display name in THIS workspace is refused there (`CLIENT_NAME_CLASH`);
  other workspaces work. The person's own name does not count. Cached a minute per (workspace,
  client, person).
- Common connector names (Claude, Claude Code, ChatGPT, Codex, Cursor, Copilot, Gemini, Windsurf,
  Cline, Zed, …, `WELL_KNOWN_CLIENTS`) are never refused for a member clash; the consent screen shows
  a warning (`nameNotice` in `GET /oauth/authorize/info`, `blocking: false`). For other names the
  notice says which workspaces will refuse it.
- Writes stay attributed "<person> via <client>", so a member and a client sharing a name are still
  distinguishable in the audit log.

## Alternatives considered
- Keep refusing at consent but exempt common names: still blocks unrelated workspaces.
- Suffix the label ("Claude (app)"): changes stored provenance strings for every write.

## Trade-offs
- A malicious client can still pick a common app name; the label was always self-asserted (AGENT-S1).

## References
- apps/server/src/clientName.ts, agentAccess.ts, routes/oauth.ts
