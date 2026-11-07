<p align="center">
  <img src="apps/web/public/icon.svg" width="72" height="72" alt="Inkling logo">
</p>

<h1 align="center">Inkling</h1>

<p align="center">
  Notion-style databases and Obsidian-style links, graph and JSON Canvas in one self-hosted app — with
  real-time collaboration and a built-in MCP server for AI agents. MIT, everything free.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml"><img src="https://github.com/PROVE1352/inkling/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  English · <a href="README.ko.md">한국어</a>
</p>

![A document with the backlinks, outgoing links and tags panel](docs/images/1-doc-backlinks.png)

| | |
|---|---|
| ![Database as a board grouped by status](docs/images/2-database-board.png) | ![The same database as a table](docs/images/2b-database-table.png) |
| ![Workspace link graph](docs/images/3-graph.png) | ![JSON Canvas whiteboard](docs/images/4-canvas.png) |
| ![Dataview-style query blocks: a table and open tasks](docs/images/5-query-block-tall.png) | ![Calendar of due dates](docs/images/6-calendar.png) |

## Features

**Write**
- Block editor (BlockNote): slash menu, tables, code blocks with highlighting, checklists, callouts, images and file drops
- `[[wikilinks]]` with autocomplete, `#tags`, `@mentions` and daily notes
- Templates for a page or a whole structure (sub-pages, databases with views, canvases): variables, prompts and Obsidian Templater basics, a searchable gallery, .md/.zip import and export ([docs/TEMPLATES.md](docs/TEMPLATES.md))
- Version history with named snapshots, comments, trash with restore, PDF export (print CSS)
- English and Korean UI; installable PWA; light and dark themes

**Organize & databases**
- Nested pages and folders, shared and private (🔒) pages per workspace, drag-and-drop ordering
- Databases with table, board, calendar, gallery and timeline views; text, number, select, multi-select, date, checkbox, person, URL, relation and rollup properties; sort, filter and group
- Due dates and tasks across the workspace (Due view, global calendar), ⌘K search over titles and bodies

**Connect**
- Backlinks, unlinked mentions and outgoing links in the right panel
- Workspace graph and local graph
- Infinite canvas compatible with Obsidian's [JSON Canvas](https://jsoncanvas.org) (`.canvas`)
- Query blocks: a Dataview subset (`TABLE` / `LIST` / `TASK`, `FROM`, `WHERE`, `SORT`, `LIMIT`) that stays live as pages change ([docs/QUERY.md](docs/QUERY.md))

**Collaborate**
- Real-time co-editing with Yjs: live cursors, presence, offline edits merge on reconnect
- Workspaces with invite links, read-only public share links for a page or a folder subtree
- Workspace ownership transfer, and workspace deletion that owners can undo for 30 days
- Mentions, comment and due-date notifications

**AI & integrations**
- Built-in MCP server with OAuth 2.1 + PKCE: connect Claude Code, claude.ai or any MCP client per user, seeing only what that user can see ([docs/MCP.md](docs/MCP.md))
- Link previews and embeds (YouTube, Vimeo, Loom, Figma, Spotify, CodePen, Google Docs) through an SSRF-filtered fetcher
- Slack and Discord webhooks for mentions, comments, due dates and new pages
- iCal feed of due dates, CSV/XLSX import and export for databases, read-only Google Sheets sync (experimental)
- Markdown and zip import/export (front matter, attachments, `[[links]]` resolved), upload to Notion

**Self-hosting & operations**
- One `docker compose` stack: Postgres, the app, and a backup sidecar; optional Caddy overlay for automatic HTTPS
- Scheduled, verified, optionally encrypted backups with GFS retention, weekly restore tests and rclone off-site copies ([docs/BACKUP.md](docs/BACKUP.md))
- Admin page: users, signup keys, password reset queue, IP bans from brute-force protection, backups
- Optional SMTP for invitations, password resets and email verification; delegated login against an external auth server

**Experimental** (off unless listed in `EXPERIMENTAL_FEATURES`)
- Two-way Obsidian vault sync with the `inklingctl` CLI ([docs/VAULT-SYNC.md](docs/VAULT-SYNC.md))
- Plugin API v0: sandboxed iframe plugins, approved by an admin ([docs/PLUGINS.md](docs/PLUGINS.md))
- Google Sheets sync: a database that mirrors a sheet, read-only

