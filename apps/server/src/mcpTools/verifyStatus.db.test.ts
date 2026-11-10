// Page verification (docs/adr/1840-* .. 1842-*) and member status (docs/adr/1845-*, 1846-*):
// who may verify, expiry read on the server clock, "changed since" from the change feed, the
// verified list (visibility, buckets), the agent-facing marks in read_page / find_context, and
// statuses in the members list and after agent writes that mention people.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-verify-${process.pid}`
process.env.DATA_DIR ||= DATA
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] page verification and member status', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { sql, eq } = await import('drizzle-orm')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { estimateTokens } = await import('../context/tokens')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
  const app = await h.buildTestApp()
  const closers: (() => Promise<void>)[] = []
  after(async () => {
    for (const c of closers) await c()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  const req = (u: U, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const bearer = (token: string, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })

  async function agent(u: U) {
    const token = await h.mintToken(u)
    const m = await h.connectMcp(app, u, token, { user: { ...u, via: 'Test Agent' } })
    closers.push(m.close)
    return { ...m, token }
  }

  async function setup() {
    const owner = await h.makeUser('Olivia')
    const admin = await h.makeUser('Adam')
    const member = await h.makeUser('Mia')
    const outsider = await h.makeUser('Otto')
    const ws = await h.makeWorkspace(owner, [admin, member])
    await db.update(schema.workspaceMembers).set({ role: 'admin' }).where(sql`workspace_id = ${ws.id} AND user_id = ${admin.id}`)
    const blocks = [heading('Refund policy'), para('Refunds within 30 days zanzibar'), heading('Shipping'), para('Ships in 2 days zanzibar')]
    const page = await h.makeDocPage(ws.id, owner.id, 'Policy handbook', blocks as never)
    await reindexPageChunks(page.id, blocks as never)
    return { owner, admin, member, outsider, ws, page }
  }

  it('who may verify: editors; with a document owner only that owner or an admin; never agents or guests', async () => {
    const s = await setup()
    // no document owner: any member who can edit
    let r = await req(s.member, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 30 })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(r.json().verification.state, 'verified')
    assert.equal(r.json().verification.verifiedBy.name, 'Mia')
    // the verification counts as a review
    const [p] = await db.select({ reviewedBy: schema.pages.reviewedBy }).from(schema.pages).where(eq(schema.pages.id, s.page.id))
    assert.equal(p.reviewedBy, s.member.id)

    await db.update(schema.pages).set({ ownerId: s.owner.id }).where(eq(schema.pages.id, s.page.id))
    r = await req(s.member, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 30 })
    assert.equal(r.statusCode, 403, r.body)
    assert.equal((await req(s.member, 'GET', `/pages/${s.page.id}/verification`)).json().canVerify, false)
    assert.equal((await req(s.admin, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 90 })).statusCode, 200)
    assert.equal((await req(s.owner, 'GET', `/pages/${s.page.id}/verification`)).json().canVerify, true)
    // an agent connection reads it but cannot verify
    const a = await agent(s.owner)
    assert.equal((await bearer(a.token, 'GET', `/pages/${s.page.id}/verification`)).statusCode, 200)
    assert.equal((await bearer(a.token, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 30 })).statusCode, 403)
    // outsiders see nothing
    assert.equal((await req(s.outsider, 'GET', `/pages/${s.page.id}/verification`)).statusCode, 404)
    // input checks: exactly one of the two, within a year
    assert.equal((await req(s.owner, 'POST', `/pages/${s.page.id}/verification`, {})).statusCode, 400)
    assert.equal((await req(s.owner, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 400 })).statusCode, 400)
    // removal is audited with the verification
    assert.equal((await req(s.owner, 'DELETE', `/pages/${s.page.id}/verification`)).json().verification, null)
    const actions = ((await db.execute(sql`SELECT action FROM workspace_audit_events WHERE workspace_id = ${s.ws.id} ORDER BY id`)) as unknown as { action: string }[]).map((x) => x.action)
    assert.deepEqual(actions.filter((x) => x.startsWith('page.')), ['page.verified', 'page.verified', 'page.unverified'])
  })

  it('changed since verification, expiry, the list, and the agent marks', async () => {
    const s = await setup()
    const a = await agent(s.member)
    const before = await a.tool('read_page', { pageId: s.page.id })
    const fcBefore = await a.tool('find_context', { query: 'zanzibar refunds' })
    assert.doesNotMatch(before.text, /verified|stale/)

    assert.equal((await req(s.owner, 'POST', `/pages/${s.page.id}/verification`, { expiresInDays: 30, note: 'checked with finance' })).statusCode, 200)
    const verifiedRead = await a.tool('read_page', { pageId: s.page.id })
    // after the body since 0.15.1: it changes with the clock, not the page (docs/adr/1946-*)
    assert.match(verifiedRead.text, /<\/untrusted_content>\n\n- verified: until \d{4}-\d\d-\d\d$/)
    const fc = await a.tool('find_context', { query: 'zanzibar refunds' })
    // find_context: one line at the end since 0.15.1, the fragment header unchanged (docs/adr/1907-*)
    assert.match(fc.text, /\nVerification: \[1\] verified$/)
    assert.doesNotMatch(fc.text, /; verified/)
    // token cost of the marks (reported in docs/adr/1842-*)
    console.log(
      `[verify] read_page +${estimateTokens(verifiedRead.text) - estimateTokens(before.text)} tok, ` +
        `find_context +${estimateTokens(fc.text) - estimateTokens(fcBefore.text)} tok`,
    )
    assert.match((await a.tool('read_page', { pageId: s.page.id, outline: true })).text, /\nverified: until /)

    // The verifier's own edits logged right after verifying belong to what they verified; others' count.
    const log = (actor: string, anchor: string, kind = 'modified', large = false) =>
      db.insert(schema.pageChanges).values({ workspaceId: s.ws.id, pageId: s.page.id, anchor, kind, scope: 'shared', actorId: actor, large })
    await log(s.owner.id, 'refund-policy')
    let v = (await req(s.member, 'GET', `/pages/${s.page.id}/verification`)).json().verification
    assert.equal(v.changedSections, 0)
    await log(s.member.id, 'refund-policy')
    await log(s.member.id, 'refund-policy')
    await log(s.admin.id, 'shipping')
    await db.insert(schema.pageChanges).values({ workspaceId: s.ws.id, pageId: s.page.id, anchor: null, kind: 'page_renamed', scope: 'shared' })
    v = (await req(s.member, 'GET', `/pages/${s.page.id}/verification`)).json().verification
    assert.equal(v.changedSections, 2, 'each section once, page-level events not counted')
    assert.equal(v.changedMuch, false)
    assert.match((await a.tool('read_page', { pageId: s.page.id })).text, /- verified: until \S+, 2 sections changed since$/)
    await log(s.admin.id, 'faq', 'added', true)
    v = (await req(s.member, 'GET', `/pages/${s.page.id}/verification`)).json().verification
    assert.equal(v.changedMuch, true)
    assert.match((await a.tool('find_context', { query: 'zanzibar refunds' })).text, /\nVerification: \[1\] verified, changed since$/)

    // Lists: expiring within the window, expired; another member's private page never shows.
    const priv = await h.makeDocPage(s.ws.id, s.owner.id, 'Owner private', [para('x')] as never, { scope: 'private' })
    await req(s.owner, 'POST', `/pages/${priv.id}/verification`, { expiresInDays: 30 })
    await db.update(schema.pageVerifications).set({ expiresAt: new Date(Date.now() + 3 * 86_400_000) }).where(eq(schema.pageVerifications.pageId, s.page.id))
    let list = (await req(s.member, 'GET', `/workspaces/${s.ws.id}/verified`)).json()
    assert.deepEqual(list.expiring.map((i: { pageId: string }) => i.pageId), [s.page.id])
    assert.equal(list.verified.length + list.expired.length, 0, 'the private page is not listed for others')
    assert.equal((await req(s.owner, 'GET', `/workspaces/${s.ws.id}/verified`)).json().verified.length, 1)
    assert.equal((await req(s.member, 'GET', `/workspaces/${s.ws.id}/verified?days=1`)).json().verified.length, 1)

    await db.update(schema.pageVerifications).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.pageVerifications.pageId, s.page.id))
    list = (await req(s.member, 'GET', `/workspaces/${s.ws.id}/verified`)).json()
    assert.equal(list.expired[0].verification.state, 'expired')
    const stale = await a.tool('read_page', { pageId: s.page.id })
    assert.match(stale.text, /\n- stale: verification lapsed \d{4}-\d\d-\d\d, 3 sections changed since$/) // after the body (docs/adr/1946-*)
    assert.match((await a.tool('find_context', { query: 'zanzibar refunds' })).text, /\nVerification: \[1\] stale: verification lapsed$/)
    assert.equal((await req(s.outsider, 'GET', `/workspaces/${s.ws.id}/verified`)).statusCode, 403)
  })

  it('member status: set, members list, auto clear, agent notes on mentions and the owner line', async () => {
    const s = await setup()
    // browser only; at least a text or an emoji; a clear time in the future
    const a = await agent(s.member)
    assert.equal((await bearer(a.token, 'PUT', '/me/status', { text: 'x' })).statusCode, 403)
    assert.equal((await req(s.member, 'PUT', '/me/status', { text: '' })).statusCode, 400)
    assert.equal((await req(s.member, 'PUT', '/me/status', { text: 'x', clearAt: new Date(Date.now() - 1000).toISOString() })).statusCode, 400)
    const clearAt = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const put = await req(s.member, 'PUT', '/me/status', { emoji: '🎓', text: 'Exam week', clearAt })
    assert.equal(put.statusCode, 200, put.body)
    assert.deepEqual(put.json().status, { emoji: '🎓', text: 'Exam week', clearAt })

    const members = (await req(s.owner, 'GET', `/workspaces/${s.ws.id}/members`)).json().members as { id: string; status: unknown }[]
    assert.deepEqual(members.find((m) => m.id === s.member.id)?.status, { emoji: '🎓', text: 'Exam week', clearAt })
    assert.equal(members.find((m) => m.id === s.owner.id)?.status, null)

    // Agent writes that mention people get one status line; nothing when nobody mentioned has one.
    const o = await agent(s.owner)
    const mention = `@[Mia](user:${s.member.id})`
    const upd = await o.tool('update_page', { pageId: s.page.id, mode: 'append', markdown: `Please check, ${mention}` })
    assert.equal(upd.isError, false, upd.text)
    assert.match(upd.text, /\nstatus: Mia "🎓 Exam week" until \d{4}-\d\d-\d\d$/)
    const plain = await o.tool('update_page', { pageId: s.page.id, mode: 'append', markdown: `Thanks @[Olivia](user:${s.owner.id})` })
    assert.doesNotMatch(plain.text, /status:/)
    const created = await o.tool('create_page', { workspaceId: s.ws.id, title: 'Tasks', markdown: `- [ ] ${mention} review the policy` })
    assert.match(created.text, /"status":"Mia \\"🎓 Exam week\\" until /)
    // someone outside the workspace: no status, even with a valid id
    await req(s.outsider, 'PUT', '/me/status', { text: 'secret plans' })
    const out = await o.tool('update_page', { pageId: s.page.id, mode: 'append', markdown: `@[Otto](user:${s.outsider.id})` })
    assert.doesNotMatch(out.text, /secret plans/)

    // The document owner's status rides on read_page's owner line.
    await db.update(schema.pages).set({ ownerId: s.member.id }).where(eq(schema.pages.id, s.page.id))
    // the owner line stays in the header; the live status goes after the body (docs/adr/1946-*)
    const ownerRead = (await o.tool('read_page', { pageId: s.page.id })).text
    assert.match(ownerRead, /\n- owner: Mia\n/)
    assert.match(ownerRead, /<\/untrusted_content>\n\n- owner status: "🎓 Exam week" until \d{4}-\d\d-\d\d$/)

    // Past its clear time the status is gone everywhere, without any sweep.
    await db.update(schema.userStatuses).set({ clearAt: new Date(Date.now() - 1000) }).where(eq(schema.userStatuses.userId, s.member.id))
    assert.equal((await req(s.member, 'GET', '/me/status')).json().status, null)
    const again = (await req(s.owner, 'GET', `/workspaces/${s.ws.id}/members`)).json().members as { id: string; status: unknown }[]
    assert.equal(again.find((m) => m.id === s.member.id)?.status, null)
    assert.doesNotMatch((await o.tool('read_page', { pageId: s.page.id })).text, /Exam week/)
    assert.equal((await req(s.member, 'DELETE', '/me/status')).json().status, null)
  })
})
