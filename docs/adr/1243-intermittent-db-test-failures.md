# 1243. Intermittent `[db]` test failures: one clock bug, the rest shared-database assumptions

- Status: Accepted
- Date: 2026-11-08

## Context
`pnpm test:db` failed now and then with one to three tests, more often under load. The runner
(docs/adr/0880-*) gives node:test every test file; node runs the files in parallel processes and
all `[db]` suites share one scratch database.

To find the causes the full suite was run on fresh clones of one migrated template database,
24 runs as 8 rounds of 3 at once (each run itself uses all cores; Apple M4, Postgres 16 in Docker
Desktop), with diagnostics printed at the failing assertions in the second 12. 15 of 24 loaded
runs failed (18 failed tests); one unloaded run failed as well:

| Test | Failed runs | What the diagnostic showed | Cause |
|---|---|---|---|
| changeFeed "merges edits of one section within the window, never across an issued cursor" | 10 / 24 | the high-water mark moved from below to above the v4 row between the v4 and v5 edits | another file issued a `changes_since` cursor; the mark is database-wide (docs/adr/1080-*), so the merge rightly stopped |
| editLock "page text is wrapped as data…" and "find_context and read_pages wrap and flag…" | 2 / 24 | 2 pending change rows for the page, 0 rows in `page_changes` | provenance read before the outbox consumer wrote it: the documented lag (docs/adr/1080-* "Lag, stated", KNOWN-ISSUES CF-7) |
| outbox "a crash inside the notification consumer writes nothing and loses nothing" | 1 / 24 + the unloaded run | row still pending and locked by another session; the count was 1 a second later | after `orphan()` any process may claim the row; `flushNotifications` skips a row another consumer holds (`SKIP LOCKED`) |
| secretsAtRest "grace 0 blocks at once…" | 2 / 24 | stored deadline in the database's future | the app clock is 46 ms ahead of the database's: a code bug, docs/adr/1242-* |
| authSecurity "sign-in asks for a code; each code works once" | 1 / 24 | `INVALID_TOTP_CODE` instead of `TOTP_CODE_REUSED` | the test computed "now − 1" after a 30 s step boundary had passed, outside the server's ±1 window |

Later in the session the Docker Desktop VM clock had drifted to 2.09 s behind the host (from
46 ms), and two more tests failed in every run: authSecurity "expired challenges and a password
reset in between are refused" (it set the expiry to app time − 1 s; the check is `> now()` in SQL)
and webhooksGeneric "records failures…" (it compared the database's `now() + 2 s` retry time with
`Date.now()`); that test's leftover retry then made "a crash after the HTTP call redelivers once"
see two deliveries. Clock drift of this size also explains failures "now and then" on a machine
that has been up for a while.

While checking the fixes, outbox "a crash inside the consumer (after its writes, before commit)"
failed 2 of 12 runs: another file's change consumer took the child's row in all three rounds the
test allows for exactly that. A suspected cause was ruled out: a SIGKILLed child holding the
change-log advisory lock. Through Docker Desktop's port forwarding the lock was free on the first
try after the child exited (5 of 5).

## Decision
- **Code:** the two-step deadline uses the database clock (docs/adr/1242-*).
- **Exclusive files:** `scripts/run-tests.mjs` in `--db` mode runs files that carry the line
  `// run-tests: db-exclusive` after the others, one at a time (`--test-concurrency=1`). Two files
  carry it: `context/changeFeed.test.ts` (its merge assertions are about what happens when *no*
  cursor is issued between two edits) and `outbox.db.test.ts` (its crash tests need the child's
  change row to reach the child's own consumer; change rows have no affinity by design).
- **editLock trust-boundary block:** `before` drains the change log after creating and indexing
  the page, as the other suites that read `page_changes` do. The lag is a documented property, not
  a race to remove from the product.
- **outbox notify crash test:** after orphaning the row it waits until the row has left the outbox
  (whoever committed it), at most 10 s, and then asserts exactly one notification and an empty
  outbox. It is a barrier on the precondition of the assertion; a lost or duplicated notification
  still fails. (With the file now exclusive this is belt and braces.)
- **TOTP test:** "older" is the step just below the one used for sign-in, which is inside the
  server window whether or not a boundary passed.
- **Clock in tests:** a test that writes or compares a timestamp the server checks in SQL uses
  the database clock (``sql`now() - interval '1 second'` ``, `clock_timestamp()`), not `Date.now()`
  (authSecurity challenge expiry, webhooksGeneric retry time).

## Alternatives considered
- **Run every `[db]` file serially:** removes all cross-file effects but makes the suite several
  times slower and hides cross-process effects the other suites would show.
- **A database per file:** cleanest isolation, but every process needs a migrated database (a
  template clone) and the runner would create and drop them.
- **Retries or longer timeouts:** would keep the 2FA bug and let a real regression pass on retry.
- **Make `read_page` wait for the in-process change consumer:** would give agents read-your-writes
  for `last_edit`, but ADR 1080 chose to keep readers off the consumer; revisit there if wanted.
- **A fourth round in the consumer-crash test:** lowers the odds without removing the cause.

## Consequences
- After the fixes, same setup: the five tests in the table failed in 0 of 36 loaded runs (three
  batches of 12 while the fixes landed). The final batch had 11 of 12 runs clean; the twelfth
  failed in a new admin-status test written at the same time (not one of the above). Unloaded,
  with the database clock 2.09 s behind the app's, three consecutive runs on fresh databases
  passed (862 tests each).
- The exclusive phase runs about 11 s after the others: `test:db` takes about 35 s instead of about
  25 s on the measuring machine.
- New tests that need database-wide quiet use the marker or wait for their own precondition
  (KNOWN-ISSUES TEST-1).
- Three parallel full suites against one Postgres with `max_connections = 100` can run out of
  connections (`sorry, too many clients` / `CONNECT_TIMEOUT`, 2 of 36 post-fix loaded runs): a
  property of the measuring setup, not of a single `test:db`.
