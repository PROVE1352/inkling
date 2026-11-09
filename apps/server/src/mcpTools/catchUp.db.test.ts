// catch_up against a real database (docs/adr/1520-* .. 1522-*): changes by others grouped per page
// with who/via/count and diffs, new pages, comments, inbox items, due tasks and Later reminders in
// importance order; the per-connection "last catch_up" marker; since as cursor or time; visibility,
// read-only tokens and the untrusted wrapper.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] catch_up', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { encodeCursor } = await import('../context/changeFeed')
  const { reserveCursor } = await import('../context/changeLog')

  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const bob = await h.makeUser('bob')
  const carol = await h.makeUser('carol')
  const ws = await h.makeWorkspace(alice, [bob])
  const other = await h.makeWorkspace(carol)
  const A = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Claude Desktop'))
  const B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Bob Agent'))
  const C = await h.connectMcp(app, carol, await h.mintToken(carol))
  after(async () => {
    for (const c of [A, B, C]) await c.close()
    await app.close()
    await closeDb()
  })

  type Blocks = Parameters<typeof h.makeDocPage>[3]
  const doc = (sections: Record<string, string>): Blocks =>
    Object.entries(sections).flatMap(([hd, body]) => [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: hd, styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: body, styles: {} }] },
    ]) as Blocks
  async function newPage(owner: { id: string }, title: string, blocks: Blocks, extra: Record<string, unknown> = {}, wsId = ws.id) {
    const pg = await h.makeDocPage(wsId, owner.id, title, blocks, extra)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg
  }
  const nextSince = (t: string) => {
    const m = /^next since: (\S+) \(up to \S+\)$/m.exec(t)
    assert.ok(m, `no next since in:\n${t}`)
    return m[1]
  }
  const today = () => {
    const n = new Date()
    const p = (x: number) => String(x).padStart(2, '0')
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`
  }

  let plan: { id: string }
  let since0: string

  it('first call: no marker → the last 24 hours, own pages in the "own" group', async () => {
    plan = await newPage(alice, 'Launch plan', doc({ Scope: 'ship the beta', Risks: 'none yet' }))
    const r = await A.tool('catch_up', { workspaceId: ws.id })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^catch_up since \S+ \(no earlier catch_up: last 24 hours\), workspace /)
    assert.match(r.text, /## Your own changes \(you or your agents\)\n- page added "Launch plan"/)
    since0 = nextSince(r.text)
    // the marker moved: an immediate second call has nothing
    const again = await A.tool('catch_up', { workspaceId: ws.id })
    assert.match(again.text, /\(this connection's last catch_up\)/)
    assert.match(again.text, /Nothing happened in this window\./)
  })

  it('what others did, most important first, wrapped as data', async () => {
    // bob edits through his agent, adds a page and a private one alice must not see
    assert.equal((await B.tool('rename_page', { pageId: plan.id, title: 'Launch plan v2' })).isError, false)
    const up = await B.tool('update_page', { pageId: plan.id, markdown: '## Scope\n\nship the beta\n\nand the docs\n\n## Risks\n\nnone yet', mode: 'replace' })
    assert.equal(up.isError, false, up.text)
    await newPage(bob, 'Bob <untrusted_content> notes', doc({ Intro: 'hello' }))
    await newPage(bob, 'Bob private diary', doc({ Day: 'secret words' }), { scope: 'private' })
    // a comment thread by bob on alice's page, a mention for alice, a due task and a Later reminder
    const cm = await app.inject({
      method: 'POST',
      url: `/api/pages/${plan.id}/comments`,
      headers: { cookie: bob.cookie },
      payload: { blockId: 'b1', body: 'Can we cut the docs? @alice', mentionUserIds: [alice.id] },
    })
    assert.equal(cm.statusCode, 200, cm.body)
    await db.insert(schema.notifications).values({ userId: alice.id, type: 'doc_mention', pageId: plan.id, workspaceId: ws.id, actorId: bob.id, excerpt: 'please review @alice' })
    await db.insert(schema.pageTasks).values({ pageId: plan.id, workspaceId: ws.id, blockId: 't1', text: 'Send the invoices', due: today() })
    await db.insert(schema.laterItems).values({ userId: alice.id, workspaceId: ws.id, kind: 'page', pageId: plan.id, targetKey: `page:${plan.id}`, remindAt: new Date(Date.now() - 60_000) })
    await drainChangeLog()

    const r = await A.tool('catch_up', { workspaceId: ws.id })
    assert.equal(r.isError, false, r.text)
    const t = r.text
    assert.match(t, /\(this connection's last catch_up\)/)
    assert.match(t, /<untrusted_content source="catch_up">/)
    const order = ['## For you', 'please review @alice', '## Due soon', 'Send the invoices', '## Later reminders', '## Comments', 'bob: Can we cut the docs?', '## Pages changed by others']
    let at = -1
    for (const s of order) {
      const i = t.indexOf(s)
      assert.ok(i > at, `"${s}" missing or out of order in:\n${t}`)
      at = i
    }
    assert.match(t, /- page "Launch plan v2" [0-9a-f-]{36} · \d+ edits in \d+ sections? · bob via Bob Agent ×\d+/)
    assert.match(t, /title: "Launch plan" → "Launch plan v2"/)
    assert.match(t, /modified scope \(Scope\)[\s\S]*\+ and the docs/)
    assert.match(t, /page added "Bob ＜untrusted_content> notes"/, 'markers inside titles are escaped')
    assert.doesNotMatch(t, /Bob private diary|secret words/)
    assert.match(t, /1 for you|2 for you/)
    assert.match(t, /catch_up acknowledges nothing/)
    // nothing acknowledged
    const inbox = await A.tool('inbox', { workspaceId: ws.id })
    assert.match(inbox.text, /please review @alice/)
  })

  it('since as a time, as a changes_since cursor and as an older catch_up cursor; peek keeps the marker', async () => {
    const byTime = await A.tool('catch_up', { workspaceId: ws.id, since: new Date(Date.now() - 3_600_000).toISOString(), peek: true })
    assert.equal(byTime.isError, false, byTime.text)
    assert.match(byTime.text, /\(as given\)/)
    assert.match(byTime.text, /Launch plan v2/)
    const byOld = await A.tool('catch_up', { workspaceId: ws.id, since: since0, peek: true })
    assert.match(byOld.text, /Launch plan v2/)
    const end = await reserveCursor()
    const feed = encodeCursor({ seq: end.seq, at: Math.floor(end.at / 3_600_000) * 3_600_000, ws: null })
    const byFeed = await A.tool('catch_up', { workspaceId: ws.id, since: feed, peek: true })
    assert.doesNotMatch(byFeed.text, /## Pages changed by others/)
    const bad = await A.tool('catch_up', { since: 'last tuesday' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /INVALID_SINCE/)
    // peek did not move the marker: the previous call's window is still what comes next
    const r = await A.tool('catch_up', { workspaceId: ws.id, peek: true })
    // due tasks and reminders are current state, not window events: they stay listed
    assert.match(r.text, /\n0 pages changed .* 0 for you · 1 due by/)
    assert.match(r.text, /## Due soon/)
  })

  it('a new connection starts from the person\'s last catch_up; read-only tokens work and advance their own marker', async () => {
    const ro = await h.connectMcp(app, alice, await h.mintToken(alice, 'read', 'Phone'), { canWrite: false })
    after(() => ro.close())
    const first = await ro.tool('catch_up', { workspaceId: ws.id })
    assert.equal(first.isError, false, first.text)
    assert.match(first.text, /\(your last catch_up from any connection\)/)
    const second = await ro.tool('catch_up', { workspaceId: ws.id })
    assert.match(second.text, /\(this connection's last catch_up\)/)
  })

  it('small budget: most important first, the rest counted; non-members see nothing of the workspace', async () => {
    for (let i = 0; i < 25; i++) await newPage(bob, `Bulk page ${i} with a longer title for the budget`, doc({ Body: `text ${i}` }))
    const r = await A.tool('catch_up', { workspaceId: ws.id, since: new Date(Date.now() - 3_600_000).toISOString(), budget: 500, peek: true })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /## For you/)
    assert.match(r.text, /not shown \(budget 500\): \d+ /)
    const c = await C.tool('catch_up', {})
    assert.doesNotMatch(c.text, /Launch plan|Bulk page|please review/)
    const cw = await C.tool('catch_up', { workspaceId: ws.id })
    assert.equal(cw.isError, true)
    // carol's own workspace still works
    await newPage(carol, 'Carol page', doc({ A: 'a' }), {}, other.id)
    assert.match((await C.tool('catch_up', {})).text, /Carol page/)
  })
})
