/**
 * AI step versions benchmark (docs/adr/2180-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/ai-step-bench.ts [--writes 30] [--label x]
 *
 * In-process test app + an MCP client (in-memory transport) acting as an agent connection. Creates its
 * own user, workspace and pages in a migrated SCRATCH database and never cleans up. Pages: SMALL (a
 * 12-section note, ~6 KB) and SYN (the synthetic 4.1 MB experiment log of large-page-bench.ts, 180
 * sections with tables). On each page the agent makes --writes sequential writes with nothing in
 * between, alternating patch_section replace of one middle section (two texts, so every write changes
 * the page) and update_page append of one line. Reports per tool p50/p95/max wall time (the
 * baseVersion read before each replace is not timed), and the page's version rows afterwards: count,
 * whole rows, raw bytes (octet_length) and on-disk bytes (pg_column_size, after TOAST compression),
 * median row. Uses only APIs both trees have, so the same script runs against the 0.16 tree
 * (`git archive`) for the before numbers.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-aistep-bench-${process.pid}`

import { performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const WRITES = Number(arg('--writes') ?? 30)
const LABEL = arg('--label') ?? 'run'

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
/** large-page-bench.ts synthBlocks (same seed, same 4.1 MB page). */
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
  }
  return blocks
}
function smallBlocks(): Record<string, unknown>[] {
  const r = rng(11)
  const blocks: Record<string, unknown>[] = []
  for (let s = 1; s <= 12; s++) {
    blocks.push({ type: 'heading', props: { level: 2 }, content: t(`Topic ${s}`) })
    blocks.push({ type: 'paragraph', content: t(words(r, 40)) })
    blocks.push({ type: 'bulletListItem', content: t(words(r, 12)) })
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

const app = await h.buildTestApp()
const owner = await h.makeUser('bench')
const ws = await h.makeWorkspace(owner)
const m = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Bench Agent'), { user: { ...owner, via: 'Bench Agent' } })

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
  return { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) }
}

for (const which of ['SMALL', 'SYN'] as const) {
  const blocks = which === 'SYN' ? synthBlocks() : smallBlocks()
  const state = new Uint8Array(conv.blocksToStateBuffer(blocks as never))
  const [p] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: `Bench ${which} ${LABEL}`, createdBy: owner.id, kind: 'doc' }).returning()
  await db.insert(schema.pageDocs).values({ pageId: p.id, state: Buffer.from(state) })
  const parsed = conv.stateToBlocks(state)
  await reindexPageText(p.id, parsed)
  await reindexPageChunks(p.id, parsed, { log: false })
  const sections = chunker.splitSections(parsed)
  const mid = sections[Math.floor(sections.length / 2)].anchor
  const replace: number[] = []
  const append: number[] = []
  for (let i = 0; i < WRITES; i++) {
    if (i % 2 === 0) {
      const outline = (await m.tool('read_page', { pageId: p.id, outline: true })).text
      const v = new RegExp(`§${mid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*v=([0-9a-z]+)`).exec(outline)?.[1]
      const t0 = performance.now()
      const r = await m.tool('patch_section', { pageId: p.id, section: mid, markdown: `rewritten ${i} ${words(rng(i), 40)}`, mode: 'replace', baseVersion: v })
      replace.push(performance.now() - t0)
      if (r.isError) throw new Error(r.text)
    } else {
      const t0 = performance.now()
      const r = await m.tool('update_page', { pageId: p.id, markdown: `log line ${i}`, mode: 'append' })
      append.push(performance.now() - t0)
      if (r.isError) throw new Error(r.text)
    }
  }
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE base_id IS NULL)::int AS whole,
           coalesce(sum(octet_length(state)), 0)::bigint AS raw, coalesce(sum(pg_column_size(state)), 0)::bigint AS disk,
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY octet_length(state)), 0)::int AS "medRaw"
      FROM page_snapshots WHERE page_id = ${p.id}
  `)) as unknown as { n: number; whole: number; raw: string; disk: string; medRaw: number }[]
  console.log(
    JSON.stringify({
      label: LABEL,
      page: which,
      stateBytes: state.length,
      writes: WRITES,
      patchReplace: stat(replace),
      updateAppend: stat(append),
      versions: { ...rows[0], raw: Number(rows[0].raw), disk: Number(rows[0].disk) },
    }),
  )
}

await m.close()
await collab.destroyCollab()
await app.close()
await closeDb()
