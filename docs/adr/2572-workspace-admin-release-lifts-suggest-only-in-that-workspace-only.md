# 2572. A workspace admin's release lifts suggest-only in that workspace only

- Status: Accepted
- Date: 2026-11-26
- Amends: ADR 2042

## Context
ADR 2042 lets a workspace owner/admin lift the sources that are in their workspace, and a lifted
source no longer makes the connection suggest-only anywhere. The 0.25.3 review (C-mcp L1) found the
case 2042 did not look at: the admin of the source workspace is the attacker. A member who shares one
workspace with the victim can create a workspace, add the victim, plant flagged text there, let the
victim's agent read it, and lift it as that workspace's owner. The connection is then a normal one in
every other workspace again, and the same text does not taint it again (the release is remembered
with the fingerprint).

## Decision
- A release counts **everywhere** only when the connection's owner made it (`released_by` = the user of
  the grant or token). A release by anyone else — a workspace owner/admin — lifts the source **only
  inside its own workspace** (`connection_taints.workspace_id`). `demotionFor`, `suggestOnlyStates`
  apply the same rule per row. No new column: `released_by` and the connection key already say who.
- Reading the same flagged content again after such a release restarts the window for the other
  workspaces (the row keeps its release, `tainted_at` moves). A release by the owner is remembered as
  before.
- The owner's release (`POST /connections/release`, or the workspace route by the owner) also takes
  over earlier admin releases, so those sources are lifted everywhere too; `released` counts them.

## Alternatives considered
- **Only the connection's owner may release**: an admin could no longer clear a false positive in
  their own workspace; the board and the review queue would fill with waits that only one person can end.
- **A `released_scope` column**: the same information as `released_by` vs the owner, plus a migration.
- **Release per (source, workspace) rows**: a release table keyed by workspace; more state for the
  same answer.

## Consequences
- An admin who lifts a connection that read flagged text in their workspace sees it direct there; the
  team agents board of another workspace still shows it suggest-only until its owner lifts it or the
  window ends.
- The owner's release returns a larger `released` when it takes over admin releases (audit
  `agent.taint_released` with scope `all` for those sources).

## References
- apps/server/src/agentTaint.ts (`countsSql`, `noteSource`, `suggestOnlyStates`, `releaseTaints`)
- apps/server/src/mcpTools/sec26d.db.test.ts (L1), apps/server/src/agentTaint.db.test.ts
