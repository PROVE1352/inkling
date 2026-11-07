/**
 * Version-history and stored-state benchmark (docs/adr/1100-1102). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/snapshot-chain-bench.ts --state page.bin [--stages 50] [--label x] [--out x.json]
 *
 * Replays a page's growth the way an append loop wrote it: the blocks of the Yjs state in --state
 * (e.g. a copy of a production page; only numbers are printed) are split into --stages chunks;
 * the page starts with chunk 1 and every further chunk is appended through the real server path
 * (writeBlocksToDoc → DirectConnection → store hook → index pass). Before each append the
 * auto-snapshot throttle is opened (snapshot rows aged by an hour) so every stage's store takes the
 * auto snapshot of the stored state, as an edit 10+ minutes after the previous one would.
 * Reports: snapshot rows (raw bytes, on-disk bytes = pg_column_size after TOAST compression), the
 * page_docs row, version preview / compare / restore latency on the oldest, middle and newest
 * version, append wall time and event-loop max, and the store + index pass of the final page.
 * Runs against any checkout (only APIs both trees have). Creates its own user/workspace/pages in a
 * migrated SCRATCH database and never cleans up.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-snapbench-${process.pid}`

import { readFileSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const STATE_FILE = arg('--state')
if (!STATE_FILE) throw new Error('--state <file> is required')
const STAGES = Number(arg('--stages') ?? 50)
const LABEL = arg('--label') ?? 'run'
const OUT = arg('--out')
const N_READ = Number(process.env.N_READ || 7)

const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const schema = await import('../src/db/schema')
const collab = await import('../src/collab')
const conv = await import('../src/md/convert')
const snap = await import('../src/snapshotStore')
const docWrite = await import('../src/md/docWrite')
const docIndexer = await import('../src/docIndexer')

// Event-loop delay is recorded when the monitor's timer runs; read it after one timer turn.
const settle = () => new Promise((r) => setTimeout(r, 5))
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(1)
}
const el = monitorEventLoopDelay({ resolution: 2 })
el.enable()
const out: Record<string, unknown> = { label: LABEL, node: process.version, stages: STAGES }
const save = () => (OUT ? writeFileSync(OUT, JSON.stringify(out, null, 1)) : undefined)
const log = (k: string, v: unknown) => {
  out[k] = v
  console.log(k.padEnd(28), JSON.stringify(v))
  save()
}

const app = await h.buildTestApp()
const owner = await h.makeUser('snapbench')
const ws = await h.makeWorkspace(owner, [])

const source = new Uint8Array(readFileSync(STATE_FILE))
const blocks = conv.stateToBlocks(source)
const per = Math.ceil(blocks.length / STAGES)
const chunks: (typeof blocks)[] = []
for (let i = 0; i < blocks.length; i += per) chunks.push(blocks.slice(i, i + per))
log('source', { stateBytes: source.length, topLevelBlocks: blocks.length, stages: chunks.length, blocksPerStage: per })

const [page] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Snapshot bench ${LABEL}`, createdBy: owner.id, kind: 'doc' }).returning()
const pageId = page.id as string
await db.insert(schema.pageDocs).values({ pageId, state: conv.blocksToStateBuffer(chunks[0]) })

// --- growth: one append per stage, auto snapshot of the stored state before each store --------
const appendMs: number[] = []
const appendLoop: number[] = []
for (let s = 1; s < chunks.length; s++) {
  await db.execute(sql`UPDATE page_snapshots SET created_at = created_at - interval '1 hour' WHERE page_id = ${pageId}`)
  snap.forgetSnapshotThrottle(pageId)
  el.reset()
  const t = performance.now()
  await docWrite.writeBlocksToDoc(pageId, chunks[s] as never, 'append')
  appendMs.push(performance.now() - t)
  await settle()
  appendLoop.push(el.max / 1e6)
}
// the final state also becomes a version (the 50th row)
await db.execute(sql`UPDATE page_snapshots SET created_at = created_at - interval '1 hour' WHERE page_id = ${pageId}`)
snap.forgetSnapshotThrottle(pageId)
await snap.maybeAutoSnapshotStored(pageId)
log('append', { n: appendMs.length, p50: pct(appendMs, 0.5), p95: pct(appendMs, 0.95), max: pct(appendMs, 1), loopMaxP50: pct(appendLoop, 0.5), loopMaxMax: pct(appendLoop, 1) })

// --- storage ------------------------------------------------------------------------------------
const rows = (await db.execute(sql`
  SELECT id, octet_length(state)::int AS raw, pg_column_size(state)::int AS disk, created_at
    FROM page_snapshots WHERE page_id = ${pageId} ORDER BY created_at, id
`)) as unknown as { id: string; raw: number; disk: number }[]
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
let chain: unknown = null
try {
  chain = ((await db.execute(sql`
    SELECT count(*) FILTER (WHERE base_id IS NULL)::int AS whole, count(*) FILTER (WHERE base_id IS NOT NULL)::int AS diffs, max(depth)::int AS "maxDepth"
      FROM page_snapshots WHERE page_id = ${pageId}
  `)) as unknown as unknown[])[0]
} catch {
  chain = 'n/a (no chain columns)'
}
log('snapshots', {
  rows: rows.length,
  rawTotal: sum(rows.map((r) => r.raw)),
  diskTotal: sum(rows.map((r) => r.disk)),
  rawLast: rows.at(-1)?.raw,
  diskLast: rows.at(-1)?.disk,
  rawMedian: pct(rows.map((r) => r.raw), 0.5),
  diskMedian: pct(rows.map((r) => r.disk), 0.5),
  chain,
})
const [d] = (await db.execute(sql`
  SELECT octet_length(state)::int AS raw, pg_column_size(state)::int AS disk, get_byte(state, 0) AS first FROM page_docs WHERE page_id = ${pageId}
`)) as unknown as { raw: number; disk: number; first: number }[]
log('page_docs', { raw: d.raw, disk: d.disk, format: d.first === 0 ? 'V2' : 'V1' })

// --- version reads ------------------------------------------------------------------------------
const cookie = owner.cookie
async function timed(n: number, fn: () => Promise<{ statusCode: number; body: string }>) {
  const lat: number[] = []
  const loop: number[] = []
  await fn() // warm-up
  for (let i = 0; i < n; i++) {
    el.reset()
    const t = performance.now()
    const r = await fn()
    lat.push(performance.now() - t)
    await settle()
    loop.push(el.max / 1e6)
    if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body.slice(0, 200)}`)
  }
  return { n, p50: pct(lat, 0.5), p95: pct(lat, 0.95), loopMax: pct(loop, 1) }
}
const pick = { oldest: rows[0].id, middle: rows[Math.floor(rows.length / 2)].id, newest: rows.at(-1)!.id }
for (const [name, sid] of Object.entries(pick)) {
  log(`preview_${name}`, await timed(N_READ, () => app.inject({ method: 'GET', url: `/api/pages/${pageId}/snapshots/${sid}/preview`, headers: { cookie } })))
}
log('diff_middle_vs_current', await timed(N_READ, () => app.inject({ method: 'GET', url: `/api/pages/${pageId}/snapshots/${pick.middle}/diff`, headers: { cookie } })))
log('diff_oldest_vs_newest', await timed(N_READ, () => app.inject({ method: 'GET', url: `/api/pages/${pageId}/snapshots/${pick.oldest}/diff?against=${pick.newest}`, headers: { cookie } })))

// --- store + index pass of the final page --------------------------------------------------------
// store: an edit through a DirectConnection (load, one-paragraph change, store on transact and on
// disconnect, index pass); index: the immediate pass alone on the stored bytes.
{
  const lat: number[] = []
  const loop: number[] = []
  for (let i = 0; i < N_READ + 1; i++) {
    el.reset()
    const t = performance.now()
    await docWrite.writeBlocksToDoc(pageId, [{ type: 'paragraph', content: [{ type: 'text', text: `edit ${i}`, styles: {} }] }] as never, 'append')
    const ms = performance.now() - t
    await settle()
    if (i > 0) {
      lat.push(ms)
      loop.push(el.max / 1e6)
    }
  }
  log('edit_store_index', { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), loopMax: pct(loop, 1) })
  const [cur] = (await db.execute(sql`SELECT state FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { state: Buffer }[]
  // Signatures are fresh (the edits above just indexed), so the pass is the decode, conversion,
  // chunking and hashing with no index writes: the part the format and the single decode change.
  const idx: number[] = []
  for (let i = 0; i < N_READ + 1; i++) {
    const t = performance.now()
    await docIndexer.scheduleDocIndex(pageId, cur.state, true)
    if (i > 0) idx.push(performance.now() - t)
  }
  log('index_pass', { n: idx.length, p50: pct(idx, 0.5), p95: pct(idx, 0.95), stateBytes: cur.state.length })
}

// restore last: it rewrites the page
log('restore_middle', await timed(3, () => app.inject({ method: 'POST', url: `/api/pages/${pageId}/snapshots/${pick.middle}/restore`, headers: { cookie, 'content-type': 'application/json' }, payload: '{}' })))
log('rss_mb', Math.round(process.memoryUsage().rss / 1048576))

await collab.destroyCollab()
await app.close()
await closeDb()
console.log('done', LABEL)
process.exit(0)
