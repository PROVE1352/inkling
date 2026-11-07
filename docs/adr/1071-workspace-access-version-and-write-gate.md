# 1071. Workspace access version, version-keyed caches and the write gate

- Status: Accepted
- Date: 2026-11-07

## Context
The edit lock (ADR 0970/0971) made every write run a recursive CTE over the page's ancestors, and
often a separate role lookup first, even in workspaces with no lock at all ("no cache", ADR 0970).
Agent requests also ran one `select exists` against `workspace_agent_blocks` per membership check
(ADR 0947) and the instruction query on every page-level tool call (ADR 0975). The CTE itself is
cheap (≈ 0.02 ms); the cost was the round trips: title PATCH 6 → 10 statements, body append 8 → 19,
row edit 8 → 10 between v0.1.0 and v0.2.0 (docs/PERFORMANCE.md).

A plain time-to-live cache over any of this would let a write pass for up to a TTL after an owner
locked the page or blocked the agent. The check and the write were also separate statements, so a
lock change could commit between them even without a cache.

## Decision
**Version.** `workspace_acl_versions(workspace_id, version, locked_pages)` (one row per workspace,
created on first use and at boot). Every change that can alter a write decision bumps `version` in
its own transaction: lock on/off and rules (`applyLockChange`), instruction designation set/remove,
agent block add/remove, page owner change, member role change and removal, and `parent_id` changes
(move, restore to the root, purge moving live children to the root). `locked_pages` is recounted
when `edit_locked` changes and at boot (`reconcileAclVersions`).

**Caches keyed by version, never by time** (the TTL of the LRUs is only a memory bound):
- lock chain per page (`editLock.chainsFor`); without any locked page in the workspace no walk runs
  at all (fast path: `EXISTS` on the partial index `pages_ws_locked_idx`, read in the same statement
  as the version);
- the agent block list per workspace (`agentAccess.isBlocked`);
- "this workspace has instruction designations" (`agentInstructions`; only the negative answer is
  used, rows and titles are always read fresh).
A reader always reads the version first and the data after it, so an entry is never labelled with
a version newer than its content. A transaction that bumped a version never stores what it read
(it sees its own uncommitted state). A denial from a cached chain is re-checked with a fresh walk
before it is reported, so error messages name the current lock node and title changes need no bump.
The version comes with statements requests already run: `requireMembershipAcl` (membership select),
`pageAccess` (replaces `roleForPage` + CTE), the agent-context query (ADR 1070). Plain
`requireMembership` adds only the version, and only for agent requests (the block check); browser
requests keep the old membership statement (read routes measured unchanged).

**Write gate (RW lock on the version row).** Transactional writers read the row `FOR SHARE` before
any page row lock (`gateWrite`, also returning the caller's role); in READ COMMITTED a locked row is
returned at its latest committed version, so `version` and `locked_pages` are fresh even when the
statement waited. Bumpers take the row with an upsert (a row lock that conflicts with FOR SHARE)
right after the page-tree / member advisory locks and before touching any page row, then commit.
So a lock change waits for writes in flight, and a write that starts during a lock change sees it.
Lock order: page-tree advisory → ws-members advisory → acl row → page rows; nothing else reads or
writes this table, so it never meets FK checks, the collab store or review scoring.
Gated today: page PATCH (title, icon, properties, moves; membership is read inside the gate, so the
separate `requireMembership` statement is gone) and row property PATCH (re-checks only when the
version or role changed since the pre-transaction check).

## Alternatives considered
- **Time-based cache (TTL).** Rejected: a write passes for up to the TTL after a block or lock.
- **Counter only, no live check** for "has locks". A purge, cascade or hand-edited row could drift
  the counter to 0 and open every lock; readers use `EXISTS` on a partial index instead and the
  counter only serves the gate, where it is re-read at its latest version.
- **Advisory lock as the gate** (`pg_advisory_xact_lock_shared` + exclusive for bumpers). The
  statement that waits for the lock keeps its old snapshot, so the version read needs a second
  statement: one more round trip per write than the row lock.
- **`FOR SHARE` on the `workspaces` row.** Review scoring, settings and digests update that row and
  FK checks lock it; a dedicated table has no such interactions.
- **In-process RW lock per workspace.** Zero round trips and it would also cover the Yjs writes
  (DirectConnection) that are not SQL transactions; rejected for now because it only holds for a
  single instance and needs request-scoped release machinery. Kept as the option if the Yjs paths
  need the same guarantee.
- **Bump inside `lockTree`.** Creates and imports do not change existing chains; bumping there
  would make long imports hold the version row and make block changes hit `lock_timeout`.

## Consequences
- Writes in a workspace without locks run no lock walk; with locks, one walk per page per version.
- Non-transactional writers (body append and patch_section through DirectConnection, comments,
  tasks, ink, sync, snapshots) check with a version read at check time, as before; they are not
  serialized with lock changes (same window as v0.2.0). `assertPlacement` runs inside the tree lock,
  which already serializes it with lock changes; an agent block landing during a long import is
  not waited for (pre-existing).
- A change to `edit_locked`, overrides, designations, blocks, owners or `parent_id` that bypasses
  these code paths (hand-written SQL) is not seen by cached chains until the next bump or restart;
  `has locks` itself is always live.
- New write paths that change any of the above must call `bumpAcl` in their transaction.

## References
- apps/server/src/aclVersion.ts, apps/server/src/editLock.ts, apps/server/src/agentAccess.ts,
  apps/server/src/agentInstructions.ts, apps/server/src/helpers.ts (`requireMembershipAcl`)
- apps/server/src/aclVersion.db.test.ts (fast path, cache invalidation per change kind, gate in both
  directions, blocks, instructions)
- docs/PERFORMANCE.md (REST write and MCP rows)
