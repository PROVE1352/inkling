# 2063. Issuing agent connection tokens: browser only, names, audit, and the Connections screen

- Status: Accepted
- Date: 2026-11-10

## Context
An agent connection token (2060) is made by a person for an app. Who may make one, what it may be called, who
learns that it exists, and how the connection settings generator (2020) uses it decide whether it is a safer way
in than the alternatives people would otherwise use (sharing a session cookie, disabling TLS checks).

## Decision
- **Browser sessions only**: `GET/POST /api/agent-tokens` and `DELETE /api/agent-tokens/:id` use the same
  `requireCookieUser` as the OAuth consent and grant routes. A personal API token gets 403, an agent token or
  OAuth token gets 401 (they are valid only inside `/mcp`), and no MCP tool makes or lists tokens: a leaked
  credential cannot mint a longer-lived one or hide itself. Creation is limited to 20 per minute per IP.
- **The same choices as the consent screen**: read or read+write (0935, preselected read+write as apps ask for
  it), a range (1200: everything, some workspaces, a subtree; `validateRange`), plus a name and an expiry (2061).
- **Names**: the name is sanitised like an OAuth client name (control, bidi and zero-width characters removed,
  60 characters) and becomes the `via` label. Product and operator names are refused with the reserved list of
  0978 (folded: `ＡＤＭＩＮ`, `Adm1n`, and `public form` from 1870). Another member's exact display name in any
  of the person's workspaces is refused (`CLIENT_NAME_CLASH`): the person types the name, so unlike the consent
  screen there is no app to blame; well-known app names ("Claude Code", the list of 1007) stay allowed, and the
  per-workspace check of 1007 still applies at request time if a member later takes the name.
- **Audit**: `agent.token_created` (target `grant:<id>` and the name; `after: { access, range kind, expiresAt }`)
  and `agent.token_revoked` (by its owner) are written in every live workspace of the person that the token's
  range reaches, in the transaction that makes or deletes it; `agent.token_range_changed` (`before`/`after`: the
  range kinds) in every workspace the old or the new range reaches, when the owner changes it through
  `PATCH /api/oauth/grants/:id`. Owners and admins see when a static credential starts or stops reaching their
  workspace. Never the token or its prefix. Not audited: a token that runs out (the expiry is in the creation
  event) and the deletion of every grant by a password reset (an account event, not a workspace one). Personal
  API tokens are not audited; unchanged.
- **Connections screen**:
  - a section "Agent connection tokens" (`#agent-tokens`) between the generator and the connected apps: make,
    list (name, prefix, access, range, expiry, last use), change range, revoke;
  - the value is shown once, in React state only, and while it is shown the generator switches to token sign-in
    and fills it in (the person can switch back); the
    generator fills in only `ink_agt_` values (`isAgentConnectionToken`), so a personal API token made on the
    same screen is never put into an MCP config;
  - the generator's token mode is on (`MCP_TOKEN_AUTH_ENABLED = true`), named "Agent connection token", with
    the placeholder `<YOUR_INKLING_AGENT_TOKEN>`, the link to `#agent-tokens` and VS Code's input description
    "Inkling agent connection token";
  - every connection row (OAuth grants, agent tokens, API tokens) shows "Suggestions only until HH:MM" while it
    is suggest-only (2042) and the owner's "Allow edits again" (`POST /api/connections/release`), as the
    contract of 2040–2043 asked.

## Alternatives considered
- **Let an agent make a token for another app** ("issue a token for my CI agent"): exactly what a hijacked agent
  would do. Rejected.
- **Warn instead of refusing a member's name**: the consent screen warns because the app chose the name; here
  the person did.
- **Audit on the account instead of workspaces**: there is no account audit log; workspace admins are the ones
  who need to know.

## Consequences
- Workspace audit logs gain three actions (labels en/ko).
- An admin's block of one agent token (its own client id) does not cover the next token the member makes; to
  stop all of a member's agents in a workspace, block "all agents" of that member (0947), which covers tokens too.
- A person can rename an agent token only by making a new one (the name is the client's; renaming would rewrite
  how past edits read in lists that join the client name).
