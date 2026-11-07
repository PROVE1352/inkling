/**
 * Webhook consumer throughput (docs/adr/1081-*, 1190-*): how fast the 'webhook' outbox topic drains
 * to a local receiver, in process, without the HTTP routes.
 *
 *   DATABASE_URL=postgres://…/<scratch db, migrated> WEBHOOK_TEST_ALLOW_LOOPBACK=1 \
 *     tsx scripts/webhook-consumer-bench.ts [--kind slack|generic] [--ws 25] [--per-ws 20] [--rounds 3] [--latency 0]
 *
 * Per round: `ws` fresh workspaces with one shared page, one comment and one hook each (`kind`), then
 * `ws × per-ws` comment events are queued with the consumer stopped (distinct event keys, so no
 * dedupe), and the clock runs from the first pass until every row is finished. `per-ws` stays at or
 * below the per-workspace token bucket (20), so the bucket never delays a row. The receiver answers
 * 200 after `latency` ms. Reported: deliveries/s, the wall time per round, and statements per
 * delivery (every statement the consumer sent through the app's pool during the drain, counted with a
 * drizzle query logger, minus this loop's own polling reads; claim passes that found nothing are
 * included). The scratch database is left behind (tests do not clean up either); drop it afterwards.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
function opt(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const KIND = opt('kind', 'slack')
const WS = Number(opt('ws', '25'))
const PER_WS = Number(opt('per-ws', '20'))
const ROUNDS = Number(opt('rounds', '3'))
const LATENCY = Number(opt('latency', '0'))

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (a migrated scratch database) is required')
process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'

const { db, closeDb } = await import('../src/db/index')
const schema = await import('../src/db/schema')
const { sql } = await import('drizzle-orm')
const outbox = await import('../src/outbox')
const webhooks = await import('../src/webhooks')
const H = await import('../src/mcpTools/testHarness')

outbox.setOutboxAutorun(false)
let received = 0
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    received++
    if (LATENCY > 0) setTimeout(() => res.writeHead(200).end('ok'), LATENCY)
    else res.writeHead(200).end('ok')
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`

const owner = await H.makeUser('bench')
const results: { rate: number; ms: number; stmts: number }[] = []
let stmts = 0
// Count statements: drizzle asks the session's logger for every query it prepares.
;(db as unknown as { session: { logger: { logQuery: () => void } } }).session.logger = { logQuery: () => void stmts++ }
for (let round = 0; round < ROUNDS; round++) {
  const events: Parameters<typeof webhooks.enqueueWebhookEvent>[1][] = []
  const wsIds: string[] = []
  for (let w = 0; w < WS; w++) {
    const ws = await H.makeWorkspace(owner, [])
    wsIds.push(ws.id)
    const pg = await H.makeDocPage(ws.id, owner.id, `Bench ${w}`, [])
    const [c] = await db
      .insert(schema.comments)
      .values({ pageId: pg.id, authorId: owner.id, blockId: 'x', threadId: randomUUID(), body: 'bench comment' })
      .returning()
    await db.insert(schema.workspaceWebhooks).values({
      workspaceId: ws.id,
      kind: KIND as 'slack' | 'generic',
      url,
      events: ['comment'],
      // generic deliveries are signed (docs/adr/1190-*); stored plaintext like a key-less install
      ...(KIND === 'generic' ? { secret: 'whsec_bench' } : {}),
    })
    webhooks.invalidateWebhookCache(ws.id)
    for (let i = 0; i < PER_WS; i++) {
      events.push({ type: 'comment', workspaceId: ws.id, pageId: pg.id, actorId: owner.id, commentId: c.id, key: `bench:${randomUUID()}` })
    }
  }
  for (const ev of events) await webhooks.enqueueWebhookEvent(db, ev)
  const total = events.length
  received = 0
  const idList = sql.join(wsIds.map((id) => sql`${id}::uuid`), sql`, `)
  const s0 = stmts
  const t0 = performance.now()
  let polls = 0
  for (;;) {
    polls++
    await outbox.drainOutbox('webhook')
    const [r] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM outbox WHERE topic = 'webhook' AND state = 'pending' AND workspace_id IN (${idList})
    `)) as unknown as { n: number }[]
    if (r.n === 0 && webhooks._queueSize() === 0) break
    await new Promise((res) => setTimeout(res, 1))
  }
  const ms = performance.now() - t0
  // minus the polling reads of this loop
  const used = stmts - s0 - polls
  const [d] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE state = 'done' AND last_error IS NULL)::int AS ok, count(*)::int AS n
      FROM outbox WHERE topic = 'webhook' AND workspace_id IN (${idList})
  `)) as unknown as { ok: number; n: number }[]
  if (d.ok !== total || received !== total) throw new Error(`round ${round}: ${d.ok}/${d.n} rows ok, ${received} received, ${total} expected`)
  results.push({ rate: (total / ms) * 1000, ms, stmts: used })
  console.log(
    `round ${round + 1}: kind=${KIND} deliveries=${total} latency=${LATENCY}ms → ${ms.toFixed(0)} ms, ${((total / ms) * 1000).toFixed(0)} deliveries/s, ` +
      `${(used / total).toFixed(2)} statements/delivery`,
  )
}
const rates = results.map((r) => r.rate).sort((a, b) => a - b)
const cpd = results.map((r) => r.stmts / (WS * PER_WS)).sort((a, b) => a - b)
console.log(
  `kind=${KIND} latency=${LATENCY}ms: deliveries/s min ${rates[0].toFixed(0)} median ${rates[Math.floor(rates.length / 2)].toFixed(0)} max ${rates[rates.length - 1].toFixed(0)}; ` +
    `statements/delivery median ${cpd[Math.floor(cpd.length / 2)].toFixed(2)}`,
)
await closeDb()
server.close()
process.exit(0)
