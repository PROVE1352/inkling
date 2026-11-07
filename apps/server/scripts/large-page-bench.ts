/**
 * Large-page benchmark (docs/adr/1040-1043). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/large-page-bench.ts [--state page.bin] [--label x] [--out x.json]
 *
 * In-process: the test app (real /api routes + Hocuspocus) and an MCP client over the in-memory
 * transport. Creates its own user, workspace and pages in a migrated SCRATCH database (never cleans
 * up). Pages: SYN = a synthetic 4.1 MB experiment log (181 sections, 181 tables, no real data) and,
 * with --state, FILE = a Yjs state read from disk (e.g. a copy of a production page; only numbers are
 * printed). For each page: index coverage (sections in page_chunks, whether a term that occurs only
 * in the last section is found by find_context), then read_page outline / section (two alternating
 * anchors), find_context, 8 concurrent section reads of different anchors, outline/section with the
 * document open (idle live doc), update_page append and patch_section append. Each measurement:
 * one warm-up call excluded, sequential calls, p50/p95/max, event-loop max and p99
 * (monitorEventLoopDelay, 2 ms resolution) and a probe (GET /backlinks of a small page every 10 ms)
 * p50/p95 as "other requests during the call". To compare versions, run the same script against
 * each checkout on the same database and machine, interleaved.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-largepage-bench-${process.pid}`

import { readFileSync, writeFileSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const STATE_FILE = arg('--state')
const LABEL = arg('--label') ?? 'run'
const OUT = arg('--out')
const PAGES = STATE_FILE ? ['SYN', 'FILE'] : ['SYN']
const N_READ = Number(process.env.N_READ || 30)
const N_WRITE = Number(process.env.N_WRITE || 20)

// Synthetic "experiment log" with the shape of the production page (long, many tables), no real data.
const SYN_MARKER = 'zetamarker 최종검증표식'

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
    if (s === sections) blocks.push({ type: 'paragraph', content: t(`final check ${SYN_MARKER} ${words(r, 10)}`) })
  }
  return blocks
}

const h = await import('../src/mcpTools/testHarness')
const { db, closeDb } = await import('../src/db/index')
const schema = await import('../src/db/schema')
const collab = await import('../src/collab')
const conv = await import('../src/md/convert')
const chunker = await import('../src/context/chunker')
const { reindexPageChunks } = await import('../src/context/chunkIndex')
const { reindexPageText } = await import('../src/md/textIndex')

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
const small = await h.makeDocPage(ws.id, owner.id, 'Small', [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', styles: {} }] }])

async function tool(name: string, args: Record<string, unknown>) {
  const t = performance.now()
  const r = await mcp.tool(name, args)
  const ms = performance.now() - t
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 300)}`)
  return { ms, text: r.text }
}

function probe() {
  const lat: number[] = []
  let stop = false
  const run = (async () => {
    while (!stop) {
      const t = performance.now()
      const r = await app.inject({ method: 'GET', url: `/api/pages/${small.id}/backlinks`, headers: { cookie: owner.cookie } })
      if (r.statusCode !== 200) throw new Error(`probe ${r.statusCode}`)
      lat.push(performance.now() - t)
      await sleep(10)
    }
  })()
  return { lat, done: async () => ((stop = true), await run) }
}

const out: Record<string, unknown> = { label: LABEL, node: process.version }
const save = () => (OUT ? writeFileSync(OUT, JSON.stringify(out, null, 1)) : undefined)

async function measure(name: string, n: number, fn: (i: number) => Promise<number>) {
  await fn(-1) // warmup (also the first read that may adopt the index)
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
    loopP99Ms: +(el.percentile(99) / 1e6).toFixed(1),
    probeP50: pct(pr.lat, 0.5),
    probeP95: pct(pr.lat, 0.95),
    probeMax: pct(pr.lat, 1),
    probeN: pr.lat.length,
  }
  out[name] = r
  console.log(name.padEnd(34), JSON.stringify(r))
  save()
}

async function concurrent(name: string, rounds: number, c: number, fn: (i: number) => Promise<number>) {
  await fn(-1)
  el.reset()
  const lat: number[] = []
  const t0 = performance.now()
  for (let r = 0; r < rounds; r++) lat.push(...(await Promise.all(Array.from({ length: c }, (_, k) => fn(r * c + k)))))
  const wall = performance.now() - t0
  const res = { rounds, c, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1), wallMs: +wall.toFixed(0), loopMaxMs: +(el.max / 1e6).toFixed(1) }
  out[name] = res
  console.log(name.padEnd(34), JSON.stringify(res))
  save()
}

/** Index a page the way an import does (both trees): blocks → page_texts + page_chunks. */
async function makeBig(title: string, state: Uint8Array) {
  const [p] = await db.insert(schema.pages).values({ workspaceId: ws.id, title, createdBy: owner.id, kind: 'doc' }).returning()
  await db.insert(schema.pageDocs).values({ pageId: p.id, state: Buffer.from(state) })
  const blocks = conv.stateToBlocks(state)
  await reindexPageText(p.id, blocks)
  await reindexPageChunks(p.id, blocks, { log: false })
  return { id: p.id as string, blocks }
}