## Quick start

You need Docker with the Compose plugin and, for HTTPS, a domain whose DNS points at the server
(ports 80 and 443 open).

```bash
git clone https://github.com/PROVE1352/inkling.git
cd inkling
cp .env.example .env
# edit .env: PUBLIC_URL=https://notes.example.com, DOMAIN=notes.example.com,
#            POSTGRES_PASSWORD=<long random string>, BACKUP_PASSPHRASE=<keep a copy off the server>

docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d --build
```

Caddy obtains and renews the certificate. Then create a signup key for the first account. The
first account to register becomes the site admin:

```bash
./deploy/signup-key.sh new "first admin"
#   Signup key : ABCD-EFGH-JKMN-PQRS
#   Signup link: https://notes.example.com/register
```

Open the signup link, paste the key, and you are in. Further keys can be issued from the **Admin** page.

To try it locally without a domain, run `docker compose up -d --build` and open http://localhost:3000
(production mode still asks for a signup key, so run the same `signup-key.sh` command).

The compose project, volumes and database role are named `nodian` for historical reasons; keep
them as they are, or existing data volumes will not be found after an upgrade.

### Configuration

The essentials, all in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | empty | Public origin, e.g. `https://notes.example.com`. Used for mail links, the OAuth issuer and share previews; the `Host` header is never trusted. An `https://` value also turns on Secure cookies. |
| `POSTGRES_PASSWORD` | `nodian` | Database password. Change it **before the first start**; Postgres only reads it when it creates the data volume. |
| `SIGNUP_REQUIRE_KEY` | required in production | Leave empty: signup then needs a key. `0` opens public signup. |
| `DEFAULT_LOCALE` | `en` | `en` or `ko`: language of emails and built-in templates for users who have not chosen one, and the UI default before the browser language. |
| `TZ` | `UTC` | Time zone that decides "today" for due dates, daily notes, reminders and backup schedules. |
| `COOKIE_SECURE` | automatic | Secure cookies turn on by themselves when `PUBLIC_URL` is `https://` (the Caddy overlay also sets it). Set `1` only for a different HTTPS setup without `PUBLIC_URL`. |

Everything else (backups, brute-force limits, delegated login, embeds, experimental features,
memory limits, Postgres tuning) is documented in [.env.example](.env.example) and
[docs/OPERATIONS.md](docs/OPERATIONS.md). Deployment details, including running behind your own
reverse proxy: [deploy/DEPLOY.md](deploy/DEPLOY.md).

<details>
<summary>Outgoing mail with Gmail (optional)</summary>

