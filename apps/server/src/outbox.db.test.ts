// Transactional outbox (docs/adr/1080-*, 1081-*): crash recovery, concurrent consumers, change-feed
// lag, retries, dedupe and purge. Real process kills (SIGKILL) run a child process through tsx.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AnyBlock } from './md/convert'
import { backoffMs } from './outbox'

const HAS_DB = !!process.env.DATABASE_URL
const SRC = path.dirname(fileURLToPath(import.meta.url))

describe('outbox retry policy', () => {
  it('backoff is exponential and capped', () => {
    const p = { baseMs: 2_000, factor: 5, capMs: 60_000 }
    assert.deepEqual([1, 2, 3, 4, 5].map((a) => backoffMs(a, p, false)), [2_000, 10_000, 50_000, 60_000, 60_000])
    const q = { baseMs: 1_000, factor: 2, capMs: 300_000 }
    assert.deepEqual([1, 2, 3, 9, 10, 20].map((a) => backoffMs(a, q, false)), [1_000, 2_000, 4_000, 256_000, 300_000, 300_000])
    for (let i = 0; i < 50; i++) {
      const j = backoffMs(3, q)
      assert.ok(j >= 3_600 && j <= 4_400, String(j))
    }
  })
})

const para = (t: string): AnyBlock => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] as never })
const head = (t: string): AnyBlock => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }] as never })
const doc = (sections: Record<string, string>) => Object.entries(sections).flatMap(([k, v]) => [head(k), para(v)])

/** Run `body` (ES module source) in a child Node process with the tsx loader; resolves on exit. */
async function runChild(body: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'inkling-outbox-'))
  const file = path.join(dir, 'child.mjs')
  const src = (rel: string) => JSON.stringify(new URL(rel, `file://${SRC}/`).href)
  const prelude =
    `const M = (rel) => import(new URL(rel, ${src('./')}).href)\n` +
    `const D = () => import(${JSON.stringify(import.meta.resolve('drizzle-orm'))})\n`
  await writeFile(file, prelude + body)
  void src
  const tsx = import.meta.resolve('tsx')
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', tsx, file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('exit', (code, signal) => resolve({ stdout, stderr, code, signal }))
  })
}

