# 1151. Write gate on comments and document edits; fresh role after waiting at the gate

- Status: Accepted
- Date: 2026-11-07
- Amends: [1071](1071-workspace-access-version-and-write-gate.md) (what is gated, gate statement)

## Context
ADR 1071 gated page PATCH and row PATCH: they read the workspace's `workspace_acl_versions` row
`FOR SHARE` in their transaction, so a lock change, agent block, move or member change either
commits before the write's check or waits for the write. Comments (POST, PATCH) and document edits
(update_page → `POST /pages/:id/content`, patch_section → `POST /pages/:id/section`) checked with a
version read at check time and wrote later; a lock change or a member removal could commit in
between and the write still landed (ADR 1071, Consequences).

Document edits are not SQL writes: they go through a Hocuspocus `DirectConnection` (load the
document, `transact`, store hook). `openDirectConnection` loads through the pool and
`conn.transact` awaits the store hooks, which write through the pool as well. A gate transaction
that stayed open across either would hold one of the 10 pool connections while waiting for another:
enough concurrent edits and every connection waits for a store that needs one.

While adding the tests a second problem showed up in the gate statement itself. It reads the role
with a join (`LEFT JOIN workspace_members`). When the statement waits for a bumper (member removal,
role change) and then locks the row, READ COMMITTED re-checks the locked row at its new version but
keeps the joined member row from the statement's snapshot: the role is the one before the removal.
Page PATCH by a member being removed waited for the removal and then succeeded.

## Decision
**Comments.** `POST /pages/:id/comments` and `PATCH /comments/:id` write in ONE statement that
starts with the gate (`gatedWriteSql`): CTE `gate` takes the row `FOR SHARE`, `gate_ok` has a row
only while the version and role are those the request checked (`requireMembershipAcl` +
`assertPageCommentable`), and the comment insert or update (and, for POST, its outbox rows, ADR
1150) selects from `gate_ok`. When they changed, nothing is written and the request re-checks
membership, agent block and the comment bit under `gateWrite` in a transaction and writes there.
No extra statement on the common path. DELETE (author or manager moderation) is unchanged.

**Document edits.** Order: open the document (load) → short transaction { `gateWrite`; if version
or role changed, re-check agent block and edit lock on the transaction's connection; apply the edit
to the in-memory document synchronously } → commit → the store runs and is awaited after the commit
(`underWriteGate`, `docWriteGate.ts`, `gatedTransact` in `md/docWrite.ts`). `DirectConnection`
applies the edit synchronously when `transact` is called, so the apply happens inside the gate and
the store promise is awaited outside it. The gate transaction never waits for the pool. Gated:
update_page (replace and append) and patch_section. Cost: BEGIN, the gate statement, COMMIT per
edit; measured on update_page append (docs/PERFORMANCE.md, Regressions): 1 client p50 +0.7–0.8 ms
(+4%), 16 clients +3%.

**Fresh role after a wait.** The gate statement also returns the version as of its own snapshot
(`snapVersion`, a subquery). Equal to the locked row's version: nothing committed in between, the
role is current. Different: the statement waited for (or raced with) a bumper; `gateWrite` reads
again in a new statement — the share lock is already held, so it does not wait, and its snapshot
includes the bumper's commit. No extra statement unless an access change happened at that moment.
This also fixes page PATCH and row PATCH.

## Alternatives considered
- **Keep the gate transaction open across the whole document edit** (load, apply, store): simplest
  code, and the lock change would wait for the store too; rejected for the pool deadlock above.
- **In-process RW lock per workspace for Yjs edits** (ADR 1071 kept it as the option): no round
  trip, but single-instance only and a second mechanism next to the SQL gate.
- **Re-check after the edit and undo it:** a Yjs edit is already broadcast to open editors when
  `transact` returns; undoing it is visible and races with people typing.
- **Read the role in a second statement every time** (instead of `snapVersion`): one more round
  trip on every gated write for a case that needs an access change at the same millisecond.

## Consequences
- A comment, a comment edit, update_page or patch_section that reaches the gate while a lock change,
  agent block, move or member removal is in progress waits for it and is decided on its result;
  one that is under the gate makes the access change wait (at most the in-memory apply for document
  edits). Tests: `apps/server/src/outboxTx.db.test.ts` (member removal during comment POST/PATCH →
  403, nothing written; lock change during append and patch_section → 403 PAGE_LOCKED, document
  untouched; page PATCH during a member removal → 403, which failed before the `snapVersion` check).
- Still not gated (non-transactional, unchanged): tasks quick add, ink, sync, snapshot restore,
  people typing in the editor (Hocuspocus connections check on connect, ADR 0970), comment DELETE.
- The "Before AI edit" snapshot of a replace is taken before the gate; a refused replace leaves that
  snapshot behind (it equals the current document).
- The re-check under the gate may record the agent's first access in the workspace through the pool
  (`assertAgentAllowed` touch); it ran once already in the same request's pre-check, so this happens
  only after a cache eviction in between.

## References
- apps/server/src/aclVersion.ts (`gateSelectSql`, `gateWrite`, `gatedWriteSql`, `underWriteGate`),
  apps/server/src/docWriteGate.ts, apps/server/src/md/docWrite.ts (`gatedTransact`)
- apps/server/src/routes/comments.ts, apps/server/src/routes/pageContent.ts, apps/server/src/routes/context.ts
- apps/server/src/outboxTx.db.test.ts, apps/server/src/aclVersion.db.test.ts
- PostgreSQL 16 docs, 13.2.1 Read Committed Isolation Level (re-check of locked rows, other rows from
  the snapshot)
