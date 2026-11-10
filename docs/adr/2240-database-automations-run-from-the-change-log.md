# 2240. Database automations are queued by the change-log consumer and run after the write

- Status: Accepted
- Date: 2026-11-10

## Context
0.18 adds rules to a collection: a trigger (row added, a field changed — optionally "to a value" —, a date
coming up), an optional condition (the 0.17 view filter tree, `matchesViewFilter`, OR / NOT groups) and up
to five actions (set values, assign a person, notify people, send to a registered webhook, add a row to
another database, hand the row to a person's AI connection). Rows are written by about a dozen paths
(PATCH props, the row create route behind the web, MCP `create_row` and public forms, batch create and
update, POST /pages under a collection, duplicate, templates, moves, restore, sheet sync, vault sync).
0.17 already made bulk inserts about 30 % slower with the row-number trigger (PERFORMANCE, COLL17-10); a
second per-row cost on every writer was not acceptable for collections that have no rules — almost all.

## Decision
- Tables `collection_automations` (rule, author, failure streak) and `automation_runs` (last 50 per rule),
  migration 0055; outbox topic `'automation'` (one run = one rule × one row).
- Writers do nothing new. Every row write already logs `page_added` / `page_props` events in its own
  transaction for the change feed (ADR 1650, 2141). `page_props` events now also carry the changed field
  ids (`keys`). The 'change' consumer, in the transaction that materialises those events, calls
  `queueRuns` (automations/queue.ts): when the batch has such events, one indexed query finds the enabled
  rules of the rows' collections, and matching runs are queued with the consumer's commit — so a run is
  queued exactly once and only after the write committed, and it reads the committed row.
- "Becomes a value" and the condition are checked when the run starts, against the row as it is then.
- Dates: a 15-minute tick in each process (`startAutomationScheduler`, index.ts) queues rows whose date
  field equals today + N (server time zone) with the dedupe key `auto:date:<rule>:<row>:<date>`; finished
  automation rows are kept for the outbox's done retention (7 days), longer than the one day the
  condition holds, so several processes or ticks queue one run. There was no tick to reuse: the 0.15
  scheduled share compares `share_starts_at` / `share_expires_at` when a link is opened, and the hourly
  reminder/housekeeping tick is too coarse; the new tick follows the auto-accept timer's pattern.

| Write path | Starts rules | Why |
|---|---|---|
| Web cell edit, REST and MCP `update_row` (PATCH /pages/:id/props) | yes: field changed | logs `page_props` with keys |
| Web new row, MCP `create_row`, REST row create, row templates | yes: row added (+ field changed only for later writes) | `createRow` logs `page_added` |
| Public form answer | yes: row added, capped (ADR 2241) | goes through `createRow` |
| Batch update (PATCH …/rows/batch) | yes: field changed, per row | logs `page_props` with keys; rate limits apply |
| Batch create (POST …/rows/batch: paste, CSV into an existing database) | **no** | marked `noAuto`: a paste of 500 rows must not start 500 × N runs |
| POST /pages under a collection, duplicate a row | yes: row added | log `page_added` |
| Template instantiation, zip / Notion / folder import | no rules can exist yet | they create new databases |
| Move into a collection, restore from trash | **no** | `page_moved` / `page_restored` are not additions; v1 keeps them out |
| Sheet sync | **no** | logs no events at all (as before; it is a bulk mirror) |
| Vault sync | **no** | writes no row values; new pages get `page_added`, but vault sync is experimental and bulk |
| Two-way relation mirroring | **no** | writes no events (ADR 2141) |
| An automation's own writes | yes, with the loop marker (ADR 2242) | they go through the routes above |

## Alternatives considered
- **A Postgres trigger on `pages`** that queues runs: one more statement per inserted row on every
  collection, on top of the 0.17 trigger; and it cannot know the actor or the changed fields.
- **Each route queues runs in its transaction**: twelve call sites to keep in sync and one extra query per
  write on collections without rules (or an in-memory "has rules" cache to invalidate across processes).
- **Run inside the write's transaction**: a slow or failing action would hold the row lock and fail the
  person's edit; actions as the author would need a second permission context inside one transaction.
- **Hourly housekeeping for dates**: too coarse for "on the day"; the outbox poll alone does not wake for
  rows that have not been queued.

## Trade-offs
- A run starts after the change log's lag (normally under a second) plus the automation pass.
- Field-changed runs see the row as it is when they start: two quick edits can make both runs see the
  second value (the "becomes" check then holds for both). Rules should be idempotent; the run log shows it.
- Moves and restores do not count as "row added" in v1.

## Consequences
- apps/server/src/automations/{queue,pure,runner,rules,context}.ts, routes/automations.ts,
  context/changeLog.ts (`keys`, `noAuto`, `setAutomationEventHook`), outbox.ts (topic), migration 0055.
- Collections without rules: no added statement on any write path; the change consumer adds one query per
  batch that contains row events (measured in PERFORMANCE drafts).
- The agent task board template gets no sample rule in 0.18 (see the 0.18 drafts): it has no "Review"
  status or requester field, and duplicating a database does not copy rules yet.
