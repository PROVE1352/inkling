/**
 * find_context with several queries (docs/adr/1720-*, docs/PERFORMANCE.md): for each bundle of 3-5
 * phrasings in multiQueryCorpus.ts, N separate find_context calls vs one call with queries=[…]:
 * returned tokens (tokens.ts estimate of the tool text), round trips, answer sections shown, and the
 * tool latency of the bundle (cold cache, then with the per-query entries warm).
 *
 *   cd apps/server && DATABASE_URL=postgres://…/throwaway npx tsx scripts/multi-query-bench.ts [queryShare=0.2] [budget…]
 *
 * queryShare: share of query words in the filler pages (1 = every word, the worst case for RRF).
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import { closeDb } from '../src/db/index'
import * as h from '../src/mcpTools/testHarness'
import { reindexPageChunks } from '../src/context/chunkIndex'
import { drainChangeLog } from '../src/context/changeLog'
import { _resetContextCache } from '../src/context/contextCache'
import * as C from '../src/mcpTools/multiQueryCorpus'

const SHARE = Number(process.argv[2] ?? 0.2)
const BUDGETS = process.argv.slice(3).map(Number).filter(Boolean)
type Blocks = Parameters<typeof h.makeDocPage>[3]

const app = await h.buildTestApp()
const owner = await h.makeUser('Bench Owner')
const ws = await h.makeWorkspace(owner)
const ids = new Map<string, string>()
for (const [title, sections] of Object.entries(C.TOPICS)) {
  const blocks = C.doc(sections)
  const p = await h.makeDocPage(ws.id, owner.id, title, blocks as Blocks)
  await reindexPageChunks(p.id, blocks as never)
  ids.set(title, p.id)
}
for (const f of C.fillerPages(SHARE)) {
  const p = await h.makeDocPage(ws.id, owner.id, f.title, f.blocks as Blocks)
  await reindexPageChunks(p.id, f.blocks as never)
}
await drainChangeLog(500)
const m = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Bench Agent'))

for (const budget of BUDGETS.length ? BUDGETS : [3500, 1200]) {
  _resetContextCache()
  const rows = []
  for (const b of C.BUNDLES) rows.push(await C.measureBundle(m.tool, b, (t) => ids.get(t)!, budget))
  console.log(`\nbudget ${budget}, filler query-word share ${SHARE}, ${Object.keys(C.TOPICS).length} topic + ${C.FILLER} filler pages`)
  console.log(C.measureTable(rows))
  // latency of one bundle call: cold (nothing cached) vs per-query entries warm (bundle entry not)
  const lat = { cold: [] as number[], warm: [] as number[] }
  for (const b of C.BUNDLES) {
    _resetContextCache()
    let t = performance.now()
    await m.tool('find_context', { queries: b.queries, budget })
    lat.cold.push(performance.now() - t)
    _resetContextCache()
    for (const q of b.queries) await m.tool('find_context', { query: q, budget })
    t = performance.now()
    await m.tool('find_context', { queries: b.queries, budget })
    lat.warm.push(performance.now() - t)
  }
  const avg = (xs: number[]) => (xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(1)
  console.log(`bundle call latency (mean of ${C.BUNDLES.length}): cold ${avg(lat.cold)} ms, per-query entries warm ${avg(lat.warm)} ms`)
}
await m.close()
await app.close()
await closeDb()
