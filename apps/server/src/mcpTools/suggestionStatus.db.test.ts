// list_suggestions / withdraw_suggestion status handling (docs/adr/1626-*), found on 0.12 in use:
// withdrawing a superseded suggestion answered "re-read and retry"; list_suggestions with a pageId
// showed withdrawn rows while the list without one showed none, and superseded rows showed nowhere.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] suggestion status in list_suggestions and withdraw_suggestion', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb } = await import('../db/index')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const idOf = (t: string) => /suggestion ([0-9a-f-]{36})/.exec(t)![1]

  let alice: U, bob: U
  let B: Awaited<ReturnType<typeof h.connectMcp>>
  let P: string
  const ids: Record<string, string> = {}

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    const ws = await h.makeWorkspace(alice, [bob])
    B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Claude'))
    const blocks = [heading('One'), para('1'), heading('Two'), para('2'), heading('Three'), para('3'), heading('Four'), para('4')]
    P = (await h.makeDocPage(ws.id, alice.id, 'Statuses', blocks as never)).id
    await reindexPageChunks(P, blocks as never)
    await drainChangeLog()
    const sug = async (section: string, md: string) => idOf((await B.tool('patch_section', { pageId: P, section, mode: 'append', markdown: md, suggest: true })).text)
    ids.superseded = await sug('one', 'first try')
    ids.open = await sug('one', 'second try') // replaces the first
    ids.withdrawn = await sug('two', 'w')
    await B.tool('withdraw_suggestion', { suggestionId: ids.withdrawn })
    ids.rejected = await sug('three', 'r')
    await req(alice, 'POST', `/suggestions/${ids.rejected}/reject`, {})
    ids.accepted = await sug('four', 'a')
    await req(alice, 'POST', `/suggestions/${ids.accepted}/accept`, {})
  })
  after(async () => {
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('withdrawing a suggestion that is no longer open says why, per status', async () => {
    const sup = await B.tool('withdraw_suggestion', { suggestionId: ids.superseded })
    assert.equal(sup.isError, true)
    assert.doesNotMatch(sup.text, /re-read/)
    assert.match(sup.text, new RegExp(`replaced by your newer suggestion ${ids.open}`))
    const wd = await B.tool('withdraw_suggestion', { suggestionId: ids.withdrawn })
    assert.match(wd.text, /already withdrawn/)
    assert.doesNotMatch(wd.text, /re-read/)
    const rj = await B.tool('withdraw_suggestion', { suggestionId: ids.rejected })
    assert.match(rj.text, /already rejected by Alice/)
    assert.doesNotMatch(rj.text, /re-read/)
    const ac = await B.tool('withdraw_suggestion', { suggestionId: ids.accepted })
    assert.match(ac.text, /already accepted by Alice/)
  })

  it('both list paths: open by default; status=all shows every state; one status filters', async () => {
    const byPage = await B.tool('list_suggestions', { pageId: P })
    const mine = await B.tool('list_suggestions', {})
    for (const t of [byPage.text, mine.text]) {
      assert.match(t, new RegExp(`${ids.open} \\| open`))
      for (const k of ['superseded', 'withdrawn', 'rejected', 'accepted']) assert.doesNotMatch(t, new RegExp(ids[k]), `${k} hidden by default`)
    }
    const allPage = await B.tool('list_suggestions', { pageId: P, status: 'all' })
    const allMine = await B.tool('list_suggestions', { status: 'all' })
    for (const t of [allPage.text, allMine.text]) {
      for (const k of ['open', 'superseded', 'withdrawn', 'rejected', 'accepted']) assert.match(t, new RegExp(`${ids[k]} \\| ${k}`), `${k} in status=all`)
    }
    assert.match(allMine.text, new RegExp(`${ids.superseded} \\| superseded .*replaced by ${ids.open}`))
    const wd = await B.tool('list_suggestions', { status: 'withdrawn' })
    assert.match(wd.text, new RegExp(ids.withdrawn))
    assert.doesNotMatch(wd.text, new RegExp(ids.open))
    const decided = await B.tool('list_suggestions', { pageId: P, status: 'decided' })
    assert.match(decided.text, new RegExp(ids.rejected))
    assert.match(decided.text, new RegExp(ids.accepted))
    assert.doesNotMatch(decided.text, new RegExp(ids.withdrawn))
    // the web history keeps its view (decided and withdrawn, not superseded)
    const web = (await req(alice, 'GET', `/pages/${P}/suggestions?all=1`)).json().suggestions as { id: string }[]
    assert.ok(!web.some((s) => s.id === ids.superseded))
    assert.ok(web.some((s) => s.id === ids.withdrawn))
  })
})
