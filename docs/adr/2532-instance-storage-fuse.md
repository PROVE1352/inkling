# 2532. An instance storage fuse inside the app

- Status: Accepted
- Date: 2026-11-12

## Context
The 0.22 security review (F4): the demo's volumes have no size limit and share the host disk with
production, and several tables grow outside the workspace storage count (audit events, notifications,
sessions, consent records, invites, OAuth clients, IP bans, indexes, dead tuples), as do the WAL and the
backups. The review's recommendation is a filesystem with a size limit for the demo. This ADR is the
in-app fuse decided instead for now (BACKLOG 05:45); whether it is enough is for the second review.

## Decision
- `LIMIT_INSTANCE_STORAGE_MB` (`quota/instance.ts`): `pg_database_size(current_database())` plus the bytes of
  every file under `DATA_DIR`, walked on disk rather than summed from `files.size` (a blob left behind by a
  crash between commit and unlink, review F13, or a stale scratch file takes disk too). Measured at most
  once a minute: when a check finds the measurement older, by the hourly housekeeping, and in the background
  when a live update arrives. One measurement at a time; a failed one keeps the last answer.
- Full = the sum reaches the limit. Then (`quota/instanceGate.ts`, one onRequest hook on `/api`):
  every POST, PUT and PATCH answers 503 `INSTANCE_FULL` before authentication or body parsing, except
  signing in and out, password change and reset, two-step setup, consent, reads sent as POST
  (query, chart aggregate, vault sync read, public link unlock), read marks, what only removes (rejecting
  or withdrawing suggestions, unpublishing, removing guests, releasing connections, ownership transfer) and
  `/api/admin/**`. GET and DELETE always pass: reading, export, deleting pages, files, workspaces, the trash
  and the own account. A new write route is refused by default.
- Sign-up is refused (sign-up hook, 503 `INSTANCE_FULL`; the setup-code sign-up of the first admin is not).
  `isInstanceFull()` is exported for the OAuth dynamic registration (security fix 2 wires it).
- Live editing: new connections are authorised read-only; when the fuse trips, every writable connection
  is made read-only and its socket closed so it reconnects read-only; when it clears, read-only
  connections reconnect and are authorised anew. Updates arriving while full are refused (ADR 2530).
- MCP tools get "nothing was written; the server's storage is full … do not retry … tell the user".
- `GET /api/auth/mode` carries `instanceFull: true` (and `signupFull: true`); the app shows a strip
  ("This server's storage is full. For now you can only read and delete."). The admin status lists
  `storage.instanceFuse` with use, limit and state (error when tripped, warning from 90 %).
- Unset: no measurement, no refusal, no field.

## Consequences
See the measurements below. The fuse bounds the database and the data folder, not the disk:
- not seen: the WAL (up to `max_wal_size`, 1 GB by default, more while a backup or a long transaction
  holds it), the backup sets (7 daily on the demo, each about the live data compressed; random content
  does not compress), container logs (rotated: 3 × 10 MB per service), the minute between measurements, and
  what keeps growing after it trips (sessions, audit and log rows of the allowed writes, autovacuum's
  free-space maps);
- the database file does not shrink when rows are deleted: VACUUM keeps the space for reuse inside each
  table and only gives back empty pages at the end of a table. A tripped fuse usually stays tripped until
  the operator acts.

## Measurements (Postgres 16, autovacuum on: naptime 1 min, scale factor 0.2)
- Fill and delete: 60 × 5 MB of random bytes took the database from 11.4 MB to 322.6 MB (fuse at baseline +
  200 MB: tripped). `DELETE` of every row: 322.6 MB, still tripped. Plain `VACUUM` gave the space back only
  because every page at the end of the table was empty (14.7 MB). The usual case, half the rows deleted in
  between: `VACUUM` 326.2 MB, still tripped; `VACUUM FULL` of the table 167.0 MB, released (the next
  measurement, within a minute, lets writes and live editing back in; tested with the app in
  `quota/instance.db.test.ts`).
- Releasing it, for the operator: find the largest relations (`pg_total_relation_size`, mostly `page_docs`,
  `page_snapshots` and their TOAST tables), delete what should go (workspaces deleted for good, the trash
  purged), then `VACUUM FULL` those tables one at a time (it locks each table and needs free disk the size
  of the table's live data), or raise the limit and restart. Until then the server reads and deletes.
- Rewriting one 5 MB value again and again (a page body stored after each change): 40 rewrites in 8 s grew
  the database by 207.5 MB; after autovacuum had run, 80 more rewrites over 3 minutes added 2.3 MB. Bloat
  is about what is rewritten between two autovacuum passes (about a minute), then it plateaus. One
  address can send 4 MB/s over the collab socket (ADR 2530), about 240 MB a minute; tripping a 3,000 MB
  fuse on a demo holding 2,000 MB of counted data takes roughly 1 GB of bloat, i.e. a few addresses writing
  at full rate for a minute or two. The fuse then stays tripped (the file does not shrink) until the
  operator runs `VACUUM FULL`: only the demo stops, and the operator has to know it can happen.
- Host disk with the demo preset (3,000 MB): live data ≤ 3,000 MB + one minute of growth; WAL up to 1 GB;
  7 daily backup sets of at most the live data each (pg_dump of live rows, without bloat or indexes, plus
  the data folder, gzip) ≈ 7 × 3,000 MB worst case for incompressible content; logs 3 × 10 MB per
  service. About 25 GB in the worst case, unless the demo gets a filesystem of its own.
