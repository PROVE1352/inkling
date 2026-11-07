# Changelog

All notable changes to Inkling. Versions follow [Semantic Versioning](https://semver.org/); while the
version is `0.x`, minor releases may change APIs, MCP tools and the database schema (migrations run
automatically on boot). Design decisions are in [`docs/adr/`](docs/adr/README.md); open problems in
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## [Unreleased]

## [0.3.1] - 2026-11-07

Database migration 0033 (adds `users.sidebar_prefs`) is applied on first boot. Take a backup before upgrading.

- Sidebar menus (docs/adr/1020-*): choose which of Search, Graph, Tags, Web shares, Due, Calendar, Activity and Today
  appear at the top of the sidebar and in what order, in Settings → Sidebar (toggle, drag or ↑/↓, "Reset to
  default"), or right-click / long-press a menu → "Hide from sidebar". Saved to your account, so all your devices
  match; hidden menus still open from the ⌘P palette (which gains Calendar and Activity) and their shortcuts.

## [0.3.0] - 2026-11-07

Database migrations 0031 (notifications) and 0032 (drops the unused `pages.is_template` column) are applied on
first boot. Pages still flagged as legacy templates, if any, become normal pages (docs/adr/0920-*). Take a backup
before upgrading ([docs/BACKUP.md](docs/BACKUP.md)).

- Notifications (docs/adr/1000–1004): body @mentions now notify (people's right away; mentions an agent writes
  arrive quietly and in the digest), plus replies in your threads, document owner and person-cell assignment, and
  edits of pages you follow. Repeats collapse into one item per page or thread; hourly caps; only people who can see
  the page are notified.
- Subscriptions per page or subtree: all / mentions (default) / nothing / mute, "Follow", and a daily summary when AI
  edits under a page. Mute also silences mentions; only approval requests addressed to you will pass it.
- Mail: instant mail for mentions, replies and assignments (cancelled when read in the app first) and a daily or
  weekly digest, with per-user settings in Settings → Notifications (en/ko). Servers without SMTP keep everything in
  the app. Webhooks gain `assigned` and a daily `agent_digest`.
- Activity screen: people's and AI changes newest first with filters (people/AI/client/member/subtree/kind/AI-created
  pages) and a diff per change; version history can compare a snapshot with the current page; pages show "Written by
  AI · last AI edit".
- MCP: `inbox` / `ack` (agent inbox with a cursor), `list_comments`, `reply_comment`, `resolve_comment`, and
  `add_comment(section)`. Agents can resolve only threads their person started. `create_page`, `import_folder` and
  `create_from_template` now record the client (`via`) on the created pages.
- Locked pages: canvas nodes, collection cells and the properties panel are read-only in the UI too.
- OAuth client names: a client named like a member is refused only in the workspaces where that member is (exact
  match), and common app names such as Claude only get a warning on the consent screen (docs/adr/1007-*).

- Math (KaTeX, docs/adr/0995–0999): display equations ("Math block") and inline equations. Click one to edit its
  LaTeX with a live preview; create them from the slash menu ("Math"/"수식"), with ⌘/Ctrl+Shift+E, or by typing
  `$x^2$` (prices like `$5 and $10` stay text). Errors show the source and KaTeX's message; links, images, HTML
  and macro definitions are refused. Rendered in the browser only (cached, time-sliced, paced per frame), in both
  themes, on phones, on public share pages and in PDF/print. KaTeX and its fonts load only on pages with math.
- Markdown and MCP: math is `$$ … $$` (block) and `$…$` (inline) in export, `read_page`/`find_context` output and
  `update_page`/`patch_section`/import input ([docs/MCP.md](docs/MCP.md)); the server keeps math nodes when it reads
  a document. Notion import now brings equations (and LaTeX code blocks) in as math instead of code. Existing
  ```` ```latex ```` code blocks are not converted.
- Jumping to a block (from the calendar, comments or `?block=`) now stays on the block while the page above it is
  still rendering, instead of landing far away on long pages (docs/adr/0998-*).
- Docs: performance log ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

### Fixed
- Security: the prompt-injection URL rules backtracked on crafted text (cubic time). 20 KB of text such as
  `http://?` repeated took up to 19.5 s to index and blocked the server meanwhile; it now takes under 1 ms
  (180 KB: about 3 ms). Detection is unchanged ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

## [0.2.0] - 2026-11-07

Database migrations 0028–0030 are applied on first boot. Take a backup before upgrading
([docs/BACKUP.md](docs/BACKUP.md)).

### Agents (MCP)
- `find_context`: section-level retrieval that packs the most relevant sections into a token budget,
  instead of searching and reading whole pages. On a 5,000-page benchmark: about 72% fewer tokens per
  question, one call instead of ~3.7, and the expected answer was in the returned context for 93% of
  questions (the old search-then-read flow: 75%).
  Benchmark script: `apps/server/scripts/context-bench.ts`.
- `read_page` gained `outline`, `section` and `maxChars`; new `read_pages` for batch reads.
- `changes_since`: cursor-based change feed with line diffs, so an agent can update its own notes
  incrementally.
- `patch_section`: edit one section with a version check. It applies a minimal edit (block alignment
  and character diff), so a person typing in the same section at the same time keeps their text.
- Collection tools: `query_rows` (filters, sort, fields, paging), `create_row`, `update_row`.
- `get_instructions` and agent instruction pages (always / path match / manual). Only locked pages can
  be instruction pages.
- OAuth `read` / `write` scopes; read-only connections cannot write.
- Writes made through an agent are recorded as "via <client>" in history, comments and the change feed.
- Tool output is deterministic and ordered for prompt caching.
- User-written content in tool output is wrapped as untrusted data, invisible characters are removed,
  and injection-like text is flagged. This is a mitigation, not a security boundary.
- `AGENTS.md`, `llms.txt` and [docs/MCP.md](docs/MCP.md) describe how agents should use the server.

### Collaboration
- Edit lock for a page and everything under it: choose who can edit, and separately whether agents can
  edit, comment or only read. Enforced on every write path, including live editing.
- Workspace settings screen: general, members, public links, connected agents, audit log, review,
  Slack & Discord, danger zone. New `admin` role.
- Connected agents per workspace, with workspace-level blocking.
- Append-only audit log for admin actions, written in the same transaction as the action.
- Member-add policy (default: owners and admins) and an invite-link switch.
- Workspace-wide switch to disable public web pages, with bulk unpublish.
- Export policy and configurable trash retention.
- Page owners, review dates and a daily review priority (reads x probability of being stale), with
  living-document and archive-candidate lists and a `review_due` webhook digest.

### Import
- Notion "Markdown & CSV" export zips, including nested part zips: hierarchy without hash suffixes,
  internal links, attachments, CSV databases with typed columns and relations, and an import report.
- Import size limits are configurable with environment variables.

### Updates
- The server sends its build id on every API response; open tabs show a "new version" banner on every
  screen. `UPDATE_MODE=force` reloads automatically once edits are synced.
- Optional check for newer GitHub releases on the admin page (`UPDATE_CHECK=github`, off by default).

### Fixed
- Reading a live document on the server deleted blocks the server schema does not know (callouts,
  page embeds, @mentions). Affected quick task add, MCP `update_page` append and vault-sync snapshots.
  `update_page` append now only adds blocks at the end.
- The "new version" prompt could disappear without updating when a newer deploy arrived first, and was
  not shown outside the main layout.
- Any member could change a page's owner.
- Agent client names that imitate the product, an admin or a workspace member are rejected.

## [0.1.0] - 2026-11-07

First public release.
