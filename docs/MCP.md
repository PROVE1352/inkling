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

| Tool | Kind | Description |
|---|---|---|
| `find_context` | read | **Start here.** Ranked sections across all your workspaces (or one), packed into a token budget (default 3,500, max 12,000), each tagged with page id, `§anchor` and version `v=…` |
| `read_page` | read | A page as Markdown. `outline=true` lists sections (`§anchor`, ~tokens, `v=`), `section=<anchor or heading>` reads one, `maxChars` caps the body |
| `read_pages` | read | Up to 20 pages in one call within a budget (default 8,000) |
| `list_workspaces` | read | Your workspaces |
| `list_pages` | read | Page tree; `depth` limits levels, `format: "lines"` is compact (default `json`, the legacy shape) |
| `search` | read | Substring search of titles and bodies; `format: "lines"` is compact (default `json`) |
| `changes_since` | read | What changed since a cursor: per-section `-`/`+` diffs, added/removed/renamed/moved sections, page renames/moves/trash/visibility, "by <user> via <client>". `detail`: `none`/`diff` (default)/`full`; `budget` default 3,000, max 12,000. No cursor = start tracking. The cursor is always the last line |
| `query_rows` | read | Filter/sort/page a collection's rows by property name (`Status = Done AND Due < today`); one line per row `rowId \| version \| Title \| …`; `describe=true` for the schema |
| `list_templates` | read | Templates you can use in a workspace, with their input questions |
| `patch_section` | write | Change one section (`replace`/`append`/`prepend`/`insert_after`/`delete`) with `baseVersion`; a stale version returns a conflict with the current text |
| `update_page` | write | Append to / replace the whole body (replace keeps a "Before AI edit" snapshot). Prefer `patch_section` |
| `create_page` | write | New page from Markdown (`[[Title]]` becomes a wiki link) |
| `import_folder` | write | Many Markdown files at once, keeping folders |
| `update_row` / `create_row` | write | Set / add collection row properties by name; `update_row` needs `baseVersion` |
| `rename_page` / `move_page` | write | Rename / move within the same workspace |
| `trash_page` | write | Move to trash (restorable for 30 days). **There is no permanent-delete tool** |
| `add_comment` | write | Comment on a page |
| `create_from_template` | write | A page or page tree from a template |

Tokens are for `/mcp` only. Calling the REST API directly with the same token is rejected (no member management, public sharing or admin features).

## Guide for agents

Spend calls and tokens in this order (the server instructions say the same):

1. **`find_context(query)`** — one call, ranked sections with `page <id>; §anchor v=<version>`. Use specific words;
   Korean and English both work, but a question in one language does not find a page written only in the other.
2. Not enough? **`read_page(pageId, outline=true)`** then **`read_page(pageId, section=anchor)`**; several pages at
   once with **`read_pages(ids)`**. Full `read_page` and `list_pages` are for when you really need everything.
3. **Edit** with `patch_section(pageId, section, markdown, mode, baseVersion)` using the `v=` you read. On
   `Conflict:` the result contains the section's current text and version: merge your change and retry.
   Other sections and people typing elsewhere in the page are not affected.
4. **Keep a local copy in sync**: call `changes_since()` once and store the cursor (always the last line) with your
   notes; next time call `changes_since(cursor)` — it returns only what changed since then (new text for added
   sections, `+`/`-` lines for modified ones, net of edits that cancelled out) — and store the new cursor. Pages you
   can no longer see appear only as `removed (no longer visible)`. On `resync_required` (cursor older than the
   retention, 30 days by default): store the fresh cursor it gives first, then re-read with `list_pages` +
   `find_context`/`read_pages`.
5. Collections: `query_rows(collectionId, describe=true)` for the schema, then filtered pages of rows; change
   them with `update_row(rowId, properties, baseVersion)`.

Errors tell you the next step (for example "page not found or not visible to you; use find_context to get a valid id").
Token numbers in tool output are estimates (ASCII characters / 4, one per Korean/CJK character).

### Prompt-cache friendly output

Read tools answer with the same bytes for the same request while the documents do not change (stable ordering,
no timestamps or request ids), and put stable parts first (page header, outline) and variable parts last.
To reuse your model's prompt cache, read the outline or overview first and keep it at the start of your context;
append `changes_since` diffs after it instead of re-reading pages.

### Access levels

The consent screen offers **Read and write** (default) or **Read only**. Clients may request `scope=read`
(read-only, cannot be widened on the consent screen) or `scope=write` / no scope (read and write). Legacy
`scope=notes` connections keep full access. A read-only connection still lists every tool; write tools answer
"this connection is read-only …" and the server instructions say so. Change access by disconnecting in
Settings → MCP connections and connecting again.

### Attribution

Edits and comments made through MCP are labelled "<you> (via <app name>)" in version history, comments and the
change feed. An append by an agent adds an "AI edit" snapshot (at most one per page every 10 minutes); a
replace keeps the "Before AI edit" snapshot.

## Disconnecting

On the web, open the command palette (⌘K) → **Manage MCP connections** (`/settings/connections`) → **Disconnect** next to the app.
The access and refresh tokens are invalidated immediately. To remove the Claude Code side, run `claude mcp remove inkling`.

## Operations notes

- **Reverse proxy**: the system Caddy must forward `/mcp`, `/oauth/*` and `/.well-known/*` to the app (127.0.0.1:3000).
  A one-line catch-all site block with `reverse_proxy 127.0.0.1:3000` needs no change (`deploy/Caddyfile` also proxies everything).
  If your config forwards selected paths only, add the three paths above. Caddy adds `X-Forwarded-Proto/Host` by default.
- **Environment variables**: set `PUBLIC_URL` in `.env` to your public origin, e.g. `PUBLIC_URL=https://notes.example.com`. It is the OAuth issuer; the `Host` header is never trusted for it (see [ADR 0806](adr/0806-configured-public-origin-only.md)).
- **Migration**: `0019_oauth_mcp` (adds 3 tables, leaves existing tables unchanged); applied automatically at boot.
  `0028_agent_context` adds the section index (`page_chunks`, `page_chunk_index`), the change feed (`page_changes`)
  and `via_client` columns; existing pages are indexed by a background backfill after boot (50 pages per batch).
- **Service worker**: `/mcp`, `/.well-known` and `/oauth/(token|register)` are excluded from the SPA fallback. `/oauth/authorize` is the SPA consent screen.
- Cleanup: housekeeping (hourly) deletes expired authorization codes and connections whose refresh tokens have also expired.
