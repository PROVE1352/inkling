/**
 * Weight tuning on the dev questions only (docs/adr/1213-*), on the data a context-bench.ts run left
 * in a scratch database. Not part of CI.
 *
 *   DATABASE_URL=postgres://…/scratch npx tsx scripts/context-tune.ts <bigWs> <smallWs> <userId> '[{"WEIGHTS":{"adjacent":0.3}}, …]'
 *
 * Each config object overrides fields of rank.ts WEIGHTS / BM25 / DIVERSITY / FLOOR for one run.
 */
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
import { sql } from 'drizzle-orm'

async function main() {
  const [bigWs, smallWs, userId, configsJson] = process.argv.slice(2)
  const rank = await import('../src/context/rank')
  const { findContext } = await import('../src/context/retrieve')
  const { renderFindContext } = await import('../src/mcpTools/contextTools')
  const { scoreRanking } = await import('../src/context/evalRun')
  const { EVAL_QUESTIONS } = await import('../src/context/evalSet')
  const { estimateTokens } = await import('../src/context/tokens')
  const { db, closeDb } = await import('../src/db/index')
  const dev = EVAL_QUESTIONS.filter((q) => q.split === 'dev')
  const ids = async (ws: string) => {
    const rows = (await db.execute(sql`SELECT id, title FROM pages WHERE workspace_id = ${ws}`)) as unknown as { id: string; title: string }[]
    return new Map(rows.map((r) => [r.title, r.id]))
  }
  const sets: [string, string, Map<string, string>][] = [
    ['big', bigWs, await ids(bigWs)],
    ['small', smallWs, await ids(smallWs)],
  ]
  const base = JSON.parse(JSON.stringify({ WEIGHTS: rank.WEIGHTS, BM25: rank.BM25, DIVERSITY: rank.DIVERSITY, FLOOR: rank.FLOOR }))
  const configs = JSON.parse(configsJson || '[{}]') as Record<string, Record<string, number>>[]
  for (const cfg of configs) {
    for (const k of ['WEIGHTS', 'BM25', 'DIVERSITY', 'FLOOR'] as const) Object.assign(rank[k], base[k], cfg[k] ?? {})
    const line: string[] = [JSON.stringify(cfg)]
    const misses: string[] = []
    for (const [name, ws, idOf] of sets) {
      let mrr = 0, r5 = 0, nd = 0, p5 = 0, p5std = 0, body = 0
      for (const q of dev) {
        const rel = [{ pageId: idOf.get(q.page)!, anchor: q.anchor }, ...(q.also ?? []).map((a) => ({ pageId: idOf.get(a.page)!, anchor: a.anchor }))]
        const r = await findContext({ userId, query: q.q, workspaceIds: [ws] })
        const m = scoreRanking(renderFindContext(q.q, r), rel)
        mrr += m.mrr; r5 += m.recallAt5; nd += m.ndcgAt5; p5 += m.precisionAt5
        p5std += (m.precisionAt5 * Math.min(5, m.shown)) / 5
        if (name === 'big' && m.firstRank !== 1) misses.push(`${m.firstRank}/${m.shown} ${q.q}`)
        const r15 = await findContext({ userId, query: q.q, workspaceIds: [ws], budget: 1500 })
        for (const f of r15.fragments) body += estimateTokens(f.text.split('\n').filter((l) => !l.startsWith('§')).join('\n'))
      }
      const n = dev.length
      const f = (v: number) => (v / n).toFixed(3)
      line.push(`${name}: MRR ${f(mrr)} R@5 ${f(r5)} nDCG@5 ${f(nd)} P@5 ${f(p5)} (std ${f(p5std)}) body1500 ${(body / n).toFixed(0)}`)
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
