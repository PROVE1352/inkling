/**
 * Split / rotation benchmark (docs/adr/1140-*, 1141-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/split-bench.ts [--state page.bin] [--out x.json]
 *
 * In-process, like large-page-bench.ts: the test app (real /api routes + Hocuspocus) and an MCP
 * client over the in-memory transport, in a migrated SCRATCH database (never cleans up). Pages: SYN =
 * the synthetic 4.1 MB experiment log of large-page-bench (181 h2 sections) and, with --state, FILE =
 * a Yjs state read from disk (only numbers are printed). Per page:
 *   - split preview (POST /pages/:id/split preview) and split itself at the level with the most
 *     top-level headings (1–3), on a fresh copy per run, with the document not loaded and with it
 *     open in another connection; wall time, event-loop max (2 ms resolution) and a probe
 *     (GET /backlinks of a small page every 10 ms) during the call;
 *   - the append path: POST /content alone (what update_page did before) vs POST
 *     /pages/:id/rotation/target + POST /content (what it does now), interleaved, on a small page
 *     and on the large page; the target route alone; and update_page append into a page that
 *     rotates monthly (the write lands in the small month subpage) vs into the large page itself.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-split-bench-${process.pid}`

import { readFileSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const STATE_FILE = arg('--state')
const OUT = arg('--out')
const PAGES = STATE_FILE ? ['SYN', 'FILE'] : ['SYN']
const N_SPLIT = Number(process.env.N_SPLIT || 5)
const N_APPEND = Number(process.env.N_APPEND || 20)

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const KO = ['실험', '결과', '학습', '검증', '손실', '모델', '데이터', '설정', '비교', '기준', '개선', '분석', '오차', '예측', '특징', '가중치', '배치', '정규화', '조기', '종료']
const EN = ['run', 'loss', 'val', 'epoch', 'lr', 'batch', 'seed', 'baseline', 'ablation', 'feature', 'lag', 'window', 'ridge', 'gbm', 'mlp', 'score', 'rmse', 'mae']
function words(r: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(r() < 0.55 ? KO[Math.floor(r() * KO.length)] : EN[Math.floor(r() * EN.length)])
  return out.join(' ')
}
const t = (text: string) => [{ type: 'text', text, styles: {} }]
// Same generator as large-page-bench.ts (synthBlocks), so SYN is the same 4.1 MB page.
function synthBlocks(sections = 180, seed = 7): Record<string, unknown>[] {
  const r = rng(seed)
  const blocks: Record<string, unknown>[] = [{ type: 'paragraph', content: t(`Experiment log ${words(r, 30)}`) }]
  for (let s = 1; s <= sections; s++) {
    blocks.push({ type: 'heading', props: { level: 2 }, content: t(`Run ${String(s).padStart(3, '0')} ${words(r, 3)}`) })
    blocks.push({ type: 'paragraph', content: t(words(r, 90)) })
    const rows = []
    for (let i = 0; i < 14; i++) rows.push({ cells: Array.from({ length: 6 }, () => t(i === 0 ? words(r, 1) : `${words(r, 2)} ${(r() * 1000).toFixed(2)}`)) })
    blocks.push({ type: 'table', content: { type: 'tableContent', rows } })
    for (let i = 0; i < 6; i++) blocks.push({ type: 'bulletListItem', content: t(words(r, 14)) })
    blocks.push({ type: 'paragraph', content: t(words(r, 70)) })
    if (s === sections) blocks.push({ type: 'paragraph', content: t(`final check ${words(r, 10)}`) })
  }
  return blocks
}

const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const { sql } = await import('drizzle-orm')
const schema = await import('../src/db/schema')
const collab = await import('../src/collab')
const conv = await import('../src/md/convert')
const { reindexPageChunks } = await import('../src/context/chunkIndex')
const { reindexPageText } = await import('../src/md/textIndex')
const { flushDocIndexes } = await import('../src/docIndexer')
const { planSplit } = await import('../src/md/splitDoc')
const { docFromStoredState } = await import('../src/yState')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(1)
}
const el = monitorEventLoopDelay({ resolution: 2 })
el.enable()

const app = await h.buildTestApp()
const owner = await h.makeUser('bench')
const ws = await h.makeWorkspace(owner, [])
const mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
const small = await h.makeDocPage(ws.id, owner.id, 'Small', [{ type: 'paragraph', content: t('hello') }] as never)

function probe() {
  const lat: number[] = []
  let stop = false
  const run = (async () => {
    while (!stop) {
      const t0 = performance.now()
      const r = await app.inject({ method: 'GET', url: `/api/pages/${small.id}/backlinks`, headers: { cookie: owner.cookie } })
      if (r.statusCode !== 200) throw new Error(`probe ${r.statusCode}`)
      lat.push(performance.now() - t0)
      await sleep(10)
    }
  })()
  return { lat, done: async () => ((stop = true), await run) }
}

const out: Record<string, unknown> = { node: process.version }
const save = () => (OUT ? writeFileSync(OUT, JSON.stringify(out, null, 1)) : undefined)

/** Runs `fn` n times (after one warm-up unless warm=false) and records latency, loop and probe. */
async function measure(name: string, n: number, fn: (i: number) => Promise<number>, warm = true) {
  if (warm) await fn(-1)
  await sleep(50)
  el.reset()
  const pr = probe()
  const lat: number[] = []
  for (let i = 0; i < n; i++) lat.push(await fn(i))
  await pr.done()
  const r = {
    n,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    max: pct(lat, 1),
    loopMaxMs: +(el.max / 1e6).toFixed(1),
    probeP50: pct(pr.lat, 0.5),
    probeP95: pct(pr.lat, 0.95),
  }
  out[name] = r
  console.log(name.padEnd(40), JSON.stringify(r))
  save()
}

