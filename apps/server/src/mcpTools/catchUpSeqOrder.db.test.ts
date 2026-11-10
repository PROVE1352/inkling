// run-tests: db-exclusive
// catch_up(since=<time>) starts at the first change-log row logged at or after that time (docs/adr/1520-*).
// Rows of one change-log batch share changed_at, so seq breaks the tie. Before 0.15.1 the query sorted
// by the `seq::text AS seq` output alias, so "100" came before "99": when a batch straddled a power of
// ten, catch_up started one or more rows late and left out a page that changed. Exclusive: it moves the
// change log's sequence to just below the next power of ten (99 and 100 on a fresh database).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] catch_up since a time: seq order across a power of ten', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const { drainChangeLog, CHANGE_LOG_LOCK } = await import('../context/changeLog')

  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  const A = await h.connectMcp(app, alice, await h.mintToken(alice))
  after(async () => {
    await A.close()
    await app.close()
    await closeDb()
  })

  it('a batch whose seqs are 10^k - 1 and 10^k is read from its first row', async () => {
    const first = await h.makeDocPage(ws.id, bob.id, 'Lower seq page', [] as never)
    const second = await h.makeDocPage(ws.id, bob.id, 'Higher seq page', [] as never)
    // their own page_added rows go first, so the two rows below are the only later ones of these pages
    await drainChangeLog()

    // A past instant no other row shares: the batch is logged exactly then and catch_up starts there.
    const since = new Date(Date.now() - 6 * 86_400_000 - Math.floor(Math.random() * 3_600_000))
    const seqs = await db.transaction(async (tx) => {
      // the change-log writer's lock: no other row takes a seq while the sequence is moved
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANGE_LOG_LOCK})`)
      const [cur] = (await tx.execute(sql`SELECT nextval(pg_get_serial_sequence('page_changes', 'seq'))::text AS n`)) as unknown as { n: string }[]
      let p = 10n
      while (p - 1n <= BigInt(cur.n)) p *= 10n
      // the next two values are p - 1 and p (p - 2 >= the value just taken: the sequence only moves forward)
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('page_changes', 'seq'), ${String(p - 2n)}::bigint, true)`)
      const rows = (await tx.execute(sql`
        INSERT INTO page_changes (workspace_id, page_id, anchor, kind, scope, actor_id, changed_at)
        VALUES (${ws.id}::uuid, ${first.id}::uuid, 'notes', 'modified', 'shared', ${bob.id}::uuid, ${since.toISOString()}::timestamptz),
               (${ws.id}::uuid, ${second.id}::uuid, 'notes', 'modified', 'shared', ${bob.id}::uuid, ${since.toISOString()}::timestamptz)
        RETURNING seq::text AS seq
      `)) as unknown as { seq: string }[]
      return rows.map((r) => r.seq).sort((a, b) => Number(a) - Number(b))
    })
    // the precondition, or the test proves nothing: one seq has a digit more than the other
    assert.equal(seqs.length, 2)
    assert.equal(seqs[1].length, seqs[0].length + 1, `seqs ${seqs.join(', ')} do not straddle a power of ten`)
    assert.equal(BigInt(seqs[1]) - BigInt(seqs[0]), 1n)
    const [earliest] = (await db.execute(sql`
      SELECT min(seq)::text AS seq FROM page_changes WHERE changed_at >= ${since.toISOString()}::timestamptz AND changed_at <= ${since.toISOString()}::timestamptz
    `)) as unknown as { seq: string }[]
    assert.equal(earliest.seq, seqs[0], 'the batch is the first thing logged at that instant')

    const r = await A.tool('catch_up', { workspaceId: ws.id, since: since.toISOString(), peek: true })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^2 pages changed \(2 by others/m, r.text)
    assert.match(r.text, /Lower seq page/, `the page of seq ${seqs[0]} is left out:\n${r.text}`)
    assert.match(r.text, /Higher seq page/, r.text)
  })
})
