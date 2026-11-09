# 1624. Reverting one change or an agent's run: scopes, preview, permissions

- Status: Accepted
- Date: 2026-11-10

## Decision
- Routes (people only; an agent connection gets 403 PEOPLE_DECIDE; every route has `dryRun`):
  `POST /changes/:seq/revert`, `POST /pages/:id/revert {seqs | via, actorId?, since?, until?}`,
  `POST /workspaces/:id/revert {via, actorId?, since, until?}` (owners and admins).
  `GET /pages/:id/changes` lists a page's own log with revert facts (right panel).
- An agent is its client name (`via`), optionally narrowed to the member whose connection it was.
- Changes are taken newest first and applied one by one on the simulated page, so a later agent
  edit of the same section is undone before an earlier one. At most 300 changes per call
  (`truncated` says to run again).
- Each page: edit access as the person (lock, page access), then one batch write; typing between
  the plan and the write moves a version, the page is planned again once, then `REVERT_CHANGED`.
  A page that fails is reported; the others go on.
- The preview and the result have the same shape: per page, per change `applied | partial |
  conflict | noop | unsupported`, conflicts with the text there now, `plainText` counts.
- No MCP tool: reverting is a person's decision. Agents see reverts in `changes_since`/`catch_up` as
  the person's edits (ADR 1623).

## References
- apps/server/src/routes/revert.ts, apps/web/src/components/RevertDialog.tsx, PageChanges.tsx
