# 1005. Activity screen, version diffs and created-via provenance

- Status: Accepted
- Date: 2026-11-07

## Context
The change log (`page_changes`, ADR 0932) already records who changed which section, including the
agent client, but only agents could read it (`changes_since`). People need "what did the AI change
here", diffs in the history, and to tell AI-written pages apart. Pages created through MCP had no
`via` (KNOWN-ISSUES AGENT-E5).

## Decision
- `GET /workspaces/:id/activity`: newest first, `before`/`limit` paging, filters actor (any / human /
  ai), one client, one member, a subtree, kind (section edits vs page events) and "AI-created pages
  only". Permission rule = the change feed's: live membership, the row's visibility when logged,
  titles only for pages visible now.
- `GET /changes/:seq/diff`: before/after and a line diff (the feed's Myers diff, ADR 0933); the page
  must be visible now.
- `GET /pages/:id/snapshots/:sid/diff?against=current|<sid>`: Markdown of two versions diffed.
- `pages.created_via`: set from `user.via` on `POST /pages`; bulk creators (Markdown import,
  import-folder, templates) mark their pages and their `page_added` rows after the import. A
  `page_added` logged without an in-flight writer falls back to the page's creator and `created_via`.
- `GET /pages/:id/provenance`: "written by AI (via X)" and "last AI edit" (latest `page_changes` row
  with a client; new index `page_changes (page_id, seq)`). Relative dates only in the UI.

## Alternatives considered
- Reusing `changes_since` output in the browser: budget-packed text for agents, wrong shape for a
  scrollable list.
- A `created_by_agent` boolean: loses which client.

## Trade-offs
- Live typing still has no per-change author (CF-2); those rows show no "by".
- Activity rows are kept for CHANGE_FEED_RETENTION_DAYS like the feed.

## References
- apps/server/src/routes/activity.ts, notify/provenance.ts, context/changeLog.ts
