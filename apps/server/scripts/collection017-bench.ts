/**
 * 0.17 collection costs on every page (docs/adr/2140-*, 2141-*; integration of wave 16). Not part of
 * CI. Needs a migrated scratch DATABASE_URL (it does not clean up). The same script runs on a 0.16
 * checkout (`git archive v0.16.0`), so it uses only routes and helpers both have:
 *   - page create        POST /api/pages (a top-level doc): the BEFORE INSERT trigger of migration 0051
 *   - row create         POST /api/pages/:id/collection/rows into a collection without / with an ID field
 *   - props write        PATCH /api/pages/:id/props, two people taking turns: the change log's
 *                        markEdited UPDATE (the last editor changes on every write)
 *   - section write      POST /api/pages/:id/section replace by a person
 *   - query_rows         MCP query_rows (filter + sort, 25 rows) on 2,000 and 20,000 rows, plain fields,
 *                        and on 0.17 also with created time, last edited by and ID fields (the derived
 *                        table that adds the automatic values), and a filter + sort on the ID
 * One warm-up excluded; p50 / p95 over N calls (N env, default 200 / 50 / 15).
 *
 *   cd apps/server && DATABASE_URL=… npx tsx scripts/collection017-bench.ts <label> [--auto]
 *
 * `--auto` (0.17 only) adds the automatic-field variant. Run the two trees interleaved.
 */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-c17bench-${process.pid}`

const label = process.argv[2] ?? 'run'
const withAuto = process.argv.includes('--auto')
const N_FAST = Number(process.env.N ?? 200)
const N_SECTION = Number(process.env.N_SECTION ?? 50)
const N_QUERY = Number(process.env.N_QUERY ?? 15)

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2))
}

async function main() {
  const { mkdirSync } = await import('node:fs')
  const path = await import('node:path')
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('../src/mcpTools/testHarness')
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const ws = await h.makeWorkspace(alice, [bob])
  type U = typeof alice
  const call = async (u: U, method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
    if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 200)}`)
    return r.json() as Record<string, any>
  }
  const out: Record<string, unknown> = { label }
  const timeIt = async (name: string, n: number, fn: (i: number) => Promise<unknown>) => {
    await fn(-1)
    const xs: number[] = []
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      await fn(i)
      xs.push(performance.now() - t0)
    }
    out[name] = { p50: pct(xs, 50), p95: pct(xs, 95), n }
    console.error(`[${label}] ${name}`, JSON.stringify(out[name]))
  }
  const newCollection = async (title: string, fields: unknown[]) => {
    const id = (await call(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title })).page.id as string
    await call(alice, 'PUT', `/pages/${id}/collection/fields`, { fields })
    return id
  }
  const plain = [
    { id: 'st', name: 'Status', type: 'select', options: [{ id: 'a', name: 'A', color: 'gray' }, { id: 'b', name: 'B', color: 'blue' }] },
    { id: 'pts', name: 'Points', type: 'number' },
    { id: 'txt', name: 'Note', type: 'text' },
  ]
  const auto = [
    { id: 'ct', name: 'Created', type: 'createdTime' },
    { id: 'eb', name: 'Editor', type: 'editedBy' },
    { id: 'uid', name: 'ID', type: 'uniqueId', uniqueId: { prefix: 'T' } },
  ]

  // ── per-page writes ───────────────────────────────────────────────────────
  await timeIt('page create', N_FAST, (i) => call(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'doc', title: `p${i}` }))
  const rowsPlain = await newCollection('rows plain', plain)
  await timeIt('row create (no ID field)', N_FAST, (i) => call(alice, 'POST', `/pages/${rowsPlain}/collection/rows`, { title: `r${i}`, props: { pts: i } }))
  if (withAuto) {
    const rowsId = await newCollection('rows with ID', [...plain, ...auto])
    await timeIt('row create (ID field)', N_FAST, (i) => call(alice, 'POST', `/pages/${rowsId}/collection/rows`, { title: `r${i}`, props: { pts: i } }))
  }
  const target = (await call(alice, 'POST', `/pages/${rowsPlain}/collection/rows`, { title: 'target', props: {} })).row.id as string
  await timeIt('props write (editor changes)', N_FAST, (i) => call(i % 2 ? alice : bob, 'PATCH', `/pages/${target}/props`, { props: { pts: i } }))
  const doc = await h.makeDocPage(ws.id, alice.id, 'Section doc', [
    { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'One', styles: {} }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'first', styles: {} }] },
    { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Two', styles: {} }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'second', styles: {} }] },
  ] as never)
  await timeIt('section write (person)', N_SECTION, (i) => call(i % 2 ? alice : bob, 'POST', `/pages/${doc.id}/section`, { ref: 'two', mode: 'replace', markdown: `second, edit ${i}` }))

  // ── query_rows ────────────────────────────────────────────────────────────
  const mcp = await h.connectMcp(app, alice, await h.mintToken(alice))
  const fill = async (collectionId: string, n: number) => {
    const t0 = performance.now()
    for (let i = 0; i < n; i += 1000) {
      const batch = Array.from({ length: Math.min(1000, n - i) }, (_, k) => ({
        id: randomUUID(),
        workspaceId: ws.id,
        parentId: collectionId,
        title: `row ${i + k}`,
        kind: 'doc' as const,
        createdBy: (i + k) % 3 ? alice.id : bob.id,
        props: { st: (i + k) % 2 ? 'a' : 'b', pts: (i + k * 7919) % 1000, txt: `note ${(i + k) % 97}` },
        sortOrder: i + k,
      }))
      await db.insert(schema.pages).values(batch)
    }
    return performance.now() - t0
  }
  for (const n of [2000, 20000]) {
    const variants: [string, unknown[]][] = [['plain', plain]]
    if (withAuto) variants.push(['auto fields', [...plain, ...auto]])
    for (const [name, fields] of variants) {
      const id = (await call(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: `q ${n} ${name}` })).page.id as string
      const inserted = await fill(id, n)
      const t0 = performance.now()
      await call(alice, 'PUT', `/pages/${id}/collection/fields`, { fields })
      const fieldsMs = performance.now() - t0
      out[`insert ${n} rows (${name})`] = { ms: Number(inserted.toFixed(1)), fieldsPutMs: Number(fieldsMs.toFixed(1)) }
      console.error(`[${label}] insert ${n} (${name})`, JSON.stringify(out[`insert ${n} rows (${name})`]))
      await timeIt(`query_rows ${n} (${name})`, N_QUERY, async () => {
        const r = await mcp.tool('query_rows', { collectionId: id, filter: 'Points > 500', sort: 'Points desc', limit: 25 })
        if (r.isError) throw new Error(r.text)
      })
      if (name !== 'plain') {
        // a filter and sort on automatic values: the derived table (only those fields)
        await timeIt(`query_rows ${n} (${name}, filter + sort on ID)`, N_QUERY, async () => {
          const r = await mcp.tool('query_rows', { collectionId: id, filter: 'Points > 500 AND ID > 10', sort: 'ID desc', limit: 25 })
          if (r.isError) throw new Error(r.text)
        })
      }
    }
  }
  await mcp.close()
  console.log(JSON.stringify(out))
  await app.close()
  await closeDb()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
