# 0946. Workspace audit log: same-transaction, append-only, no IP

- Status: Accepted
- Date: 2026-11-07

## Context
With admins and agents acting on a workspace, owners need to answer "who removed Bob, who turned
public sharing back on, which agent was blocked". Content edits already have an audit trail
(`page_changes` with actor and `via_client`, snapshots; docs/adr/0932-*, 0936-*). Administrative
actions had none.

## Decision
- Table `workspace_audit_events` (apps/server/src/db/schema-workspaceAdmin.ts:23): `id bigserial`,
  `workspace_id` (cascade), `actor_id` (set null) + `actor_name` snapshot, `via_client`, `action`,
  `target_type/target_id/target_label`, `before`/`after` jsonb (changed fields only), `created_at`.
  Indexes `(workspace_id, id)` for cursor pages, `(workspace_id, action, id)` for filters,
  `(created_at)` for the purge.
- `recordAudit(tx, …)` (apps/server/src/workspaceAdmin.ts:131) is called with the transaction that
  performs the action, so an event exists exactly when the action committed. Routes that used to
  write without a transaction (rename, invite regenerate, share on/off, webhook CRUD, join) now
  use one. Exception: the zip export is a streamed GET; its event is written just before the
  stream starts (apps/server/src/routes/exportImport.ts:172).
- Actions (`AUDIT_ACTIONS`, packages/shared/src/workspaceAdmin.ts): member added / joined / removed
  / left / role changed, invite regenerated, share published / unpublished, export downloaded,
  workspace updated / deleted / restored / transferred, agent blocked / unblocked, settings
  updated, webhook created / updated / deleted. Invite link on/off and policy changes are
  `settings.updated` with before/after.
- Not logged: page content (link to history and the change feed in the UI), reads, account-level
  actions done by a server admin (they are not workspace actions).
- Append-only in code: no route updates or deletes rows; only the retention purge deletes.
- Retention per workspace (`audit_retention_days`, 30–730, default 90), purged hourly in bounded
  batches (apps/server/src/housekeeping.ts:21).
- Read: `GET /workspaces/:id/audit?action=&actorId=&cursor=&limit=` for owners and admins.
- **No IP address.** The actor is an authenticated member; storing IPs adds personal data with
  its own retention duty to every row, while the reverse proxy logs already hold request IPs
  for incident work. Webhook URLs are logged masked; private page titles are not written for
  other people's private pages.

## Alternatives considered
- Reuse `page_changes`: its rows need page visibility fields and are pruned with the change-feed
  window (30 days); administrative events are workspace-scoped and kept longer.
- A DB trigger forbidding UPDATE: not tracked by drizzle snapshots, lost on `drizzle-kit push` in
  local dev; code-level append-only is enough for a self-hosted single tenant whose DBA can
  edit any table anyway.
- Write after commit (outbox): an event can then be lost or exist for a rolled-back action.

## Trade-offs
- `actor_name` is a snapshot: renamed users show their old name on old events.
- Export events can exist for a download that failed mid-stream.

## How others solve it
- Notion audit log (Enterprise): workspace, page, user and integration events, IP and
  location, CSV export, 365 days. https://www.notion.com/help/audit-log
- GitHub organization audit log: actor, action, `actor_ip` optional (off by default for orgs).
- Slack audit logs API: actor, action, entity, context; Enterprise Grid only.

## Consequences
- Every administrative route now opens a transaction; the extra insert is one row.
- Tests assert that a failed action leaves no event (apps/server/src/workspaceSettings.db.test.ts).

## References
- apps/server/src/workspaceAdmin.ts:131
- apps/server/src/routes/workspaceAdmin.ts:144
- apps/server/src/housekeeping.ts:21
- apps/server/src/workspaceDeletion.ts (delete/restore/transfer events)
