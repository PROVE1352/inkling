# 0811. Authorization leak fixes (C-L11, C-L12)

- Status: Accepted
- Date: 2026-11-07

- Public file routes also require the file's own page (if any) to be live and shared.
- Query `FROM [[title]]` resolves only targets visible to the viewer.
- Templates get `scope` (migration 0025): saved from a private page → listed/usable by the creator only; delete by creator or workspace owner. Older templates stay shared.
- Person cells: writes referencing non-members → 400; name lookups (rollups, export) only resolve workspace members.
- Notifications are shown only while the recipient is a member of the page's workspace; new comment/reminder notifications carry `workspace_id`.
- Notion upload (instance-wide token): owner-only for real uploads, 10/min.
- Webhook management: workspace owners only (site admins no longer bypass), matching the web menu.
