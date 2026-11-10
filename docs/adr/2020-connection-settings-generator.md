# 2020. Connection settings generator: per-client formats from their own docs, token mode behind a switch

- Status: Accepted
- Date: 2026-11-10

## Context
Settings › Connections showed the MCP URL and one line for Claude Code. People connecting Cursor, VS Code or
another client had to translate that into the client's own file, and each client names things differently
(`mcpServers` or `servers`, `url` with or without `type`, where headers go). Wrong guesses fail silently: Claude
Code skips an entry that has `url` but no `type`.

0.16 adds tool profiles chosen by a query on the MCP URL (`/mcp?profile=core`; no query = all tools), and some
clients cannot register themselves for OAuth or cannot sign in to a server on plain http, so a fixed token in a
header is the way in for them.

## Decision
- **A pure function builds every config** (`apps/web/src/lib/mcpConfig.ts`, `buildMcpConfig`), tested for every
  client × sign-in × profile combination. The page (`components/McpSetup.tsx`) only renders it, with a copy
  button, the file location and one line of steps.
- **Clients and formats**, each from the client's documentation, checked 2026-11-10:

  | Client | What the page gives | Source |
  |---|---|---|
  | Claude Code | `claude mcp add --transport http inkling <url>`; token: `--header "Authorization: Bearer …"` | https://code.claude.com/docs/en/mcp |
  | Claude Desktop · claude.ai | The URL for Customize › Connectors › + Add › Add custom connector (Team/Enterprise: Organization settings › Connectors). Token: "No sign-in" and a request header `authorization` = `Bearer …` (the value is sent as entered; the section is in beta for some organizations) | https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp, https://claude.com/docs/connectors/custom/add-unlisted |
  | Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json`: `{"mcpServers": {"inkling": {"url": …, "headers": {…}}}}` (no `type`) | https://cursor.com/docs/context/mcp |
  | VS Code | `.vscode/mcp.json` (or "MCP: Open User Configuration"): `{"servers": {"inkling": {"type": "http", "url": …}}}`; token through `inputs` (`promptString`, `password: true`) and `"Authorization": "Bearer ${input:inkling-token}"`, so the file holds no token. VS Code's guided flow labels this location "available for compatibility … deprecated" and prefers the portable `mcpServers` format (`.mcp.json`, `~/.copilot/mcp-config.json`); the page still gives `.vscode/mcp.json` because it is the format with `inputs` (a secret prompt), and names the portable files next to it, where the generic JSON fits | https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
  | Other app | `{"mcpServers": {"inkling": {"type": "http", "url": …, "headers": {…}}}}`: Claude Code's `.mcp.json` shape, which VS Code's portable format (`.mcp.json`, `~/.copilot/mcp-config.json`) also uses; the page says key names differ per client | same as Claude Code and VS Code |

- **Windsurf is not listed.** Its MCP page (docs.windsurf.com/windsurf/cascade/mcp) answers 308 to another
  product's documentation (docs.devin.ai), and the `serverUrl` key quoted for Windsurf could only be found in
  third-party posts. Windsurf users get the generic JSON.
- **Profile**: core adds `?profile=core`; all tools adds nothing, so existing connections and docs stay valid.
  Changing it means re-adding the server, because the URL is the server's identity in every client.
- **Token mode is built but switched off** (`MCP_TOKEN_AUTH_ENABLED = false`). ADR 1201 makes a personal API token
  at `/mcp` a 401 (the MCP lookup reads OAuth grants only), so a token config would not work. The switch goes on
  with the server change that accepts `ink_pat_` tokens at `/mcp`; the function and tests already cover it.
- **The token is shown once, as before.** The token created on this screen lives in React state of the page (lifted
  from the token section so the generator can read it), fills the config while the "copy your new token" box is
  open, and is gone after Done or when the page is left. Not in storage, not in the URL. Without it the config
  carries the placeholder `<YOUR_INKLING_API_TOKEN>`. VS Code never gets it in the file.
- **Local help, facts only**: the address must be the server's `PUBLIC_URL` (the OAuth issuer and the resource
  check use it, `oauth.ts`); claude.ai and Desktop connectors connect from Anthropic's servers, so the server must
  be reachable from the internet (support article above); Claude Code sends OAuth credentials only to HTTPS or
  localhost/127.0.0.1/::1 token endpoints (Claude Code MCP docs); Claude Code's network settings page documents
  `NODE_EXTRA_CA_CERTS` for a private CA (https://code.claude.com/docs/en/network-config; it does not say MCP
  connections in so many words, so the help names it as Claude Code's general setting). The help opens by itself
  when the page is served over `http://`.

## Alternatives considered
- **Keep one command line**: leaves every other client to the person, with the silent failures above.
- **Put the token in every client's file**: VS Code has a secret prompt for this; the others have no such place in
  their documented format (Cursor and Claude Code read environment variables, which the person sets up).
- **List Windsurf with the commonly quoted `serverUrl`**: not from its documentation; a wrong key fails silently.
- **Show token mode now with a "needs server support" note**: a config that always answers 401 is worse than none.
- **Store the last token in localStorage** so the config can be shown later: breaks "shown once" (ADR 1201).

## Consequences
- VS Code with sign-in relies on VS Code registering itself (dynamic client registration); its reference page does
  not say so in words, so this is checked with a live connection at integration.
- Client formats drift; the ADR names the pages to re-check. A re-check is a change of `mcpConfig.ts` and its tests.
- Whether OAuth discovery works with `?profile=core` depends on the server comparing the `resource` parameter with
  `<origin>/mcp` (`isOurResource`); clients that send the protected-resource metadata's `resource` are fine, one
  that sends the URL with its query would be refused. To be checked with the profile work.
