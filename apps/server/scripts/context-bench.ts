/**
 * Retrieval benchmark on synthetic data (docs/adr/0927-*). Not part of CI.
 *
 *   cd apps/server
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/context-bench.ts --pages 5000
 *
 * Uses a migrated SCRATCH database (it inserts thousands of rows and never cleans up). Builds the
 * evaluation wiki (context/evalSet.ts, padded to typical page length) plus N distractor pages that
 * reuse the wiki's vocabulary, then reports: tokens and tool calls per question (old flow vs
 * find_context), recall, find_context latency p50/p95 vs the old search route,
 * and indexing cost per page.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-bench-${process.pid}`

import { performance } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'

const argPages = Number(process.argv[process.argv.indexOf('--pages') + 1]) || 5000

async function main() {
  const h = await import('../src/mcpTools/testHarness')
  const { db, closeDb } = await import('../src/db/index')
  const schema = await import('../src/db/schema')
  const { EVAL_PAGES, EVAL_QUESTIONS, padPages, fillerText } = await import('../src/context/evalSet')
  const { runEval } = await import('../src/context/evalRun')
  const { findContext } = await import('../src/context/retrieve')
  const { reindexPageChunks } = await import('../src/context/chunkIndex')
  const { blocksToStateBuffer } = await import('../src/md/convert')
  const collab = await import('../src/collab')
  const app = await h.buildTestApp()

  const owner = await h.makeUser('bench')
  const ws = await h.makeWorkspace(owner)
  const mcp = await h.connectMcp(app, owner, await h.mintToken(owner))

  // 1) the evaluation wiki, through the real import path
  const idByTitle = new Map<string, string>()
  const unpaddedIds = new Map<string, string>()
  const wsSmall = await h.makeWorkspace(owner)
  for (const p of EVAL_PAGES) {
    const r = await mcp.tool('create_page', { workspaceId: wsSmall.id, title: p.title, markdown: p.markdown })
    unpaddedIds.set(p.title, JSON.parse(r.text).id)
  }
  for (const p of padPages(EVAL_PAGES)) {
    const r = await mcp.tool('create_page', { workspaceId: ws.id, title: p.title, markdown: p.markdown })
    idByTitle.set(p.title, JSON.parse(r.text).id)
  }
  // a few cross links (realistic pages link to each other; the link-boost experiment in ADR 0927 used them)
  const links: [string, string][] = [
    ['Deploy runbook', 'Incident response'],
    ['Backup policy', '데이터베이스 운영'],
    ['Search architecture', '성능 최적화 노트'],
    ['Mobile app release plan', '주간회의록 2026-10-12'],
  ]
  for (const [a, b] of links) {
    await mcp.tool('update_page', { pageId: idByTitle.get(a)!, mode: 'append', markdown: `See also [[${b}]].` })
  }

  // 2) distractors sharing the wiki's vocabulary
  const vocab = 'deploy rollback backup retention schedule restore paging incident severity limit requests minute plan price member flag rollout search index latency cache session database migration alert error rate vacation approval review release launch beta'.split(' ')
  const vocabKo = '배포 롤백 백업 보존 일정 복구 장애 등급 호출 회의 결정 출시 검색 인덱스 지연 캐시 세션 연결 권한 승인 디자인 성능 정리 대비'.split(' ')
  const headings = ['Overview', 'Schedule', 'Notes', 'Decisions', 'Open questions', 'Rollout', 'Retention', 'Limits', '결정 사항', '일정', '회고', '참고']
  let x = 7
  const rnd = (n: number) => {
    x = (x * 1103515245 + 12345) >>> 0
    return x % n
  }
  const t0 = performance.now()
  const BATCH = 200
  for (let i = 0; i < argPages; i += BATCH) {
    const n = Math.min(BATCH, argPages - i)
    const rows = await db
      .insert(schema.pages)
      .values(Array.from({ length: n }, (_, j) => ({ workspaceId: ws.id, title: `Note ${i + j} ${vocab[rnd(vocab.length)]}`, createdBy: owner.id })))
      .returning({ id: schema.pages.id })
    for (const [j, r] of rows.entries()) {
      const ko = rnd(3) === 0
      const blocks: unknown[] = []
      for (let s = 0; s < 3 + rnd(4); s++) {
        blocks.push({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: headings[rnd(headings.length)], styles: {} }] })
        for (let para = 0; para < 2; para++) {
          const words: string[] = []
          for (let w = 0; w < 40; w++) words.push(rnd(4) === 0 ? (ko ? vocabKo : vocab)[rnd((ko ? vocabKo : vocab).length)] : '')
          const text = `${fillerText(i + j + s + para, 30, ko)} ${words.filter(Boolean).join(' ')}`
          blocks.push({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
        }
      }
      await db.insert(schema.pageDocs).values({ pageId: r.id, state: blocksToStateBuffer(blocks as never) })
      await reindexPageChunks(r.id, blocks as never, { log: false })
    }
  }
  const indexMs = performance.now() - t0
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`)
    await tx.execute(sql`ANALYZE page_chunks`)
    await tx.execute(sql`ANALYZE pages`)
  })
  const [{ n: chunkCount }] = (await db.execute(sql`SELECT count(*)::int AS n FROM page_chunks WHERE workspace_id = ${ws.id}`)) as unknown as { n: number }[]

  // 3) quality and cost
  const small = await runEval(mcp.tool, EVAL_QUESTIONS, unpaddedIds, { workspaceId: wsSmall.id })
  const big = await runEval(mcp.tool, EVAL_QUESTIONS, idByTitle, { workspaceId: ws.id })

  // 4) latency (direct calls; 3 rounds over all questions)
  const lat: number[] = []
  const latOld: number[] = []
  for (let round = 0; round < 3; round++) {
    for (const q of EVAL_QUESTIONS) {
      let s = performance.now()
      await findContext({ userId: owner.id, query: q.q, workspaceIds: [ws.id] })
      lat.push(performance.now() - s)
      s = performance.now()
      await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/search?q=${encodeURIComponent(q.q.split(' ').sort((a, b) => b.length - a.length)[0])}`, headers: { cookie: owner.cookie } })
      latOld.push(performance.now() - s)
    }
  }
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]
  }

  // 6) indexing cost of one edit on a padded page
  const pageId = idByTitle.get('Backup policy')!
  const { stateToBlocks } = await import('../src/md/convert')
  const [doc] = (await db.execute(sql`SELECT state FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { state: Buffer }[]
  const blocks = stateToBlocks(doc.state)
  const editMs: number[] = []
  for (let i = 0; i < 20; i++) {
    const edited = structuredClone(blocks)
    const k = edited.findIndex((b) => JSON.stringify(b.content ?? '').includes('Once a month'))
    ;(edited[k].content as { text: string }[])[0].text = `Edit ${i}: once a month the drill runs.`
    const s = performance.now()
    await reindexPageChunks(pageId, edited, { log: false })
    editMs.push(performance.now() - s)
  }

  // 7) plan of the candidate query
  const plan = (await db.execute(sql`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
    SELECT c.page_id FROM page_chunks c
     WHERE c.workspace_id = ${ws.id} AND c.tsv @@ to_tsquery('simple', ${"'rollback':* | 'deploy':*"})`)) as unknown as { 'QUERY PLAN': string }[]

  const f = (v: number) => (Math.round(v * 100) / 100).toString()
  const lines = [
    `pages: ${argPages} distractors + ${EVAL_PAGES.length} wiki pages, ${chunkCount} chunks (index build ${f(indexMs / 1000)} s)`,
    '',
    '| set | flow | mean tokens | median tokens | mean calls | success | section@1 | section@3 | page@1 | page@3 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    `| unpadded wiki | before | ${small.before.meanTokens} | ${small.before.medianTokens} | ${small.before.meanCalls} | ${f(small.before.success)} | – | – | ${f(small.before.pageAt1)} | ${f(small.before.pageAt3)} |`,
    `| unpadded wiki | after | ${small.after.meanTokens} | ${small.after.medianTokens} | ${small.after.meanCalls} | ${f(small.after.success)} | ${f(small.after.sectionAt1)} | ${f(small.after.sectionAt3)} | ${f(small.after.pageAt1)} | ${f(small.after.pageAt3)} |`,
    `| padded + ${argPages} distractors | before | ${big.before.meanTokens} | ${big.before.medianTokens} | ${big.before.meanCalls} | ${f(big.before.success)} | – | – | ${f(big.before.pageAt1)} | ${f(big.before.pageAt3)} |`,
    `| padded + ${argPages} distractors | after | ${big.after.meanTokens} | ${big.after.medianTokens} | ${big.after.meanCalls} | ${f(big.after.success)} | ${f(big.after.sectionAt1)} | ${f(big.after.sectionAt3)} | ${f(big.after.pageAt1)} | ${f(big.after.pageAt3)} |`,
    '',
    `find_context latency (direct): p50 ${f(pct(lat, 0.5))} ms, p95 ${f(pct(lat, 0.95))} ms; old search route (1 term): p50 ${f(pct(latOld, 0.5))} ms, p95 ${f(pct(latOld, 0.95))} ms`,
    `reindex after a one-section edit (padded page): p50 ${f(pct(editMs, 0.5))} ms, p95 ${f(pct(editMs, 0.95))} ms`,
    '',
    'misses (after, large set):',
    ...big.rows.filter((r) => r.after.sectionRank !== 1).map((r) => `- rank ${r.after.sectionRank} found=${r.after.found}: ${r.q}`),
    '',
    'candidate probe plan:',
    ...plan.map((p) => `  ${p['QUERY PLAN']}`),
  ]
  console.log(lines.join('\n'))
  await mcp.close()
  await collab.destroyCollab()
  await app.close()
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