async function makeBig(title: string, state: Uint8Array) {
  const [p] = await db.insert(schema.pages).values({ workspaceId: ws.id, title, createdBy: owner.id, kind: 'doc' }).returning()
  await db.insert(schema.pageDocs).values({ pageId: p.id, state: Buffer.from(state) })
  const blocks = conv.stateToBlocks(state)
  await reindexPageText(p.id, blocks)
  await reindexPageChunks(p.id, blocks, { log: false })
  return p.id as string
}

async function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const r = await app.inject({ method, url: `/api${url}`, headers: { cookie: owner.cookie }, ...(payload === undefined ? {} : { payload: payload as object }) })
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`)
  return r
}

for (const which of PAGES) {
  const state = which === 'FILE' ? new Uint8Array(readFileSync(STATE_FILE!)) : new Uint8Array(conv.blocksToStateBuffer(synthBlocks() as never))
  const probeDoc = docFromStoredState(state)
  const levels = planSplit(probeDoc, 2).levels
  probeDoc.destroy()
  const level = [1, 2, 3].sort((a, b) => levels[b - 1] - levels[a - 1])[0]
  out[`${which}_page`] = { stateBytes: state.length, levels, level }
  console.log(which, JSON.stringify(out[`${which}_page`]))

  // Split preview (no write) on one copy.
  const pv = await makeBig(`Preview ${which}`, state)
  let sections = 0
  await measure(`${which} split preview`, 10, async () => {
    const t0 = performance.now()
    const r = await inject('POST', `/pages/${pv}/split`, { level, preview: true })
    sections = (r.json() as { sections: unknown[] }).sections.length
    return performance.now() - t0
  })
  out[`${which}_sections`] = sections

  // Per-phase times of every split (route hook), summed per measurement.
  const phases: Record<string, number[]> = {}
  let last = 0
  const { splitTestHooks, flushSplitIndexing } = await import('../src/routes/splitPage')
  splitTestHooks.phase = (name) => {
    const now = performance.now()
    ;(phases[name] ??= []).push(now - last)
    last = now
  }
  const phaseReport = (key: string) => {
    out[key] = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, { p50: pct(v, 0.5), max: pct(v, 1) }]))
    console.log(key.padEnd(40), JSON.stringify(out[key]))
    for (const k of Object.keys(phases)) delete phases[k]
  }

  // Split: a fresh copy per run, document not loaded.
  const copies: string[] = []
  for (let i = 0; i < N_SPLIT; i++) copies.push(await makeBig(`Split ${which} ${i}`, state))
  await flushDocIndexes()
  await measure(`${which} split (not open)`, N_SPLIT, async (i) => {
    const t0 = performance.now()
    last = t0
    await inject('POST', `/pages/${copies[i]}/split`, { level })
    const ms = performance.now() - t0
    await flushSplitIndexing()
    await flushDocIndexes()
    return ms
  }, false)
  phaseReport(`${which} split (not open) phases`)

  // Split while another connection has the document open.
  const open: string[] = []
  for (let i = 0; i < N_SPLIT; i++) open.push(await makeBig(`Split open ${which} ${i}`, state))
  await flushDocIndexes()
  await measure(`${which} split (open elsewhere)`, N_SPLIT, async (i) => {
    const conn = await collab.hocuspocus.openDirectConnection(open[i])
    await sleep(20)
    const t0 = performance.now()
    last = t0
    await inject('POST', `/pages/${open[i]}/split`, { level })
    const ms = performance.now() - t0
    await conn.disconnect()
    await flushSplitIndexing()
    await flushDocIndexes()
    return ms
  }, false)
  phaseReport(`${which} split (open elsewhere) phases`)
  const kids = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE parent_id = ${copies[0]}`)) as unknown as { n: number }[]
  const left = (await db.execute(sql`SELECT octet_length(state)::int AS b FROM page_docs WHERE page_id = ${copies[0]}`)) as unknown as { b: number }[]
  out[`${which}_after_split`] = { subpages: kids[0].n, pageStateBytesAfter: left[0].b }
  console.log(which, 'after split', JSON.stringify(out[`${which}_after_split`]))

  // Append path: before (content only) vs after (rotation target + content), interleaved.
  const big = await makeBig(`Append ${which}`, state)
  await flushDocIndexes()
  for (const [label, page] of [['small', small.id], ['large', big]] as const) {
    // hint already sent for the large page, like every append after the first
    await inject('POST', `/pages/${page}/rotation/target`)
    const before: number[] = []
    const after: number[] = []
    const tgt: number[] = []
    const plain = async (i: number) => {
      const a = performance.now()
      await inject('POST', `/pages/${page}/content`, { markdown: `entry ${i}`, mode: 'append' })
      if (i >= 0) before.push(performance.now() - a)
    }
    const routed = async (i: number) => {
      const b = performance.now()
      await inject('POST', `/pages/${page}/rotation/target`)
      const c = performance.now()
      await inject('POST', `/pages/${page}/content`, { markdown: `entry ${i}b`, mode: 'append' })
      if (i >= 0) {
        after.push(performance.now() - b)
        tgt.push(c - b)
      }
    }
    // Interleaved, alternating which one goes first, with a pause so index passes settle.
    for (let i = -1; i < N_APPEND; i++) {
      if (i % 2 === 0) {
        await plain(i)
        await flushDocIndexes()
        await routed(i)
      } else {
        await routed(i)
        await flushDocIndexes()
        await plain(i)
      }
      await flushDocIndexes()
      await sleep(20)
    }
    const r = {
      n: N_APPEND,
      beforeP50: pct(before, 0.5),
      beforeP95: pct(before, 0.95),
      afterP50: pct(after, 0.5),
      afterP95: pct(after, 0.95),
      targetP50: pct(tgt, 0.5),
      targetP95: pct(tgt, 0.95),
    }
    out[`${which} append ${label}`] = r
    console.log(`${which} append ${label}`.padEnd(40), JSON.stringify(r))
    save()
  }

  // update_page append: into the large page itself vs into a page that rotates monthly.
  const rot = await makeBig(`Rotating ${which}`, state)
  await inject('PUT', `/pages/${rot}/rotation`, { mode: 'month' })
  const self = await makeBig(`Self ${which}`, state)
  await flushDocIndexes()
  for (const [label, page] of [['into the large page', self], ['monthly rotation', rot]] as const) {
    await measure(`${which} update_page ${label}`, N_APPEND, async (i) => {
      const t0 = performance.now()
      const r = await mcp.tool('update_page', { pageId: page, mode: 'append', markdown: `## Run x${i}\n\nresult ${i}` })
      if (r.isError) throw new Error(r.text)
      return performance.now() - t0
    })
  }
}

await flushDocIndexes()
await collab.destroyCollab()
await app.close()
await closeDb()
save()
