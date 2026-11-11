// Recall set of 0.20 (docs/adr/2400-*–2403-*): questions written the way a person remembers a page,
// asked without a workspace over three workspaces of fictional notes. Logs the rank metrics and holds
// the floor the shorter-form, rare-word and title-df rules reached; scripts/context-bench.ts runs the
// same set next to the padded wiki and 5,000 distractor pages.
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] find_context recall set: partial titles, rare words, several workspaces', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb } = await import('../db/index')
  const collab = await import('../collab')
  const { evalPageKey } = await import('./evalSet')
  const { RECALL_PAGES, RECALL_QUESTIONS } = await import('./evalRecallSet')
  const { runRankEval } = await import('./evalRun')
  const rank = await import('./rank')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const user = await h.makeUser('recall')
  const mcp = await h.connectMcp(app, user, await h.mintToken(user))
  const wsByLabel = new Map<string, string>()
  const ids = new Map<string, string>()
  for (const p of RECALL_PAGES) {
    const label = p.workspace!
    if (!wsByLabel.has(label)) wsByLabel.set(label, (await h.makeWorkspace(user, [], `Recall ${label}`)).id)
    const r = await mcp.tool('create_page', { workspaceId: wsByLabel.get(label)!, title: p.title, markdown: p.markdown })
    assert.equal(r.isError, false, r.text)
    ids.set(evalPageKey(p), (JSON.parse(r.text) as { id: string }).id)
  }

  it('page@3 and MRR over the recall set; every rule switched off ranks worse', async () => {
    const on = await runRankEval(mcp.tool, RECALL_QUESTIONS, ids)
    console.log('[recall] dev ', JSON.stringify(on.dev))
    console.log('[recall] test', JSON.stringify(on.test))
    for (const r of on.rows.filter((x) => x.pageRank !== 1)) console.log('[recall] page', r.pageRank, r.tag, r.q)
    assert.ok(on.dev.pageAt3 >= 0.9 && on.test.pageAt3 >= 0.85, 'page@3')
    assert.ok(on.dev.pageMrr >= 0.85 && on.test.pageMrr >= 0.8, 'page MRR')

    // the 0.19 ranking on the same data (results are cached per query: ask with a new budget)
    const saved = { ...rank.WORD_RULES }
    Object.assign(rank.WORD_RULES, { partialTitle: 0, partialHeading: 0, partialCover: 0, rareFactor: 1, titleDf: false })
    try {
      const off = await runRankEval(mcp.tool, RECALL_QUESTIONS, ids, { budget: 3499 })
      console.log('[recall] off dev ', JSON.stringify(off.dev))
      console.log('[recall] off test', JSON.stringify(off.test))
      assert.ok(on.dev.pageMrr + on.test.pageMrr > off.dev.pageMrr + off.test.pageMrr, 'the rules help on this set')
    } finally {
      Object.assign(rank.WORD_RULES, saved)
    }
  })

  it('the field case: a short title with the shorter form beats long sections of the common words', async () => {
    const out = (await mcp.tool('find_context', { query: '해커톤 택배함 분석 서비스' })).text
    const page = ids.get('H:02-1 아이디어1, 택배 한 상자')!
    const order = [...out.matchAll(/^\(page ([0-9a-f]{8,36});/gm)].map((m) => m[1])
    const at = order.findIndex((p) => page.startsWith(p)) + 1
    assert.ok(at >= 1 && at <= 3, `answer page at ${at}:\n${out}`)
  })
})
