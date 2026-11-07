# 0401. Plugin installation: operator-only, approval pinned to a content hash

- Status: Accepted (experimental `plugins`)
- Date: 2026-11-07

## Context
Whoever controls which plugin code is served controls code running in every user's browser.
v0 must make that a deliberate, auditable administrator action, and must not let an approved
plugin change its code or permissions silently.

## Decision
Plugins are directories under `PLUGINS_DIR` (default `DATA_DIR/plugins`) containing
`manifest.json` and one entry bundle. There is no upload/install API. The server scans the
directory (directory name must equal the manifest id; symlinks refused; entry confined to the
directory; size caps), validates the manifest with a strict schema, and computes
`sha256(manifest ‖ 0x00 ‖ entry)`. An administrator approves a specific hash and a subset of the
requested permissions (`plugin_installs`). A plugin is *active* only if enabled **and** its current
hash equals the approved hash; otherwise it is not listed, not served (frame/bundle URLs contain the
hash and 404) and its RPC routes 404. The approve call must echo the hash the admin reviewed
(409 if files changed meanwhile). The bytes that were hashed are the bytes served (kept in memory).

## Alternatives considered
- **User-uploaded plugins**: convenient, but turns every account into a code-deployment channel.
- **Approval by id/version only**: a file swap or a manifest edit adding `write:pages` would take
  effect without review.
- **Signed plugins / registry**: right for a public ecosystem, premature for v0 self-hosting.

## Trade-offs
Updating a plugin always requires re-approval (intended). The admin list re-hashes files on each
view (≤ 50 dirs × ≤ 1 MB); user-facing reads use a 5 s cache.

## How others solve it
WordPress and Grafana let administrators install plugins; Grafana additionally refuses unsigned
plugins unless allow-listed. Browser extension stores re-prompt when an update requests new
permissions — the hash pin is the self-hosted equivalent.

## Consequences
The admin screen is the single place where plugin trust is granted, with audit fields
(`approved_by`, `approved_at`, `approved_version`) and server log lines.

## References
- apps/server/src/plugins/registry.ts:53 (`loadPluginDir`), :94 (`scanPluginsDir`)
- apps/server/src/plugins/manifest.ts:67 (`manifestSchema`), :132 (`parseManifest`)
- apps/server/src/plugins/routes.ts:69 (`isActive`), :223 (approve), :258 (disable), :271 (remove)
- apps/server/src/db/schema-plugins.ts (`plugin_installs`)
