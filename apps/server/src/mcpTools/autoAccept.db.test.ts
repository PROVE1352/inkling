// Agent edit policy (direct / auto / review) and auto-accept rules (docs/adr/1544-*, 1545-*) against a
// real database: workspace default and lock-node overrides, each rule (mode, connection, size, base
// version), the grace period (rejected, section changed, two sweepers accept once), notifications,
// permissions and the agent-facing answers.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent edit policy and auto-accept rules', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { flushNotifications } = await import('../notify/engine')
  const { runAutoAccepts } = await import('../autoAccept')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })
  const DEFAULT = { modes: ['append', 'insert_after', 'prepend'], connections: [], maxLines: null, maxChars: null, graceMinutes: 0 }

  let alice: U, bob: U
  let wsId: string
  let A: Awaited<ReturnType<typeof h.connectMcp>>
  let B: Awaited<ReturnType<typeof h.connectMcp>>

  async function newPage(title: string) {
    const blocks = [heading('Log'), para('first'), heading('Plan'), para('ship')]
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const setPolicy = (level: string, rules: Record<string, unknown> = {}, u = alice) =>
    req(u, 'PUT', `/workspaces/${wsId}/agent-policy`, { level, rules: { ...DEFAULT, ...rules } })
  const sectionText = async (pageId: string, anchor: string) => (await req(alice, 'GET', `/pages/${pageId}/section?ref=${anchor}`)).json().markdown as string
  const version = async (pageId: string, anchor: string) =>
    ((await req(alice, 'GET', `/pages/${pageId}/outline`)).json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === anchor)!.version
  const rowsOf = (pageId: string) => db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.pageId, pageId))
  const approvalRequests = async (pageId: string) => {
    await flushNotifications()
    return (await db.select().from(schema.notifications).where(and(eq(schema.notifications.userId, alice.id), eq(schema.notifications.pageId, pageId)))).filter(
      (n) => n.type === 'approval_request',
    ).length
  }
  const grantOf = async (userId: string) => {
    const [g] = await db.select({ id: schema.oauthGrants.id }).from(schema.oauthGrants).where(eq(schema.oauthGrants.userId, userId))
    return `grant:${g.id}`
  }

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    A = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Alice Agent'))
    B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Claude'))
  })
  after(async () => {
    for (const c of [A, B]) await c.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('only owners and admins set the workspace default; it is audited; members can read it', async () => {
    const no = await setPolicy('auto', {}, bob)
    assert.equal(no.statusCode, 403, no.body)
    const ok = await setPolicy('auto')
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().policy.level, 'auto')
    const read = (await req(bob, 'GET', `/workspaces/${wsId}/agent-policy`)).json().policy
    assert.equal(read.level, 'auto')
    assert.deepEqual(read.rules.modes, ['append', 'insert_after', 'prepend'])
    assert.equal(read.canManage, false)
    const audit = await db.select().from(schema.workspaceAuditEvents).where(eq(schema.workspaceAuditEvents.workspaceId, wsId))
    assert.ok(audit.some((e) => e.action === 'agent_policy.changed'))
  })

  it('auto: an allowed append is accepted at once by the rule, without an approval request', async () => {
    await setPolicy('auto')
    const P = await newPage('Auto 1')
    const r = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'second' })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^Done \(append\): auto-accepted under the workspace rule \(suggestion [0-9a-f-]{36}\); §log is now v=\S+\./)
    assert.match(await sectionText(P, 'log'), /first\n\nsecond/)
    const [row] = await rowsOf(P)
    assert.equal(row.status, 'accepted')
    assert.equal(row.rule, 'workspace')
    assert.equal(row.origin, 'policy')
    assert.equal(row.decidedBy, alice.id, 'the rule was set by alice')
    assert.equal(await approvalRequests(P), 0)
    // the can: line says how edits land
    assert.match((await B.tool('read_page', { pageId: P, outline: true })).text, /can: read,comment,suggest,auto/)
    // the list shows the rule
    assert.match((await B.tool('list_suggestions', { pageId: P, status: 'all' })).text, /\| accepted \| .* \| by rule \(workspace\) /)
  })

  it('auto: modes, connections, size and a stale base are held for a person, with the reason', async () => {
    await setPolicy('auto')
    const P = await newPage('Auto 2')
    const rep = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'replace', markdown: 'ship later', baseVersion: await version(P, 'plan') })
    assert.match(rep.text, /^Not written: kept as suggestion [0-9a-f-]{36} for §plan .*\nneeds review: mode replace is not auto-accepted here/)
    assert.match(await sectionText(P, 'plan'), /ship$/)
    assert.equal(await approvalRequests(P), 1)
    // replace allowed, but the agent's base version is old
    await setPolicy('auto', { modes: ['append', 'replace'] })
    const stale = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'replace', markdown: 'ship never', baseVersion: 'aaaaaaaaaaaa' })
    assert.match(stale.text, /needs review: the section changed since the version the agent read/)
    // connection allow list
    await setPolicy('auto', { connections: [await grantOf(alice.id)] })
    const conn = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'from bob' })
    assert.match(conn.text, /needs review: this connection is not on the auto-accept list/)
    const fromAlice = await A.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'from alice agent' })
    assert.match(fromAlice.text, /^Done \(append\): auto-accepted/)
    // size
    await setPolicy('auto', { maxLines: 2 })
    const big = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'a\n\nb\n\nc\n\nd' })
    assert.match(big.text, /needs review: the change is larger than the rule allows \(\d+ lines > 2\)/)
    await setPolicy('auto', { maxChars: 5 })
    assert.match((await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'append', markdown: 'longer text' })).text, /\d+ characters > 5/)
    // asking for a suggestion is never auto-accepted
    await setPolicy('auto')
    assert.match((await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'asked', suggest: true })).text, /you asked for a suggestion/)
    assert.doesNotMatch(await sectionText(P, 'log'), /asked/)
  })

  it('grace period: accepted later unless rejected; a changed section goes to a person; two sweepers accept once', async () => {
    await setPolicy('auto', { graceMinutes: 10 })
    const P = await newPage('Grace')
    const r = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'later' })
    assert.match(r.text, /^Not written yet: suggestion [0-9a-f-]{36} for §log will be auto-accepted at \d{4}-\d\d-\d\dT\d\d:\d\dZ unless a person rejects it/)
    assert.equal(await approvalRequests(P), 1, 'people are told so they can stop it')
    const [g] = await rowsOf(P)
    assert.ok(g.autoAt)
    // not due yet: nothing happens
    assert.equal(await runAutoAccepts(), 0)
    await db.execute(sql`UPDATE section_suggestions SET auto_at = now() - interval '1 second' WHERE id = ${g.id}`)
    const [n1, n2] = await Promise.all([runAutoAccepts(), runAutoAccepts()])
    assert.equal(n1 + n2, 1, 'one sweeper wins')
    const text = await sectionText(P, 'log')
    assert.equal(text.split('later').length - 1, 1, text)
    const [done] = await rowsOf(P)
    assert.equal(done.status, 'accepted')
    assert.equal(done.rule, 'workspace')
    await flushNotifications()
    assert.match((await B.tool('inbox', { kinds: ['approval_result'] })).text, new RegExp(`accepted: suggestion ${g.id} \\(append §log\\) by the workspace rule`))

    // rejected during the grace period
    const r2 = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'append', markdown: 'no thanks' })
    const id2 = /suggestion ([0-9a-f-]{36})/.exec(r2.text)![1]
    assert.equal((await req(alice, 'POST', `/suggestions/${id2}/reject`, {})).statusCode, 200)
    await db.execute(sql`UPDATE section_suggestions SET auto_at = now() - interval '1 second' WHERE id = ${id2}`)
    assert.equal(await runAutoAccepts(), 0)
    assert.doesNotMatch(await sectionText(P, 'plan'), /no thanks/)

    // the section changed meanwhile: a person decides
    const r3 = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'append', markdown: 'maybe' })
    const id3 = /suggestion ([0-9a-f-]{36})/.exec(r3.text)![1]
    assert.equal((await req(alice, 'POST', `/pages/${P}/section`, { ref: 'plan', mode: 'append', markdown: 'by alice' })).statusCode, 200)
    await db.execute(sql`UPDATE section_suggestions SET auto_at = now() - interval '1 second' WHERE id = ${id3}`)
    assert.equal(await runAutoAccepts(), 0)
    const [held] = await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.id, id3))
    assert.equal(held.status, 'open')
    assert.equal(held.autoAt, null)
    assert.match(held.reviewReason ?? '', /changed during the grace period/)
    assert.doesNotMatch(await sectionText(P, 'plan'), /maybe/)
  })

  it('review default; lock nodes override it ("auto" with its own rules, "direct"); rules on a node need lock rights', async () => {
    await setPolicy('review')
    const P = await newPage('Review')
    const r = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'x' })
    assert.match(r.text, /^Not written: kept as suggestion .*\nneeds review: this workspace sends every agent edit to a person/)
    assert.match((await B.tool('read_page', { pageId: P, outline: true })).text, /can: read,comment,suggest\n/)
    // renames are not suggestions: the default does not refuse them (a lock would)
    assert.equal((await B.tool('rename_page', { pageId: P, title: 'Review renamed' })).isError, false)

    // a folder-like lock node with "auto" and its own rules
    const lock = await req(alice, 'PUT', `/pages/${P}/lock`, { locked: true, people: 'everyone', agents: 'auto' })
    assert.equal(lock.statusCode, 200, lock.body)
    assert.equal((await req(bob, 'PUT', `/pages/${P}/agent-rules`, { rules: { ...DEFAULT, modes: ['replace'] } })).statusCode, 403)
    const set = await req(alice, 'PUT', `/pages/${P}/agent-rules`, { rules: { ...DEFAULT, modes: ['append', 'replace'] } })
    assert.equal(set.statusCode, 200, set.body)
    const rep = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'replace', markdown: 'ship now', baseVersion: await version(P, 'plan') })
    assert.match(rep.text, new RegExp(`auto-accepted under the rule of page ${P}`))
    assert.match(await sectionText(P, 'plan'), /ship now/)
    // "direct" below a review default: agents write directly
    await req(alice, 'PUT', `/pages/${P}/lock`, { locked: true, agents: 'direct' })
    const d = await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'direct' })
    assert.match(d.text, /^Done \(append\): §log is now v=/)
    await setPolicy('direct')
  })
})
