# Changelog

All notable changes to Inkling. Versions follow [Semantic Versioning](https://semver.org/); while the
version is `0.x`, minor releases may change APIs, MCP tools and the database schema (migrations run
automatically on boot). Design decisions are in [`docs/adr/`](docs/adr/README.md); open problems in
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## [0.2.0] - 2026-11-07

Database migrations 0028–0030 are applied on first boot. Take a backup before upgrading
([docs/BACKUP.md](docs/BACKUP.md)).

### Agents (MCP)
- `find_context`: section-level retrieval that packs the most relevant sections into a token budget,
  instead of searching and reading whole pages. On a 5,000-page benchmark: about 72% fewer tokens per
  question, one call instead of ~3.7, and the right section included 93% of the time (was 75%).
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
