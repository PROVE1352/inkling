# 2044. upload_file: an agent's file goes through the web upload and the page's write path

- Status: Accepted
- Date: 2026-11-10

## Context
Agents could read attachments (read_file, ADR 1514) but not add one: a chart, a CSV export or a
diagram an agent made had to be pasted as text or described. The upload must keep the web app's
storage and checks, and the agent rules (edit lock, connection range, suggest-only, ADR 2040).

## Decision
- `upload_file(pageId, name, text | base64, section?, attachOnly?)`. The tool builds a multipart
  request and calls `POST /api/files` like the browser does, so storage (`DATA_DIR/uploads/<id>`,
  temp file + rename), the `files` row (`page_id` = the page) and download rules are the web app's.
- For bearer requests (MCP and API tokens) the route now also requires a page, checks that the
  connection may **edit or suggest** on it (`suggestionRight`; a comment-only or read-only lock refuses
  with PAGE_LOCKED), stays inside the connection's range (`findVisiblePage`), refuses suggest-only
  connections (ADR 2040), and types the file itself (ADR 2045).
- The link is written through the page's own write path: `POST /pages/:id/content` (append at the end)
  or `POST /pages/:id/section` (append to `section`), as `![name](/files/<id>)` for images and
  `[name](/files/<id>)` otherwise. So it is an agent edit like any other: in `page_changes` with the
  client name, in changes_since and catch_up, revertable by a person (ADR 1620), a suggestion under a
  "suggestions only" lock or a review policy (the answer says the link was kept as a suggestion).
- `attachOnly: true` stores the file without a link and says so: nobody sees it until a page links
  it, and it is not in the change feed (a `files` row is not a page change).
- The answer is one line per step: what was stored (name, type, size, id, absolute link) and where it
  was linked (§anchor and its new version), or the suggestion.

## Alternatives considered
- **A JSON upload route for agents**: a second storage path to keep in step with the first.
- **Store only, let the agent link it with patch_section**: two calls for every upload, and an
  unlinked file is invisible to people.
- **Allow uploads to suggest-only connections, link as a suggestion**: the file is readable at
  `/files/<id>` by the page's readers before any review.

## Consequences
- Revert removes the link, not the file (files are not garbage-collected; same as a person deleting
  an image block).
- `tools/list` grows by one tool (full profile, ~207 tokens).

## References
- apps/server/src/mcpTools/historyInkFileTools.ts (`upload_file`), apps/server/src/routes/files.ts,
  apps/server/src/mcpTools/uploadFile.db.test.ts
