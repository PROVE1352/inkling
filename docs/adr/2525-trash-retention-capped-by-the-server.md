# 2525. Trash retention capped by the server (LIMIT_TRASH_DAYS)

- Status: Accepted
- Date: 2026-11-12

## Context
Each workspace chooses how long trashed pages stay (`trash_retention_days`, 7–365, default 30). A public
demo promises in its privacy policy that trashed pages are gone after 7 days, and an owner could raise
the setting to keep them a year. The operator needs a ceiling, not a new default: an install without the
setting must purge exactly what 0.21.1 purged.

## Decision
- `LIMIT_TRASH_DAYS` (integer ≥ 7, the shortest retention a workspace can pick) in `limits.ts`. Unset or
  empty: absent from `limits` (no key), and the hourly purge runs the 0.21.1 query unchanged.
- Effective retention = min(workspace setting, cap): the purge's interval becomes
  `LEAST(trash_retention_days, cap)`, and the MCP `list_trash` "deleted for good after" date uses the same
  rule (`effectiveTrashDays`).
- The stored workspace value is not rewritten. `PATCH /workspaces/:id/settings` refuses a larger value with
  400 `LIMIT_TRASH_DAYS` (`{ limit }`); other settings still save while the stored value is above the cap.
  `/auth/mode` sends `limits.trashDays`; the settings screen shows min(stored, cap), takes nothing above the
  cap and says the server's ceiling.

## Consequences
- A test compares, on the same rows, what the purge deletes with what the 0.21.1 query selects (no setting),
  and checks that the cap wins over a longer setting and a shorter setting wins over the cap.
- Deleted workspaces keep their own window (`WORKSPACE_RESTORE_DAYS`); the demo sets both to 7.
