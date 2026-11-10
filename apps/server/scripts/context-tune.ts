/**
 * Weight tuning on the dev questions only (docs/adr/1213-*), on the data a context-bench.ts run left
 * in a scratch database. Not part of CI.
 *
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/context-tune.ts <bigWs> <smallWs> <userId> '[{"WEIGHTS":{"adjacent":0.3}}, …]'
 *
 * Each config object overrides fields of rank.ts WEIGHTS / BM25 / DIVERSITY / FLOOR / PACKING /
 * SECTION_RULES / QUERY_FORMS for one run; `{"RRF":{"k":10}}` sets the RRF constant of the
 * queries=[…] questions (docs/adr/1905-*). Questions run at their own budget (EvalQuestion.budget) and
 * once more all at 1,000 tokens; bundles (EvalQuestion.queries) are merged with fuseContextResults as
 * the route does. Rendering is renderFindContext without the MCP facts (no can:/edited by).
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
import { sql } from 'drizzle-orm'

async function main() {
  const [bigWs, smallWs, userId, configsJson] = process.argv.slice(2)
  const rank = await import('../src/context/rank')
  const { findContext } = await import('../src/context/retrieve')
  const { fuseContextResults, RRF_K } = await import('../src/context/multiQuery')
  const { renderFindContext } = await import('../src/mcpTools/contextTools')
  const { scoreRanking, answerInBody } = await import('../src/context/evalRun')
  const { EVAL_QUESTIONS } = await import('../src/context/evalSet')
  const { estimateTokens } = await import('../src/context/tokens')
  const { db, closeDb } = await import('../src/db/index')
  const split = process.env.SPLIT === 'test' ? 'test' : 'dev' // test only for the one final look
  const dev = EVAL_QUESTIONS.filter((q) => q.split === split)
  const ids = async (ws: string) => {
    const rows = (await db.execute(sql`SELECT id, title FROM pages WHERE workspace_id = ${ws}`)) as unknown as { id: string; title: string }[]
    return new Map(rows.map((r) => [r.title, r.id]))
  }
  const sets: [string, string, Map<string, string>][] = [
    ['big', bigWs, await ids(bigWs)],
    ['small', smallWs, await ids(smallWs)],
  ]
  const knobs = ['WEIGHTS', 'BM25', 'DIVERSITY', 'FLOOR', 'PACKING', 'SECTION_RULES', 'QUERY_FORMS'] as const
  const base = JSON.parse(JSON.stringify(Object.fromEntries(knobs.map((k) => [k, rank[k]]))))
  const configs = JSON.parse(configsJson || '[{}]') as Record<string, Record<string, number | boolean>>[]
  for (const cfg of configs) {
    for (const k of knobs) Object.assign(rank[k], base[k], cfg[k] ?? {})
    const k = Number(cfg.RRF?.k ?? RRF_K)
    const line: string[] = [JSON.stringify(cfg)]
    const misses: string[] = []
    for (const [name, ws, idOf] of sets) {
      for (const budgetOverride of name === 'big' ? [undefined, 1000] : [undefined]) {
        let mrr = 0, r5 = 0, nd = 0, p5 = 0, body = 0, tok = 0
        const lat: number[] = []
        for (const q of dev) {
          const rel = [{ pageId: idOf.get(q.page)!, anchor: q.anchor }, ...(q.also ?? []).map((a) => ({ pageId: idOf.get(a.page)!, anchor: a.anchor }))]
          const budget = budgetOverride ?? q.budget
          const queries = [q.q, ...(q.queries ?? [])]
          const t0 = performance.now()
          const per = await Promise.all(queries.map((query) => findContext({ userId, query, workspaceIds: [ws], budget })))
          const r = queries.length > 1 ? fuseContextResults(per, { queries, budget: per[0].budget, k }) : per[0]
          lat.push(performance.now() - t0)
          const out = renderFindContext(q.q, r)
          const m = scoreRanking(out, rel)
          const inBody = answerInBody(out, q)
          mrr += m.mrr; r5 += m.recallAt5; nd += m.ndcgAt5; p5 += m.precisionAt5
          body += inBody ? 1 : 0
          tok += estimateTokens(out)
          if (name === 'big' && (m.firstRank !== 1 || !inBody)) misses.push(`${budgetOverride ? 'b1000 ' : ''}${m.firstRank}/${m.shown}${inBody ? '' : ' nobody'} ${q.q}`)
        }
        const n = dev.length
        const f = (v: number) => (v / n).toFixed(3)
        lat.sort((a, b) => a - b)
        line.push(`${name}${budgetOverride ? '@1000' : ''}: MRR ${f(mrr)} R@5 ${f(r5)} nDCG@5 ${f(nd)} P@5 ${f(p5)} body ${f(body)} tok ${(tok / n).toFixed(0)} p50 ${lat[Math.floor(n / 2)].toFixed(1)}ms`)
      }
    }
    console.log(line.join(' | '))
    console.log('  misses(big):', misses.join(' ; '))
  }
  await closeDb()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
