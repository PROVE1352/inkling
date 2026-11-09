# 1522. The "last catch_up" marker lives in plugin_storage under a reserved id

- Status: Superseded by [ADR 1537](1537-catch-up-markers-table.md) (0.12, migration 0041)
- Date: 2026-11-09

## Context
`catch_up` without `since` should continue where this connection (or else the person) last caught
up. That needs a small per-connection value. This wave allows one schema change, owned by another
area; a new table or column for the marker is not available now.

## Decision
- Store the marker as a JSON value (`{"cursor": "<catch_up cursor>", "seq": …, "at": …}`) in `plugin_storage` with the
  reserved plugin id `inkling:catch_up`. Plugin manifest ids match `^[a-z0-9][a-z0-9-]{1,63}$`, so no
  plugin can read or write it, and plugin quotas count per (plugin, user), so it costs a plugin
  nothing. Rows cascade with the user.
- Keys: `grant:<id>` or `token:<id>` for the connection, plus `:<workspaceId>` when the call was
  limited to a workspace; `person` (and `person:<workspaceId>`) is updated on every call and is the
  start for a connection that has none yet. Browser sessions write only `person`.
- The marker is the end of the window just shown (the change-log seq reserved at the start of the
  call and the database time), written after the answer is built and never moved backwards (a
  slower concurrent call that started earlier does not overwrite a newer marker). `peek=true`
  (`advance=0`) leaves it.
- Read-only tokens move their marker too, from a GET: it is connection bookkeeping like
  `oauth_grants.last_used_at`, not notes and not the inbox acknowledgement.

## Alternatives considered
- **A `catch_up_markers` table or a column on `oauth_grants`**: the right shape; a schema change, so
  left for a wave that owns migrations (the data moves with one `INSERT … SELECT`).
- **Stateless only** (the agent stores `next since`): works and is supported, but "continue from last
  time" is the main use and many agents keep no state between sessions.
- **In-memory map**: lost on restart and wrong with more than one server process.

## Consequences
- A plugin admin or storage listing never shows these rows (the plugin storage routes take the plugin
  id from the approved list).
- Revoking a connection leaves its marker until the account is deleted (a few bytes per
  connection); the person marker is what a new connection starts from anyway.

## References
- apps/server/src/catchUp.ts (`storeMarker`, `readMarker`), apps/server/src/plugins/storage.ts
