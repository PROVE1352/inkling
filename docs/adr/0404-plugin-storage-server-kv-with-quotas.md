# 0404. Plugin storage: server-side KV per plugin and user, with quotas

- Status: Accepted (experimental `plugins`)
- Date: 2026-11-07

## Context
Plugins need small persistent settings/state. They have no browser storage (opaque origin), and
state should follow the user across devices without leaking between users or plugins.

## Decision
Table `plugin_storage(plugin_id, user_id, key, value text, bytes int, updated_at)` with primary key
`(plugin_id, user_id, key)` (also serves the quota aggregate) and `ON DELETE CASCADE` on the user.
Both ids come from the server (route param checked against the active-plugin list, session user),
never from the plugin. Limits: key `^[A-Za-z0-9_.:-]{1,128}$`, value ≤ 64 KB of JSON, ≤ 500 keys
and ≤ 1 MB per plugin per user. Writes run in a transaction with a per-(plugin,user) advisory lock
so concurrent writes cannot race past the quota. Removing a plugin in the admin screen deletes all
its rows.

## Alternatives considered
- **jsonb column**: no query need for v0; text keeps the exact bytes and makes the size check exact.
- **Per-workspace storage**: useful later; per-user is the safest default (no cross-user channel).

## Trade-offs
1 MB × users × plugins worst case; quota is per plugin per user, not global.

## How others solve it
Browser extensions get `storage.sync` with per-item and total quotas; Figma's `clientStorage` is
per-plugin per-user with a size cap.

## Consequences
Plugin data is part of normal DB backups and is deleted with the user.

## References
- apps/server/src/db/schema-plugins.ts (`pluginStorage`)
- apps/server/src/plugins/storage.ts:12 (limits), :67 (`storageSet`)
- apps/server/src/plugins/routes.ts:360-389 (storage routes)
