# 0801. Concurrency principles

- Status: Accepted
- Date: 2026-11-07
- Source: audit A summary

1. One-time values, counters and claims change in one conditional statement (`DELETE … RETURNING`, `UPDATE … WHERE used < max RETURNING`, `INSERT … SELECT … WHERE <still valid>`), never check-then-write.
2. Set invariants (no tree cycle, ≥ 1 owner, ≥ 1 admin) are checked and written inside a transaction holding a scoped advisory xact lock (`page-tree:<ws>`, `ws-members:<ws>`, admin lock); every recursive CTE has a depth cap.
3. Partial JSON updates are merged in SQL (`(props || $set) - $del`) or on a row locked `FOR UPDATE`; multi-row locks are taken in id order and the transaction is retried on 40P01.
4. The live Y.Doc is the truth: stores are serialised per document and re-encode the live state; snapshots read the live doc; never hold a DB row lock while awaiting a DirectConnection transact/disconnect (the store hook may need the same row).
5. Periodic jobs have a busy flag, cross-process work is fenced (claim value in the release `WHERE`), and whole-object replace APIs carry a version and answer 412 on mismatch.
