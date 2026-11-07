# 0757. Concurrency: periodic-job re-entry, sheet-sync claim release, snapshot sources

- Status: Accepted
- Date: 2026-11-07

## Findings and decisions (static review + normal-range tests)
- One-time tokens are consumed atomically (`DELETE … RETURNING` for reset codes, email tokens, OAuth codes; conditional `UPDATE … RETURNING` for refresh rotation). Signup keys: `UPDATE … SET used_count = used_count + 1 WHERE used_count < max_uses … RETURNING` — tests: 10 concurrent consumes of a `max_uses = 3` key succeed exactly 3 times; 5 concurrent consumes of one reset code succeed once.
- Reminder/housekeeping scheduler had no re-entry guard (dedupe is SELECT-then-INSERT): a tick that outlives the hourly interval now skips the next tick.
- Sheet sync released its claim with `WHERE page_id = …`; a run that outlived the stale window could clear another runner's claim. Release now matches the claimed `running_since`.
- Document stores are serialised per document (ADR 0750).
- "Before restore" / "before AI edit" snapshots read the live document instead of `page_docs` (which trails by up to 10 s); restore's delete+insert run in one Yjs transaction (one broadcast, no transient empty document).

## Known, not changed
- Webhook queue and backup monitor already have busy flags; webhook queue is in memory by design (lost on restart).
- ~~Issuing two reset codes for one user concurrently can leave two valid codes~~ — fixed by ADR 0808 (per-user advisory lock).