for (const which of PAGES) {
  const state = which === 'FILE'
    ? new Uint8Array(readFileSync(STATE_FILE!))
    : new Uint8Array(conv.blocksToStateBuffer(synthBlocks() as never))
  const { id: pageId, blocks } = await makeBig(`Bench ${which}`, state)
  const sections = chunker.splitSections(blocks)
  const mid = sections[Math.floor(sections.length / 2)].anchor
  const last = sections[sections.length - 1]
  const anchors = sections.map((s: { anchor: string }) => s.anchor)
  // Coverage: distinct anchors in page_chunks vs sections; and whether a term only in the last section is found.
  const rows = (await db.execute(sql`SELECT count(DISTINCT anchor)::int AS a, count(*)::int AS n, coalesce(sum(octet_length(text)),0)::int AS bytes FROM page_chunks WHERE page_id = ${pageId}`)) as unknown as { a: number; n: number; bytes: number }[]
  const ptext = (await db.execute(sql`SELECT octet_length(text)::int AS b FROM page_texts WHERE page_id = ${pageId}`)) as unknown as { b: number }[]
  let query: string
  if (which === 'SYN') query = SYN_MARKER
  else {
    const others = new Set<string>()
    for (const s of sections.slice(0, -1)) for (const w of s.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) others.add(w)
    const own = [...new Set(last.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !others.has(w) && !/^\d+$/.test(w))
    query = own.slice(0, 2).join(' ')
  }
  const fc = query ? (await tool('find_context', { query, workspaceId: ws.id })).text : ''
  const tailInPageTexts = which === 'SYN'
    ? ((await db.execute(sql`SELECT (text ILIKE ${'%' + SYN_MARKER + '%'}) AS hit FROM page_texts WHERE page_id = ${pageId}`)) as unknown as { hit: boolean }[])[0]?.hit
    : null
  out[`${which}_coverage`] = {
    stateBytes: state.length,
    sections: sections.length,
    indexedAnchors: rows[0].a,
    chunks: rows[0].n,
    chunkBytes: rows[0].bytes,
    pageTextBytes: ptext[0]?.b ?? null,
    lastSectionTermQueried: !!query,
    lastSectionFoundByFindContext: query ? fc.includes(`§${last.anchor}`) : null,
    searchFindsTailMarker: tailInPageTexts,
  }
  console.log(which, 'coverage', JSON.stringify(out[`${which}_coverage`]))
  save()

  await measure(`${which}_outline`, N_READ, async () => (await tool('read_page', { pageId, outline: true })).ms)
  await measure(`${which}_section`, N_READ, async (i) => (await tool('read_page', { pageId, section: i % 2 ? mid : last.anchor })).ms)
  await measure(`${which}_find_context`, 10, async () => (query ? (await tool('find_context', { query, workspaceId: ws.id })).ms : 0))
  await concurrent(`${which}_section_c8`, 4, 8, async (i) => (await tool('read_page', { pageId, section: anchors[(i * 7 + 3) % anchors.length] })).ms)
  // A browser tab has the page open (idle live document).
  {
    const keep = await collab.hocuspocus.openDirectConnection(pageId)
    await measure(`${which}_outline_live`, 15, async () => (await tool('read_page', { pageId, outline: true })).ms)
    await measure(`${which}_section_live`, 15, async (i) => (await tool('read_page', { pageId, section: i % 2 ? mid : last.anchor })).ms)
    await keep.disconnect()
    await sleep(200)
  }
  await measure(`${which}_update_page_append`, N_WRITE, async (i) => (await tool('update_page', { pageId, mode: 'append', markdown: `Run ${LABEL}-${i}: loss 0.${i + 1} ok` })).ms)
  await measure(`${which}_patch_section_append`, N_WRITE, async (i) => (await tool('patch_section', { pageId, section: mid, mode: 'append', markdown: `Note ${LABEL}-${i}` })).ms)
  // after writes: outline must still be served (index fresh after server-side writes)
  await measure(`${which}_outline_after_writes`, 10, async () => (await tool('read_page', { pageId, outline: true })).ms)
  out[`${which}_rss_mb`] = Math.round(process.memoryUsage().rss / 1048576)
  save()
}

await mcp.close()
await collab.destroyCollab()
await app.close()
await closeDb()
console.log('done', LABEL)
process.exit(0)
