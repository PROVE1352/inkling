/**
 * Later-list reminder sweep cost (docs/adr/1411-*, docs/PERFORMANCE.md).
 *
 *   DATABASE_URL=postgres://…/scratch tsx scripts/later-bench.ts
 *
 * Needs a fresh, migrated scratch database (it seeds 50 users, 1 workspace, 200 pages and 25,000
 * `later_items` rows, and drops/re-creates `later_items_due_idx` during the run). Prints:
 *  1. the idle tick (sweep with nothing due + the next-due lookup), with and without the partial index;
 *  2. a burst: all 10,000 reminders due at once, sweeps until empty, then the notification consumer;
 *  3. the rejected alternative: one notification pass with 0 vs 10,000 future-dated `notify` outbox rows.
 * The outbox worker is off (OUTBOX_AUTORUN=0): consumers run only when the script calls them.
 */
process.env.OUTBOX_AUTORUN = '0'
const { sql } = await import('drizzle-orm')
const { db, closeDb } = await import('../src/db/index')
const h = await import('../src/mcpTools/testHarness')
const { runLaterSweep } = await import('../src/later')
const { drainOutbox, enqueue } = await import('../src/outbox')
const { notifyOutboxRow, runNotifyBatch } = await import('../src/notify/engine')

const N = 10_000
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.95)]
}
async function timeit(fn: () => Promise<unknown>, n = 50): Promise<{ med: number; p95: number }> {
  for (let i = 0; i < 5; i++) await fn()
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await fn()
    xs.push(performance.now() - t)
  }
  return { med: median(xs), p95: p95(xs) }
}
const fmt = (r: { med: number; p95: number }) => `p50 ${r.med.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms`

const users = await Promise.all(Array.from({ length: 50 }, (_, i) => h.makeUser(`u${i}`)))
const ws = await h.makeWorkspace(users[0], users.slice(1))
const pages = await Promise.all(Array.from({ length: 200 }, (_, i) => h.makeDocPage(ws.id, users[0].id, `P${i}`, [])))

// 10,000 open reminders spread over the next 30 days (+ 10,000 without a reminder, 5,000 done).
await db.execute(sql`
  INSERT INTO later_items (user_id, workspace_id, kind, page_id, target_key, remind_at, created_at)
  SELECT (${JSON.stringify(users.map((u) => u.id))}::jsonb ->> (g % 50))::uuid, ${ws.id},
         'page', (${JSON.stringify(pages.map((p) => p.id))}::jsonb ->> (g % 200))::uuid, 'perf:' || g,
         CASE WHEN g <= ${N} THEN now() + make_interval(mins => 10 + g * 4) END, now()
    FROM generate_series(1, ${N * 2}) g
`)
await db.execute(sql`
  INSERT INTO later_items (user_id, workspace_id, kind, page_id, target_key, remind_at, done_at)
  SELECT (${JSON.stringify(users.map((u) => u.id))}::jsonb ->> (g % 50))::uuid, ${ws.id},
         'page', (${JSON.stringify(pages.map((p) => p.id))}::jsonb ->> (g % 200))::uuid, 'perfdone:' || g,
         now() - interval '1 day', now()
    FROM generate_series(1, 5000) g
`)
await db.execute(sql`ANALYZE later_items`)
console.log(`rows: ${N} open reminders in the future, ${N} saved without reminder, 5000 done`)

const nextDue = () =>
  db.execute(sql`SELECT min(remind_at) FROM later_items WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL`)
const plan = async () =>
  ((await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS)
    SELECT id FROM later_items WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL AND remind_at <= now()
     ORDER BY remind_at LIMIT 500 FOR UPDATE SKIP LOCKED`)) as unknown as Record<string, string>[])
    .map((r) => Object.values(r)[0])
    .join('\n')

// 1) idle tick (nothing due): sweep + next-due lookup, with and without the partial index.
const idleWith = await timeit(async () => {
  await runLaterSweep()
  await nextDue()
})
const planWith = await plan()
await db.execute(sql`DROP INDEX later_items_due_idx`)
await db.execute(sql`ANALYZE later_items`)
const idleWithout = await timeit(async () => {
  await runLaterSweep()
  await nextDue()
})
const planWithout = await plan()
await db.execute(sql`CREATE INDEX later_items_due_idx ON later_items (remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL`)
await db.execute(sql`ANALYZE later_items`)
console.log(`idle tick, partial index:    ${fmt(idleWith)}`)
console.log(`idle tick, no partial index: ${fmt(idleWithout)}`)
console.log('--- plan with index\n' + planWith)
console.log('--- plan without index\n' + planWithout)

// 2) burst: all 10,000 come due at once (a long downtime). Sweep batches, then the notify consumer.
await db.execute(sql`UPDATE later_items SET remind_at = now() - interval '1 second' WHERE remind_at IS NOT NULL AND done_at IS NULL`)
let t0 = performance.now()
let claimed = 0
const sweeps: number[] = []
for (;;) {
  const t = performance.now()
  const n = await runLaterSweep()
  if (n === 0) break
  sweeps.push(performance.now() - t)
  claimed += n
}
const sweepMs = performance.now() - t0
t0 = performance.now()
await drainOutbox('notify', 10_000)
const notifyMs = performance.now() - t0
const [{ n: written }] = (await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'later_reminder'`)) as unknown as { n: number }[]
console.log(
  `burst: ${claimed} claimed in ${sweeps.length} sweeps, ${sweepMs.toFixed(0)} ms (per sweep of 500: p50 ${median(sweeps).toFixed(1)} ms); ` +
    `notify consumer ${notifyMs.toFixed(0)} ms; ${written} notifications written; total ${(sweepMs + notifyMs).toFixed(0)} ms`,
)

// 3) rejected alternative: future-dated 'notify' outbox rows instead of a table. Cost of one notify
//    pass with one due event, 0 vs 10,000 pending future rows.
const ev = () =>
  notifyOutboxRow({ workspaceId: ws.id, pageId: pages[0].id, actorId: null, via: null, recipients: [{ userId: users[1].id, kind: 'later_reminder', reason: 'direct' }] })!
const passCost = async () =>
  timeit(async () => {
    await enqueue(db, [ev()])
    await runNotifyBatch()
  }, 40)
const base = await passCost()
await db.execute(sql`
  INSERT INTO outbox (topic, origin, workspace_id, payload, available_at)
  SELECT 'notify', NULL, ${ws.id}, ${JSON.stringify(ev().payload)}::jsonb, now() + make_interval(mins => 10 + g * 4)
    FROM generate_series(1, ${N}) g
`)
await db.execute(sql`ANALYZE outbox`)
const loaded = await passCost()
await db.execute(sql`DELETE FROM outbox WHERE topic = 'notify' AND available_at > now()`)
console.log(`notify pass (1 due event), 0 future outbox rows:      ${fmt(base)}`)
console.log(`notify pass (1 due event), ${N} future outbox rows: ${fmt(loaded)}`)
await closeDb()
process.exit(0)
