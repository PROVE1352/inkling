# 1530. Suggestions are section rows until a person decides

- Status: Accepted
- Date: 2026-11-09

## Context
Teams asked to let an agent work on a page while a person keeps the last word: see what the agent
wants to change, against the text as it is now, and keep it or not. Until now `patch_section` either
wrote or (on a version conflict) wrote nothing and returned the current text. Nothing kept an
agent's change for later.

## Decision
- A suggestion is a row in `section_suggestions`, one per section: page, section anchor (`''` = the
  whole body, for `update_page`), heading block id, heading path, base version (the `v=` the agent
  read, else the version when it suggested), the agent's Markdown exactly as sent (agent notation,
  ADR 1500), the mode it meant (`replace`, `append`, `prepend`, `insert_after`, `delete`,
  `page_replace`, `page_append`), why it is a suggestion (`asked` / `lock`), author, client name
  (`via`), connection (`grant:<id>` / `token:<id>`), status and decision (who, when).
- Status: `open` → `accepted` | `rejected` (a person) | `withdrawn` (the author) | `superseded`.
  A new suggestion of the same author connection for the same section supersedes the open one; a
  partial unique index (`page_id, anchor, author_id, connection WHERE status = 'open'`) keeps at
  most one open row per author connection and section.
- The document is not touched until a person accepts (ADR 1533). Suggestions are checked for
  convertibility (`markdownToBlocks` + a throwaway Yjs doc) when they are made, like a direct write.
- Reading follows the page: visible page, membership (2FA, agent blocks), the connection's range.
  Guests are not shown suggestions in this version. At most 100 open suggestions per page.
- The web view gets the open suggestions of a page with a preview: the section as Markdown now,
  the section with the suggestion applied, and the line diff (`context/diff.ts`, the activity
  view's `DiffOpDTO`).

## Alternatives considered
- **Suggestions as comments with a diff in the text**: no state, no accept button, and the agent's
  Markdown would be member text inside a comment thread.
- **A copy of the page ("branch")**: heavier than the need (one section at a time) and merging back
  is the hard part again.
- **Yjs-level suggestion marks inside the live document**: every editor would need to understand
  them, and the read-only paths (export, MCP reads) would have to strip them.

## Consequences
- A suggestion whose section was deleted can only be rejected (accept answers `SECTION_GONE`).
- Partial acceptance (per hunk) is the next step: the preview already has the edit script; the
  apply path would take a subset of hunks and rebuild the Markdown.

## References
- apps/server/src/suggestions.ts, apps/server/src/db/schema-collab.ts,
  apps/server/drizzle/0041_v012_suggestions_leases.sql, apps/server/src/routes/suggestions.ts
