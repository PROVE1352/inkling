# 0950. Export policy and per-workspace trash retention

- Status: Accepted
- Date: 2026-11-07

## Context
Any member could download the whole-workspace zip; the trash was purged after a fixed 30 days
(`TRASH_TTL_MS` in housekeeping).

## Decision
- `workspaces.export_policy` ∈ `owners | admins | members`, default `members` (unchanged
  behaviour). Gates `GET /workspaces/:id/export` only (apps/server/src/routes/exportImport.ts:172).
  Per-page exports (`/pages/:id/export`) stay open to members: `read_page` and the editor's own
  export use them, and they cover one visible page.
- `workspaces.trash_retention_days` 7–365, default 30. The hourly purge joins workspaces and uses
  `deleted_at < now − make_interval(days => trash_retention_days)` per workspace
  (apps/server/src/housekeeping.ts:56). The MCP `trash_page` text and the leave dialogs now say
  "the trash retention period of its workspace (30 days by default)".
- Downloads are audited (`export.downloaded`, docs/adr/0946-*).

## Alternatives considered
- Gate per-page export too: breaks MCP reads for members and protects little (members can read
  and copy any page they see).
- Server-wide env for trash retention: workspaces in one instance differ.

## Trade-offs
- Lowering retention purges older trash at the next hourly tick; the UI explains it, there is no
  extra confirmation.

## How others solve it
- Notion: disable workspace export for members and trash retention control are Enterprise
  features. https://www.notion.com/help/workspace-settings
- Google Drive: trash kept 30 days, not configurable per drive.

## Consequences
- `injected` requests (MCP, tests) no longer crash the export route on the socket timeout call.

## References
- apps/server/src/routes/exportImport.ts:96, :172
- apps/server/src/housekeeping.ts:56
