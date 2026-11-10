// run-tests: db-exclusive
// Row numbers of a bulk insert in one transaction (migration 0058, docs/adr/2320-*): the n-th bump of one
// collection's counter goes straight to the version this transaction wrote last, so a 20,000-row insert
// under one ID collection costs the same per statement at its end as at its start. With the 0051 function
// the cost per row grew with the number of rows already inserted (each bump walked the versions left behind:
// 50,000 rows in 50 statements took 41.1 s instead of 3.7 s).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] row numbers: bulk insert in one transaction stays linear', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  after(async () => {
    await closeDb()
  })

  const tag = `${Date.now()}-${process.pid}`
  const [u] = (await db.execute(sql`
    INSERT INTO users (email, name, password_hash) VALUES (${`rowbulk-${tag}@x.test`}, 'rowbulk', 'x') RETURNING id
  `)) as unknown as { id: string }[]
  const [w] = (await db.execute(sql`
    INSERT INTO workspaces (name, invite_code) VALUES ('rowbulk', ${`rowbulk-${tag}`}) RETURNING id
  `)) as unknown as { id: string }[]

  async function idCollection(): Promise<string> {
    const [p] = (await db.execute(sql`
      INSERT INTO pages (workspace_id, kind, title, created_by) VALUES (${w!.id}, 'collection', 'bulk', ${u!.id}) RETURNING id
    `)) as unknown as { id: string }[]
    await db.execute(sql`
      INSERT INTO collections (page_id, fields)
      VALUES (${p!.id}, ${JSON.stringify([{ id: 'u', name: 'ID', type: 'uniqueId' }])}::jsonb)
    `)
    return p!.id
  }

  /** Inserts `rows` rows under a new ID collection in one transaction, `chunk` rows per statement;
   *  returns the time of each statement. */
  async function insertRows(rows: number, chunk = 1000): Promise<{ chunks: number[]; parent: string }> {
    const parent = await idCollection()
    const chunks: number[] = []
    await db.transaction(async (tx) => {
      for (let from = 1; from <= rows; from += chunk) {
        const to = Math.min(rows, from + chunk - 1)
        const t0 = performance.now()
        await tx.execute(sql`
          INSERT INTO pages (workspace_id, parent_id, kind, title, sort_order, created_by)
          SELECT ${w!.id}::uuid, ${parent}::uuid, 'doc', 'r' || g, g, ${u!.id}::uuid FROM generate_series(${from}::int, ${to}::int) g
        `)
        chunks.push(performance.now() - t0)
      }
    })
    return { chunks, parent }
  }

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

  it('20,000 rows: numbered 1..N without gaps, the last 1,000 cost about what the first 1,000 did', async (t) => {
    await insertRows(2000) // warm-up (plan cache, buffers)
    const big = await insertRows(20_000)

    const [s] = (await db.execute(sql`
      SELECT count(*)::int AS n, count(DISTINCT row_number)::int AS d, min(row_number) AS mn, max(row_number) AS mx,
             (SELECT row_seq FROM collections WHERE page_id = ${big.parent}) AS seq
        FROM pages WHERE parent_id = ${big.parent}
    `)) as unknown as { n: number; d: number; mn: number; mx: number; seq: number }[]
    assert.deepEqual({ n: s!.n, d: s!.d, mn: Number(s!.mn), mx: Number(s!.mx), seq: Number(s!.seq) }, { n: 20_000, d: 20_000, mn: 1, mx: 20_000, seq: 20_000 })

    // Linear: a statement late in the transaction costs what an early one did (measured 1.15x). With
    // the 0051 function each bump walked the versions the transaction had left behind, so statement 20
    // cost several times statement 1 (measured 4.5x; the test fails with it). Medians of three statements on each end, and a
    // bound well above the linear case, so a loaded CI machine does not fail it.
    const first = median(big.chunks.slice(0, 3))
    const last = median(big.chunks.slice(-3))
    const ratio = last / first
    const detail = `last/first statement = ${ratio.toFixed(2)} (first ${first.toFixed(1)} ms, last ${last.toFixed(1)} ms, total ${big.chunks.reduce((a, b) => a + b, 0).toFixed(0)} ms)`
    t.diagnostic(detail)
    assert.ok(ratio < 3, detail)
  })
})
