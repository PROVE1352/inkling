# Inkling MCP Connector

Connects Claude (Claude Code, claude.ai) so it can read and write **your Inkling notes**. Each user signs in and
grants consent with their own account, so Claude sees only what that user can see on the web (workspaces you are a
member of, shared pages, and your own 🔒 private pages; other people's private pages and other workspaces are off limits).

MCP server URL: `https://<your domain>/mcp` (the examples below use `notes.example.com`).

## Claude Code

```bash
claude mcp add --transport http inkling https://notes.example.com/mcp
```

Then in Claude Code run `/mcp` → `inkling` → Authenticate. The Inkling consent screen opens in your browser
(if you are not signed in, you go through the login screen and come back; delegated login (external account ID) works too).
Click **Allow** to return to Claude Code and finish connecting. Tokens refresh automatically every hour (refresh tokens last 60 days).

## claude.ai

Settings → Connectors → **Add custom connector** → name `Inkling`, URL `https://notes.example.com/mcp` → Add → Connect.
Sign in in the window that opens and click **Allow**. (Leave the OAuth Client ID/Secret fields empty; dynamic client registration is used.)

## What it can do (tools)

| Tool | Description |
|---|---|
| `list_workspaces` | List your workspaces |
| `list_pages` | Workspace page tree (path, shared/private, child count) |
| `search` | Search titles and bodies (with snippets); searches everything when the workspace is omitted |
| `read_page` | Read a page as Markdown |
| `create_page` | Create a new page from Markdown (`[[Title]]` becomes a wiki link) |
| `update_page` | Append to the end of the body / replace the whole body (replace: the previous state is kept in version history as "Before AI edit") |
| `rename_page` / `move_page` | Rename / move within the same workspace |
| `trash_page` | Move to trash (restorable from the web trash, permanently deleted after 30 days). **There is no permanent-delete tool** |
| `add_comment` | Comment on a page |
| `list_templates` | Templates I can use in a workspace (built-ins and custom; private ones only my own), with their category, kind and input questions |
| `create_from_template` | Create a page or page tree from a template, answering its input questions; follows the same section and permission rules as `create_page` |

Tokens are for `/mcp` only. Calling the REST API directly with the same token is rejected (no member management, public sharing or admin features).

## Disconnecting

On the web, open the command palette (⌘K) → **Manage MCP connections** (`/settings/connections`) → **Disconnect** next to the app.
The access and refresh tokens are invalidated immediately. To remove the Claude Code side, run `claude mcp remove inkling`.

## Operations notes

- **Reverse proxy**: the system Caddy must forward `/mcp`, `/oauth/*` and `/.well-known/*` to the app (127.0.0.1:3000).
  A one-line catch-all site block with `reverse_proxy 127.0.0.1:3000` needs no change (`deploy/Caddyfile` also proxies everything).
  If your config forwards selected paths only, add the three paths above. Caddy adds `X-Forwarded-Proto/Host` by default.
- **Environment variables**: set `PUBLIC_URL` in `.env` to your public origin, e.g. `PUBLIC_URL=https://notes.example.com`. It is the OAuth issuer; the `Host` header is never trusted for it (see [ADR 0806](adr/0806-configured-public-origin-only.md)).
- **Migration**: `0019_oauth_mcp` (adds 3 tables, leaves existing tables unchanged); applied automatically at boot.
- **Service worker**: `/mcp`, `/.well-known` and `/oauth/(token|register)` are excluded from the SPA fallback. `/oauth/authorize` is the SPA consent screen.
- Cleanup: housekeeping (hourly) deletes expired authorization codes and connections whose refresh tokens have also expired.