describe('[db] outbox', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const H = await import('./mcpTools/testHarness')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { blocksToStateBuffer } = await import('./md/convert')
  const outbox = await import('./outbox')
  const changeLog = await import('./context/changeLog')
  const { readChangeFeed } = await import('./context/changeFeed')
  const engine = await import('./notify/engine')
  const webhooks = await import('./webhooks')

  process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'
  const received: { body: string; id: string | undefined }[] = []
  let status = 200
  const hookServer = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      received.push({ body: b, id: req.headers['x-inkling-delivery'] as string | undefined })
      res.writeHead(status).end('ok')
    })
  })
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()))
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`

  after(async () => {
    await outbox.stopOutboxWorker()
    await closeDb()
    await new Promise<void>((r) => hookServer.close(() => r()))
  })

  const alice = await H.makeUser('alice')
  const bob = await H.makeUser('bob')
  const ws = await H.makeWorkspace(alice, [bob])

  async function newPage(title: string, sections: Record<string, string>, wsId = ws.id) {
    const pg = await H.makeDocPage(wsId, alice.id, title, doc(sections))
    await reindexPageChunks(pg.id, doc(sections))
    await changeLog.drainChangeLog()
    return pg
  }
  async function setDoc(pageId: string, sections: Record<string, string>) {
    await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(doc(sections)) }).where(eq(schema.pageDocs.pageId, pageId))
    await reindexPageChunks(pageId, doc(sections))
  }
  const logRows = async (pageId: string) =>
    (await db.execute(sql`
      SELECT seq::text AS seq, kind, anchor, before_text AS b, after_text AS a FROM page_changes WHERE page_id = ${pageId} ORDER BY page_changes.seq
    `)) as unknown as { seq: string; kind: string; anchor: string | null; b: string | null; a: string | null }[]
  const pendingFor = async (wsId: string) => [
    ...((await db.execute(sql`
      SELECT topic, count(*)::int AS n FROM outbox WHERE workspace_id = ${wsId} AND state = 'pending' GROUP BY topic ORDER BY topic
    `)) as unknown as { topic: string; n: number }[]),
  ]
  /** Pretend the takeover delay passed for rows another (dead) process wrote. */
  const orphan = (wsId: string) =>
    db.execute(sql`UPDATE outbox SET available_at = now() - interval '1 minute' WHERE workspace_id = ${wsId} AND state = 'pending'`)
  async function settleAll() {
    await engine.flushNotifications()
    await webhooks.flushWebhookEmits()
    for (let i = 0; i < 100; i++) {
      await outbox.drainOutbox('webhook')
      const [r] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM outbox WHERE topic = 'webhook' AND state = 'pending' AND available_at <= now() AND workspace_id IN (${sql.join([ws.id, ...extraWs].map((w) => sql`${w}::uuid`), sql`, `)})
      `)) as unknown as { n: number }[]
      if (webhooks._queueSize() === 0 && r.n === 0) break
      await new Promise((res) => setTimeout(res, 30))
    }
  }
  const extraWs: string[] = []

  describe('crash after commit, before processing', () => {
    it('change log, notification and webhook rows survive a SIGKILL and are processed exactly once', async () => {
      const wsC = await H.makeWorkspace(alice, [bob])
      extraWs.push(wsC.id)
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: wsC.id, kind: 'slack', url: hookUrl, events: ['comment'] })
      const pg = await newPage('Crash page', { Alpha: 'a0', Beta: 'b0' }, wsC.id)
      const before = (await logRows(pg.id)).length
      const commentId = (await db.insert(schema.comments).values({ pageId: pg.id, authorId: alice.id, blockId: 'x', threadId: crypto.randomUUID(), body: 'crash comment body' }).returning())[0].id

      const child = await runChild(
        `
        const outbox = await M('./outbox.ts')
        outbox.setOutboxAutorun(false)
        const { db } = await M('./db/index.ts')
        const schema = await M('./db/schema.ts')
        const { eq } = await D()
        const { blocksToStateBuffer } = await M('./md/convert.ts')
        const { reindexPageChunks } = await M('./context/chunkIndex.ts')
        const { recordPageEvents } = await M('./context/changeLog.ts')
        const engine = await M('./notify/engine.ts')
        const webhooks = await M('./webhooks.ts')
        const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
        const h = (t) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }] })
        const blocks = [h('Alpha'), p('a1'), h('Beta'), p('b0'), h('Gamma'), p('g1')]
        await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks) }).where(eq(schema.pageDocs.pageId, ${JSON.stringify(pg.id)}))
        await reindexPageChunks(${JSON.stringify(pg.id)}, blocks)
        await recordPageEvents([{ pageId: ${JSON.stringify(pg.id)}, kind: 'page_renamed', before: 'Crash page', after: 'Crash page 2' }], { userId: ${JSON.stringify(alice.id)}, via: null })
        await engine.enqueueNotify(db, { workspaceId: ${JSON.stringify(wsC.id)}, pageId: ${JSON.stringify(pg.id)}, actorId: ${JSON.stringify(alice.id)}, via: null,
          recipients: [{ userId: ${JSON.stringify(bob.id)}, kind: 'comment_mention', reason: 'direct' }], threadId: ${JSON.stringify(commentId)}, commentId: ${JSON.stringify(commentId)}, excerpt: 'crash comment body' })
        await webhooks.enqueueWebhookEvent(db, { type: 'comment', workspaceId: ${JSON.stringify(wsC.id)}, pageId: ${JSON.stringify(pg.id)}, actorId: ${JSON.stringify(alice.id)}, commentId: ${JSON.stringify(commentId)} })
        process.stdout.write('committed\\n')
        process.kill(process.pid, 'SIGKILL')
        `,
      )
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      assert.match(child.stdout, /committed/)

      // Notification and webhook rows belong to the dead process: nobody takes them before the
      // takeover delay. (Change rows may already have been taken by any consumer: by design.)
      const [own] = (await db.execute(sql`
        SELECT count(*) FILTER (WHERE topic = 'notify' AND payload->>'commentId' = ${commentId})::int AS notify,
               count(*) FILTER (WHERE topic = 'webhook')::int AS webhook
          FROM outbox WHERE workspace_id = ${wsC.id} AND state = 'pending'
      `)) as unknown as { notify: number; webhook: number }[]
      assert.deepEqual([own.notify, own.webhook], [1, 1])
      assert.equal(await db.$count(schema.notifications, and(eq(schema.notifications.userId, bob.id), eq(schema.notifications.commentId, commentId))), 0)

      // "Restart": the takeover delay passes, consumers run (twice, to catch double processing).
      received.length = 0
      for (let i = 0; i < 3; i++) {
        await changeLog.drainChangeLog()
        // the follower event the change produces belongs to the dead process too
        await orphan(wsC.id)
        await settleAll()
      }

      const rows = await logRows(pg.id)
      const added = rows.slice(before)
      assert.deepEqual(
        added.map((r) => `${r.kind}:${r.anchor ?? ''}`).sort(),
        ['added:gamma', 'modified:alpha', 'page_renamed:'],
        JSON.stringify(added),
      )
      assert.equal(await db.$count(schema.notifications, and(eq(schema.notifications.userId, bob.id), eq(schema.notifications.commentId, commentId))), 1)
      const hits = received.filter((r) => r.body.includes('commented on'))
      assert.equal(hits.length, 1)
      assert.ok(hits[0].id, 'delivery id header')
      assert.deepEqual(await pendingFor(wsC.id), [])
      const [wh] = (await db.execute(sql`SELECT state FROM outbox WHERE workspace_id = ${wsC.id} AND topic = 'webhook'`)) as unknown as { state: string }[]
      assert.equal(wh.state, 'done', 'kept as done for the dedupe window')
      // A re-emitted event with the same key is a no-op.
      assert.equal(await webhooks.enqueueWebhookEvent(db, { type: 'comment', workspaceId: wsC.id, pageId: pg.id, actorId: alice.id, commentId }), 0)
    })

    it('a crash inside the consumer (after its writes, before commit) leaves nothing half-done', async () => {
      // Another test file's consumer may take the child's row first (change rows have no
      // affinity); then the child had nothing to crash on and the round is repeated.
      let killed = false
      for (let round = 0; round < 3 && !killed; round++) {
        const pg = await newPage(`Mid crash ${round}`, { One: '1' })
        const before = (await logRows(pg.id)).length
        const child = await runChild(
          `
          const outbox = await M('./outbox.ts')
          outbox.setOutboxAutorun(false)
          const { db, closeDb } = await M('./db/index.ts')
          const schema = await M('./db/schema.ts')
          const { eq } = await D()
          const { blocksToStateBuffer } = await M('./md/convert.ts')
          const { reindexPageChunks } = await M('./context/chunkIndex.ts')
          const changeLog = await M('./context/changeLog.ts')
          const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
          const h = (t) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }] })
          const blocks = [h('One'), p('1 edited'), h('Two'), p('2')]
          changeLog.changeLogTestHooks.beforeCommit = () => { process.stdout.write('writes done\\n'); process.kill(process.pid, 'SIGKILL') }
          await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks) }).where(eq(schema.pageDocs.pageId, ${JSON.stringify(pg.id)}))
          await reindexPageChunks(${JSON.stringify(pg.id)}, blocks)
          await changeLog.drainChangeLog()
          process.stdout.write('not reached\\n')
          await closeDb()
          `,
        )
        killed = child.signal === 'SIGKILL'
        if (killed) {
          assert.match(child.stdout, /writes done/)
          assert.doesNotMatch(child.stdout, /not reached/)
        } else assert.equal(child.code, 0, child.stderr)
        await changeLog.drainChangeLog()
        const added = (await logRows(pg.id)).slice(before)
        assert.deepEqual(added.map((r) => `${r.kind}:${r.anchor}`).sort(), ['added:two', 'modified:one'])
        await changeLog.drainChangeLog()
        assert.equal((await logRows(pg.id)).length, before + 2)
      }
      assert.ok(killed, 'the child crashed inside its consumer pass at least once')
    })

    it('a crash inside the notification consumer writes nothing and loses nothing', async () => {
      const wsN = await H.makeWorkspace(alice, [bob])
      extraWs.push(wsN.id)
      const pg = await H.makeDocPage(wsN.id, alice.id, 'Notify crash', doc({ A: 'a' }))
      const thread = crypto.randomUUID()
      const child = await runChild(
        `
        const outbox = await M('./outbox.ts')
        outbox.setOutboxAutorun(false)
        const { db } = await M('./db/index.ts')
        const engine = await M('./notify/engine.ts')
        await engine.enqueueNotify(db, { workspaceId: ${JSON.stringify(wsN.id)}, pageId: ${JSON.stringify(pg.id)}, actorId: ${JSON.stringify(alice.id)}, via: null,
          recipients: [{ userId: ${JSON.stringify(bob.id)}, kind: 'comment_mention', reason: 'direct' }], threadId: ${JSON.stringify(thread)}, excerpt: 'notify crash' })
        engine.notifyTestHooks.beforeCommit = () => { process.stdout.write('written\\n'); process.kill(process.pid, 'SIGKILL') }
        await engine.runNotifyBatch()
        `,
      )
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      assert.match(child.stdout, /written/)
      const count = async () =>
        Number(((await db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${bob.id} AND group_key = ${`cm:${thread}`}`)) as unknown as { n: number }[])[0].n)
      assert.equal(await count(), 0)
      assert.deepEqual(await pendingFor(wsN.id), [{ topic: 'notify', n: 1 }])
      await orphan(wsN.id)
      await engine.flushNotifications()
      await engine.flushNotifications()
      assert.equal(await count(), 1)
      assert.deepEqual(await pendingFor(wsN.id), [])
    })

    it('a crash after the HTTP call redelivers once with the same delivery id (at least once)', async () => {
      const wsW = await H.makeWorkspace(alice, [bob])
      extraWs.push(wsW.id)
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: wsW.id, kind: 'slack', url: hookUrl, events: ['comment'] })
      const pg = await H.makeDocPage(wsW.id, alice.id, 'Hook crash', doc({ A: 'a' }))
      const commentId = (await db.insert(schema.comments).values({ pageId: pg.id, authorId: alice.id, blockId: 'x', threadId: crypto.randomUUID(), body: 'lease body' }).returning())[0].id
      received.length = 0
      const child = await runChild(
        `
        const outbox = await M('./outbox.ts')
        outbox.setOutboxAutorun(false)
        const { db } = await M('./db/index.ts')
        const webhooks = await M('./webhooks.ts')
        await webhooks.enqueueWebhookEvent(db, { type: 'comment', workspaceId: ${JSON.stringify(wsW.id)}, pageId: ${JSON.stringify(pg.id)}, actorId: ${JSON.stringify(alice.id)}, commentId: ${JSON.stringify(commentId)} })
        webhooks.webhookTestHooks.afterSend = () => { process.stdout.write('sent\\n'); process.kill(process.pid, 'SIGKILL') }
        await webhooks.runWebhookPass()
        await new Promise((r) => setTimeout(r, 5000))
        `,
        { WEBHOOK_TEST_ALLOW_LOOPBACK: '1' },
      )
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      assert.equal(received.filter((r) => r.body.includes('lease body')).length, 1)
      const [row] = (await db.execute(sql`
        SELECT id::text AS id, state, attempts, locked_until > now() AS leased FROM outbox WHERE workspace_id = ${wsW.id} AND topic = 'webhook'
      `)) as unknown as { id: string; state: string; attempts: number; leased: boolean }[]
      assert.deepEqual([row.state, row.attempts, row.leased], ['pending', 1, true])
      // Nobody takes a leased row. After the lease (and the takeover delay) it is delivered again.
      await outbox.drainOutbox('webhook')
      assert.equal(received.filter((r) => r.body.includes('lease body')).length, 1)
      await db.execute(sql`UPDATE outbox SET locked_until = now() - interval '1 second', available_at = now() - interval '1 minute' WHERE id = ${row.id}`)
      await settleAll()
      const hits = received.filter((r) => r.body.includes('lease body'))
      assert.equal(hits.length, 2)
      assert.equal(hits[0].id, hits[1].id, 'the receiver can drop the duplicate by X-Inkling-Delivery')
      const [done] = (await db.execute(sql`SELECT state, attempts FROM outbox WHERE id = ${row.id}`)) as unknown as { state: string; attempts: number }[]
      assert.deepEqual([done.state, done.attempts], ['done', 2])
    })
  })

  describe('concurrent consumers', () => {
    it('change log: several consumers (two processes) materialise every row once, cursors never have gaps', async () => {
      const N_PAGES = 6
      const pgs = []
      for (let i = 0; i < N_PAGES; i++) pgs.push(await newPage(`Conc ${i}`, { S0: 'x0', S1: 'y0' }))
      const base = new Map<string, number>()
      for (const pg of pgs) base.set(pg.id, (await logRows(pg.id)).length)
      outbox.setOutboxAutorun(false)
      try {
        // 6 pages × 5 rounds: every round edits S1 (new row per page: merge only within the same
        // anchor) and adds a section S{round+2} → 2 change sets per page and round.
        const rounds = 5
        const state = pgs.map(() => ({ S0: 'x0', S1: 'y0' }) as Record<string, string>)
        const child = runChild(
          `
          const outbox = await M('./outbox.ts')
          const changeLog = await M('./context/changeLog.ts')
          const { closeDb } = await M('./db/index.ts')
          let n = 0
          const until = Date.now() + 3000
          while (Date.now() < until) { n += await changeLog.runChangeBatch(); await new Promise((r) => setTimeout(r, 2)) }
          process.stdout.write('child materialised ' + n + '\\n')
          await closeDb()
          `,
          { OUTBOX_AUTORUN: '0' },
        )
        const reservations: { seq: number; seen: string[] }[] = []
        const consumers: Promise<unknown>[] = []
        for (let r = 0; r < rounds; r++) {
          await Promise.all(
            pgs.map((pg, i) => {
              state[i].S1 = `y${r + 1}`
              state[i][`S${r + 2}`] = `new ${r}`
              return setDoc(pg.id, state[i])
            }),
          )
          // Two in-process consumers race the child and each other.
          consumers.push(changeLog.runChangeBatch(), changeLog.runChangeBatch())
          const res = await changeLog.reserveCursor()
          const seen = (await db.execute(sql`
            SELECT seq::text AS s FROM page_changes WHERE seq <= ${res.seq} AND page_id IN (${sql.join(pgs.map((p) => sql`${p.id}::uuid`), sql`, `)}) ORDER BY seq
          `)) as unknown as { s: string }[]
          reservations.push({ seq: res.seq, seen: seen.map((x) => x.s) })
        }
        await Promise.all(consumers)
        const c = await child
        assert.equal(c.code, 0, c.stderr)
        await changeLog.drainChangeLog()
        for (let i = 0; i < N_PAGES; i++) {
          const rows = (await logRows(pgs[i].id)).slice(base.get(pgs[i].id)!)
          const added = rows.filter((r) => r.kind === 'added').map((r) => r.anchor).sort()
          assert.deepEqual(added, ['s2', 's3', 's4', 's5', 's6'], JSON.stringify(rows))
          // S1 edits: one row per round unless merged (merge never crosses a reservation, and every
          // round reserved): exactly `rounds` modified rows whose afters are y1..y5.
          const mods = rows.filter((r) => r.kind === 'modified' && r.anchor === 's1').map((r) => r.a)
          assert.deepEqual(mods, ['y1', 'y2', 'y3', 'y4', 'y5'])
        }
        // No gap: rows at or below a reserved end never change afterwards.
        for (const r of reservations) {
          const now = (await db.execute(sql`
            SELECT seq::text AS s FROM page_changes WHERE seq <= ${r.seq} AND page_id IN (${sql.join(pgs.map((p) => sql`${p.id}::uuid`), sql`, `)}) ORDER BY seq
          `)) as unknown as { s: string }[]
          assert.deepEqual(now.map((x) => x.s), r.seen)
        }
        const [{ n }] = (await db.execute(sql`
          SELECT count(*)::int AS n FROM outbox WHERE topic = 'change' AND state = 'pending' AND payload->>'pageId' IN (${sql.join(pgs.map((p) => sql`${p.id}`), sql`, `)})
        `)) as unknown as { n: number }[]
        assert.equal(n, 0)
      } finally {
        outbox.setOutboxAutorun(true)
      }
    })

    it('change rows of a page apply in outbox-id order across a digit boundary (numeric, not text order)', async () => {
      const pg = await newPage('Order page', { O: 'o' })
      outbox.setOutboxAutorun(false)
      try {
        const [{ cur }] = (await db.execute(sql`SELECT last_value::text AS cur FROM outbox_id_seq`)) as unknown as { cur: string }[]
        const next = 10 ** (cur.length + 1) - 2 // …98, …99, then 1000…0
        await db.execute(sql`SELECT setval('outbox_id_seq', ${next - 1})`)
        const titles = ['t0', 't1', 't2', 't3']
        for (let i = 1; i < titles.length; i++) {
          await changeLog.recordPageEvents([{ pageId: pg.id, kind: 'page_renamed', before: titles[i - 1], after: titles[i] }], null)
        }
        await changeLog.drainChangeLog()
      } finally {
        outbox.setOutboxAutorun(true)
      }
      const renames = (await logRows(pg.id)).filter((r) => r.kind === 'page_renamed').map((r) => `${r.b}>${r.a}`)
      assert.deepEqual(renames, ['t0>t1', 't1>t2', 't2>t3'])
    })

    it('notifications: several consumers write each event once', async () => {
      const N = 40
      const pg = await H.makeDocPage(ws.id, alice.id, 'Notify conc', doc({ A: 'a' }))
      const threads = Array.from({ length: N }, () => crypto.randomUUID())
      outbox.setOutboxAutorun(false)
      try {
        // origin NULL: any consumer may take them (the child too).
        await outbox.enqueue(
          db,
          threads.map((t) => ({
            topic: 'notify' as const,
            workspaceId: ws.id,
            origin: null,
            payload: { workspaceId: ws.id, pageId: pg.id, actorId: alice.id, via: null, recipients: [{ userId: bob.id, kind: 'comment_mention', reason: 'direct' }], threadId: t, excerpt: `ev ${t}` },
          })),
        )
        const child = runChild(
          `
          const engine = await M('./notify/engine.ts')
          const { closeDb } = await M('./db/index.ts')
          let n = 0
          for (let i = 0; i < 20; i++) n += await engine.runNotifyBatch()
          process.stdout.write('child wrote ' + n + '\\n')
          await closeDb()
          `,
          { OUTBOX_AUTORUN: '0' },
        )
        await Promise.all([engine.runNotifyBatch(), engine.runNotifyBatch(), engine.runNotifyBatch()])
        const c = await child
        assert.equal(c.code, 0, c.stderr)
        await outbox.drainOutbox('notify')
      } finally {
        outbox.setOutboxAutorun(true)
      }
      const rows = (await db.execute(sql`
        SELECT group_key, count FROM notifications WHERE user_id = ${bob.id} AND page_id = ${pg.id}
      `)) as unknown as { group_key: string; count: number }[]
      assert.equal(rows.length, N)
      assert.ok(rows.every((r) => Number(r.count) === 1))
      assert.equal(new Set(rows.map((r) => r.group_key)).size, N)
    })
  })

  describe('change feed lag', () => {
    it('changes_since sees a committed change at once, even with no background consumer', async () => {
      const pg = await newPage('Lag page', { L: 'l0' })
      const start = await readChangeFeed(bob.id, { workspaceId: ws.id })
      outbox.setOutboxAutorun(false)
      try {
        await setDoc(pg.id, { L: 'l1 fresh' })
        const t0 = performance.now()
        const r = await readChangeFeed(bob.id, { workspaceId: ws.id, cursor: start.cursor })
        const ms = performance.now() - t0
        assert.match(r.text, /\+ l1 fresh/)
        // same cursor, same state → same bytes
        assert.equal((await readChangeFeed(bob.id, { workspaceId: ws.id, cursor: start.cursor })).text, r.text)
        console.log(`# changes_since with 1 pending row (drain on read): ${ms.toFixed(1)} ms`)
      } finally {
        outbox.setOutboxAutorun(true)
      }
    })

    it('the background consumer materialises a write within the poll bound (LISTEN across processes)', async () => {
      const pg = await newPage('Listen page', { Q: 'q0' })
      const before = (await logRows(pg.id)).length
      await outbox.startOutboxWorker(() => {})
      try {
        const child = await runChild(
          `
          const outbox = await M('./outbox.ts')
          outbox.setOutboxAutorun(false)
          const { db, closeDb } = await M('./db/index.ts')
          const schema = await M('./db/schema.ts')
          const { eq } = await D()
          const { blocksToStateBuffer } = await M('./md/convert.ts')
          const { reindexPageChunks } = await M('./context/chunkIndex.ts')
          const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] })
          const h = (t) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: t, styles: {} }] })
          const blocks = [h('Q'), p('q1 from another process')]
          await db.update(schema.pageDocs).set({ state: blocksToStateBuffer(blocks) }).where(eq(schema.pageDocs.pageId, ${JSON.stringify(pg.id)}))
          await reindexPageChunks(${JSON.stringify(pg.id)}, blocks)
          process.stdout.write('committed ' + Date.now() + '\\n')
          await closeDb()
          `,
        )
        assert.equal(child.code, 0, child.stderr)
        const committedAt = Number(/committed (\d+)/.exec(child.stdout)![1])
        let seenAt = 0
        for (let i = 0; i < 300; i++) {
          if ((await logRows(pg.id)).length > before) {
            seenAt = Date.now()
            break
          }
          await new Promise((r) => setTimeout(r, 5))
        }
        assert.ok(seenAt > 0, 'materialised')
        const lag = seenAt - committedAt
        console.log(`# background consumer lag, other process → page_changes: ${lag} ms (poll bound ${outbox.OUTBOX_POLL_MS} ms)`)
        assert.ok(lag <= outbox.OUTBOX_POLL_MS + 500, String(lag))
      } finally {
        await outbox.stopOutboxWorker()
        outbox.resumeOutbox()
      }
    })
  })

  describe('retries, dead rows and purge', () => {
    it('a failing change row retries with backoff, blocks only its page, and ends dead', async () => {
      const good = await newPage('Good page', { G: 'g0' })
      const goodBefore = (await logRows(good.id)).length
      const badPage = crypto.randomUUID()
      const logged: string[] = []
      changeLog.setChangeLogLogger((m) => logged.push(m))
      outbox.setOutboxAutorun(false)
      try {
        // A payload whose insert fails (workspace FK): stands for any persistent error.
        const bad = {
          op: 'events',
          workspaceId: crypto.randomUUID(),
          actor: null,
          events: [{ pageId: badPage, kind: 'page_renamed', before: 'a', after: 'b', scope: 'shared', ownerId: null }],
        }
        await outbox.enqueue(db, [{ topic: 'change', payload: bad }])
        await outbox.enqueue(db, [{ topic: 'change', payload: { ...bad, events: [{ ...bad.events[0], after: 'c' }] } }])
        await setDoc(good.id, { G: 'g1' })
        await changeLog.runChangeBatch()
      } finally {
        outbox.setOutboxAutorun(true)
      }
      assert.equal((await logRows(good.id)).length, goodBefore + 1, 'other pages are not blocked')
      const rows = (await db.execute(sql`
        SELECT id::text AS id, state, attempts, available_at > now() AS later, last_error FROM outbox
         WHERE topic = 'change' AND payload->'events'->0->>'pageId' = ${badPage} ORDER BY id
      `)) as unknown as { id: string; state: string; attempts: number; later: boolean; last_error: string | null }[]
      assert.equal(rows.length, 2)
      assert.deepEqual([rows[0].state, rows[0].attempts, rows[0].later], ['pending', 1, true])
      assert.ok(rows[0].last_error)
      assert.equal(rows[1].attempts, 0, 'the next row of the same page waits behind it (order)')
      // last attempt → dead
      await db.execute(sql`UPDATE outbox SET attempts = 9, available_at = now() WHERE id = ${rows[0].id}`)
      await changeLog.runChangeBatch()
      const [d] = (await db.execute(sql`SELECT state, finished_at IS NOT NULL AS f FROM outbox WHERE id = ${rows[0].id}`)) as unknown as { state: string; f: boolean }[]
      assert.deepEqual([d.state, d.f], ['dead', true])
      assert.ok(logged.some((m) => /failed \(dead\)/.test(m)))
      changeLog.setChangeLogLogger((m) => console.error(m))
      await db.execute(sql`DELETE FROM outbox WHERE id = ${rows[1].id}`)
    })

    it('a failing webhook retries after the backoff, then succeeds', async () => {
      const wsR = await H.makeWorkspace(alice, [bob])
      extraWs.push(wsR.id)
      await db.insert(schema.workspaceWebhooks).values({ workspaceId: wsR.id, kind: 'slack', url: hookUrl, events: ['comment'] })
      const pg = await H.makeDocPage(wsR.id, alice.id, 'Retry hook', doc({ A: 'a' }))
      const commentId = (await db.insert(schema.comments).values({ pageId: pg.id, authorId: alice.id, blockId: 'x', threadId: crypto.randomUUID(), body: 'retry body' }).returning())[0].id
      status = 503
      received.length = 0
      try {
        webhooks.emitWebhookEvent({ type: 'comment', workspaceId: wsR.id, pageId: pg.id, actorId: alice.id, commentId })
        await settleAll()
      } finally {
        status = 200
      }
      const [r1] = (await db.execute(sql`
        SELECT id::text AS id, state, attempts, last_error, (extract(epoch from available_at - now()))::float8 AS wait FROM outbox WHERE workspace_id = ${wsR.id}
      `)) as unknown as { id: string; state: string; attempts: number; last_error: string; wait: number }[]
      assert.deepEqual([r1.state, r1.attempts, r1.last_error], ['pending', 1, 'HTTP 503'])
      assert.ok(r1.wait > 0.5 && r1.wait <= 2.1, String(r1.wait))
      await db.execute(sql`UPDATE outbox SET available_at = now() WHERE id = ${r1.id}`)
      await settleAll()
      const [r2] = (await db.execute(sql`SELECT state, attempts FROM outbox WHERE id = ${r1.id}`)) as unknown as { state: string; attempts: number }[]
      assert.deepEqual([r2.state, r2.attempts], ['done', 2])
      assert.equal(received.filter((x) => x.body.includes('retry body')).length, 2)
    })

    it('purge keeps finished rows for the dedupe window and dead rows longer', async () => {
      const ids = (await db.execute(sql`
        INSERT INTO outbox (topic, payload, state, finished_at, dedupe_key) VALUES
          ('webhook', '{}', 'done', now() - interval '8 days', ${`t:${crypto.randomUUID()}`}),
          ('webhook', '{}', 'done', now() - interval '1 day', ${`t:${crypto.randomUUID()}`}),
          ('notify', '{}', 'dead', now() - interval '8 days', NULL),
          ('notify', '{}', 'dead', now() - interval '31 days', NULL)
        RETURNING id::text AS id
      `)) as unknown as { id: string }[]
      await outbox.purgeOutbox(new Date())
      const left = (await db.execute(sql`
        SELECT id::text AS id FROM outbox WHERE id = ANY(${`{${ids.map((i) => i.id).join(',')}}`}::bigint[]) ORDER BY id
      `)) as unknown as { id: string }[]
      assert.deepEqual(left.map((l) => l.id), [ids[1].id, ids[2].id])
      await db.execute(sql`DELETE FROM outbox WHERE id = ANY(${`{${ids.map((i) => i.id).join(',')}}`}::bigint[])`)
    })
  })
})