Mail is off until both `SMTP_HOST` and `MAIL_FROM` are set. With a Google account that has 2-step
verification, create an app password (Google Account › Security › App passwords) and put it in `.env`:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=<your Gmail address>
SMTP_PASS=<16-character app password>
MAIL_FROM="Inkling <your Gmail address>"
# optional: block login until the address is verified (only for accounts created afterwards)
REQUIRE_EMAIL_VERIFICATION=0
```

Then `docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d app`. Gmail rewrites the
sender to the authenticated account, and has daily sending limits; for a larger team use a
transactional mail provider instead.

</details>

### Development

Node 22+, pnpm (version pinned in `package.json`) and Docker:

```bash
pnpm install
pnpm db:up      # Postgres on localhost:55432
pnpm dev        # API + collab on :3001, web on :5173
```

Tests, CI and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

## How it compares

A rough comparison as of November 2026, from each project's repository, documentation and pricing page.
"EE" means the feature is in a paid enterprise edition. Corrections are welcome.

| | Inkling | [salt.md](https://github.com/saltmd/salt.md) | [Docmost](https://github.com/docmost/docmost) | [AFFiNE](https://github.com/toeverything/AFFiNE) | [Outline](https://github.com/outline/outline) |
|---|---|---|---|---|---|
| License | MIT | AGPL-3.0 | AGPL-3.0 core + paid EE | MIT; server code under an EE license that exempts the free self-hosted Community Edition | BSL 1.1 (becomes Apache 2.0 on 2030-10-23) |
| Database views | table, board, calendar, gallery, timeline | table, board, list, gallery, calendar, timeline, form | EE | table, kanban, calendar | no |
| `[[wikilinks]]` / backlinks | yes / yes | `[[` opens the link menu / yes | no (`@` mentions) / yes | yes / yes | yes / yes |
| Graph view | yes | yes | not found | not found | not found |
| Canvas | JSON Canvas (`.canvas`) | no | Excalidraw, draw.io embeds | own whiteboard (Edgeless), not JSON Canvas | no (diagrams.net embed) |
| Real-time collaboration | yes | yes | yes | yes | yes |
| MCP server | built in, free | built in, free | EE | built in, needs an AI provider; read-only by default | built in (plan limits: ?) |
| Obsidian vault sync | two-way (experimental) | no | no | one-way import | no |
| Notion import | no (Markdown/zip import, upload to Notion) | yes | yes | yes | yes |
| Self-host weight | app + PostgreSQL | one Go binary + SQLite | app + PostgreSQL + Redis | app + PostgreSQL (pgvector) + Redis | app + PostgreSQL + Redis, plus an SSO provider or SMTP for login |

Where Inkling is weaker: it needs PostgreSQL (no SQLite mode), there are no native desktop or
mobile apps (the web app installs as a PWA), it runs as a single instance (no horizontal
scaling), and it is a young project with a small user base.

## Architecture

- **Server** (`apps/server`): Node 22, Fastify 5 (REST under `/api`), Hocuspocus/Yjs WebSocket
  collaboration on `/collab`, Drizzle ORM on PostgreSQL 16 (trigram search, migrations applied at
  boot), the MCP endpoint at `/mcp` with its OAuth server
- **Web** (`apps/web`): React 19, Vite, Tailwind CSS v4, BlockNote (ProseMirror) editor, React Flow
  canvas, d3-force graph, installable PWA
- **CLI** (`apps/cli`): `inklingctl` for vault sync
- **Shared** (`packages/shared`): zod schemas and DTOs used by both server and web; the query
  language parser
- **Deploy** (`deploy/`): Caddy overlay, backup sidecar scripts, restore and admin helper scripts

Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Decisions and their reasons are
recorded as ADRs in [docs/adr/](docs/adr/README.md). The REST contract is in [docs/API.md](docs/API.md).

## Security

Inkling is designed for a single self-hosted instance shared by people who trust each other within
a workspace. Before exposing it to the internet:

- **Run it behind HTTPS.** Use `deploy/compose.caddy.yaml` (it also hides the app and database
  ports), or terminate TLS in your own proxy.
- **Set `PUBLIC_URL`** (and `APP_URL` if mail links should use a different origin). Links in
  password-reset and verification emails, OAuth metadata and share previews are built from it, and
  an `https://` value turns on Secure session cookies automatically.
- **Keep signup keys required** (the production default) and create the first admin's key with
  `./deploy/signup-key.sh`.
- **Change `POSTGRES_PASSWORD`** and set `BACKUP_PASSPHRASE` (store it off the server).
- Keep `TRUST_PROXY` limited to your actual reverse proxy.
- Experimental features (`plugins`, `vault-sync`, `sheets-sync`) are off by default. Plugins run
  sandboxed but are trusted once an admin approves them.

Workspace members can read and edit all shared pages in that workspace; private pages are visible
only to their author. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known issues

Open problems that did not block the first public release, grouped by area and severity:
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md). Planned work: [docs/ROADMAP.md](docs/ROADMAP.md).

## Built with AI assistance

Inkling was designed and implemented with heavy use of AI coding agents. The code then went through
several rounds of review aimed at the places where generated code tends to be wrong: concurrency
(races, lost updates, locking), resource use (memory, connections, unbounded growth) and security,
followed by performance work driven by measurements rather than guesses. The decisions and
trade-offs that came out of this are written up in [docs/adr/](docs/adr/README.md), and what is
still unresolved is listed in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md). Review it with the same
care you would give any young project before trusting it with important data.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; larger
changes are easier to land after a short discussion in an issue.

## License

[MIT](LICENSE). Every feature in this repository is free; there is no paid edition.
