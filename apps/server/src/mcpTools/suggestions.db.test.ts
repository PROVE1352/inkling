// Suggested edits, the "agents: suggestions only" lock and section claims (docs/adr/1530-* .. 1536-*)
// against a real database: an agent suggests instead of writing, a person accepts (with the
// "changed since" warning) or rejects, the agent's inbox gets approval_result, superseding and
// withdrawing, lock bits, claims refusing other agents but never people, visibility.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] suggestions and section claims', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { flushNotifications } = await import('../notify/engine')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })

  let alice: U, bob: U, carol: U
  let wsId: string
  let tokenB: string
  let A: Awaited<ReturnType<typeof h.connectMcp>> // alice's agent
  let B: Awaited<ReturnType<typeof h.connectMcp>> // bob's agent
  let C: Awaited<ReturnType<typeof h.connectMcp>> // carol's agent (not a member)

  async function newPage(title: string, blocks: unknown[], by = alice) {
    const pg = await h.makeDocPage(wsId, by.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const versionOf = async (pageId: string, anchor: string) => {
    const r = await req(alice, 'GET', `/pages/${pageId}/outline`)
    return (r.json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === anchor)!.version
  }
  const sectionText = async (pageId: string, anchor: string) => (await req(alice, 'GET', `/pages/${pageId}/section?ref=${anchor}`)).json().markdown as string
  const suggestionId = (t: string) => {
    const m = /suggestion ([0-9a-f-]{36})/.exec(t)
    assert.ok(m, t)
    return m[1]
  }
  const bearer = (token: string, method: 'POST' | 'GET', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    carol = await h.makeUser('Carol')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    A = await h.connectMcp(app, alice, await h.mintToken(alice, 'notes', 'Alice Agent'))
    tokenB = await h.mintToken(bob, 'notes', 'Claude')
    B = await h.connectMcp(app, bob, tokenB)
    C = await h.connectMcp(app, carol, await h.mintToken(carol))
  })
  after(async () => {
    for (const c of [A, B, C]) await c.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('suggest=true keeps the change as a suggestion; the page owner gets approval_request', async () => {
    const P = await newPage('Launch', [heading('Plan'), para('ship on friday')])
    const v = await versionOf(P, 'plan')
    const r = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'replace', markdown: 'ship on monday', baseVersion: v, suggest: true })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, /^Not written: kept as suggestion [0-9a-f-]{36} for §plan/)
    assert.match(r.text, /you asked for a suggestion/)
    assert.match(await sectionText(P, 'plan'), /ship on friday/)
    const id = suggestionId(r.text)
    const [row] = await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.id, id))
    assert.equal(row.status, 'open')
    assert.equal(row.mode, 'replace')
    assert.equal(row.origin, 'asked')
    assert.equal(row.baseVersion, v)
    assert.equal(row.via, 'Claude')
    assert.ok(row.connection.startsWith('grant:'))
    await flushNotifications()
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, alice.id))
    const n = notes.find((x) => x.type === 'approval_request' && x.pageId === P)
    assert.ok(n, 'approval_request for the page owner')
    assert.equal(n.actorId, bob.id)
    // the same connection suggesting again for the same section supersedes the first one
    const r2 = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'append', markdown: 'and a party', suggest: true })
    const id2 = suggestionId(r2.text)
    const rows = await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.pageId, P))
    assert.equal(rows.find((x) => x.id === id)!.status, 'superseded')
    assert.equal(rows.find((x) => x.id === id2)!.status, 'open')
    // list_suggestions: the page's (with the text as data) and the agent's own
    const l = await B.tool('list_suggestions', { pageId: P })
    assert.match(l.text, /^1 open suggestion\(s\) on page /)
    assert.match(l.text, new RegExp(`${id2} \\| open \\| page ${P} §plan \\| append \\| Bob \\(via Claude\\)`))
    assert.match(l.text, /<untrusted_content source="suggestion"[^>]*>\nand a party\n<\/untrusted_content>/)
    const mine = await B.tool('list_suggestions', {})
    assert.match(mine.text, new RegExp(`${id2} \\| open`))
    assert.doesNotMatch(mine.text, new RegExp(id))
  })

  it('a person accepts after a warning when the section changed; the agent inbox gets approval_result', async () => {
    const P = await newPage('Budget', [heading('Costs'), para('rent 100'), heading('Other'), para('x')])
    const v = await versionOf(P, 'costs')
    const r = await B.tool('patch_section', { pageId: P, section: 'costs', mode: 'replace', markdown: 'rent 120', baseVersion: v, suggest: true })
    const id = suggestionId(r.text)
    // web view: preview diff against the section now, no change yet
    const list = (await req(alice, 'GET', `/pages/${P}/suggestions?preview=1`)).json()
    assert.equal(list.canDecide, true)
    assert.equal(list.suggestions.length, 1)
    assert.equal(list.suggestions[0].preview.changed, false)
    assert.deepEqual(list.suggestions[0].preview.ops.filter((o: { t: string }) => o.t !== '='), [
      { t: '-', s: 'rent 100' },
      { t: '+', s: 'rent 120' },
    ])
    // an agent may not decide, even on REST
    const byAgent = await bearer(tokenB, 'POST', `/suggestions/${id}/accept`, {})
    assert.equal(byAgent.statusCode, 403)
    assert.equal(code(byAgent), 'PEOPLE_DECIDE')
    // meanwhile alice edits the section in the app
    const edit = await req(alice, 'POST', `/pages/${P}/section`, { ref: 'costs', mode: 'append', markdown: 'power 30' })
    assert.equal(edit.statusCode, 200, edit.body)
    const first = await req(alice, 'POST', `/suggestions/${id}/accept`, {})
    assert.equal(first.statusCode, 409, first.body)
    assert.equal(code(first), 'SUGGESTION_CHANGED')
    const preview = first.json().error.preview
    assert.equal(preview.changed, true)
    assert.match(preview.before, /power 30/)
    const ok = await req(alice, 'POST', `/suggestions/${id}/accept`, { confirmChanged: true })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().suggestion.status, 'accepted')
    assert.equal(ok.json().suggestion.decidedBy.id, alice.id)
    const now = await sectionText(P, 'costs')
    assert.match(now, /rent 120/)
    assert.doesNotMatch(now, /rent 100|power 30/)
    assert.match(await sectionText(P, 'other'), /^## Other\n\nx$/)
    // twice: refused
    assert.equal(code(await req(alice, 'POST', `/suggestions/${id}/accept`, { confirmChanged: true })), 'SUGGESTION_DECIDED')
    await flushNotifications()
    const inbox = await B.tool('inbox', { kinds: ['approval_result'] })
    assert.match(inbox.text, new RegExp(`approval_result \\| page ${P} "Budget" §costs \\| Alice`))
    assert.match(inbox.text, new RegExp(`accepted: suggestion ${id} \\(replace §costs\\)`))
  })

  it('accept follows a heading rename (block id, docs/adr/1501-*)', async () => {
    const P = await newPage('Costs page', [heading('Costs'), para('rent 100'), heading('Tail'), para('t')])
    const v = await versionOf(P, 'costs')
    const id = suggestionId((await B.tool('patch_section', { pageId: P, section: 'costs', mode: 'replace', markdown: 'rent 150', baseVersion: v, suggest: true })).text)
    const ren = await req(alice, 'POST', `/pages/${P}/section`, { ref: 'costs', mode: 'replace', markdown: '## Expenses\n\nrent 100', baseVersion: v })
    assert.equal(ren.statusCode, 200, ren.body)
    await drainChangeLog()
    const pre = (await req(alice, 'GET', `/suggestions/${id}?preview=1`)).json().suggestion.preview
    assert.equal(pre.found, true)
    assert.equal(pre.currentAnchor, 'expenses')
    assert.equal(pre.changed, true, 'the version includes the heading')
    const ok = await req(alice, 'POST', `/suggestions/${id}/accept`, { confirmChanged: true })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(await sectionText(P, 'expenses'), '## Expenses\n\nrent 150')
  })

  it('reject and withdraw; only the author withdraws; the agent sees the result', async () => {
    const P = await newPage('Notes', [heading('Ideas'), para('one')])
    const r1 = await B.tool('patch_section', { pageId: P, section: 'ideas', mode: 'append', markdown: 'two', suggest: true })
    const id1 = suggestionId(r1.text)
    const rej = await req(alice, 'POST', `/suggestions/${id1}/reject`, {})
    assert.equal(rej.statusCode, 200, rej.body)
    assert.equal(rej.json().suggestion.status, 'rejected')
    assert.match(await sectionText(P, 'ideas'), /^## Ideas\n\none$/)
    await flushNotifications()
    assert.match((await B.tool('inbox', { kinds: ['approval_result'] })).text, new RegExp(`rejected: suggestion ${id1}`))
    const r2 = await B.tool('patch_section', { pageId: P, section: 'ideas', mode: 'append', markdown: 'three', suggest: true })
    const id2 = suggestionId(r2.text)
    assert.equal((await A.tool('withdraw_suggestion', { suggestionId: id2 })).isError, true, 'not alice\'s suggestion')
    const w = await B.tool('withdraw_suggestion', { suggestionId: id2 })
    assert.equal(w.isError, false, w.text)
    assert.match(w.text, /^Withdrawn: suggestion/)
    // a withdrawn suggestion says so (docs/adr/1626-*)
    assert.equal(code(await req(alice, 'POST', `/suggestions/${id2}/accept`, {})), 'SUGGESTION_WITHDRAWN')
    // a non-member sees nothing
    assert.equal((await req(carol, 'GET', `/pages/${P}/suggestions`)).statusCode, 404)
    assert.equal((await req(carol, 'GET', `/suggestions/${id2}`)).statusCode, 404)
    assert.equal((await C.tool('list_suggestions', { pageId: P })).isError, true)
  })

  it('"agents: suggestions only" lock turns patch_section and update_page into suggestions', async () => {
    const P = await newPage('Policy', [heading('Rules'), para('be kind')])
    const lock = await req(alice, 'PUT', `/pages/${P}/lock`, { locked: true, people: 'everyone', agents: 'suggest' })
    assert.equal(lock.statusCode, 200, lock.body)
    const st = (await req(alice, 'GET', `/pages/${P}/lock`)).json()
    assert.equal(st.agents, 'suggest')
    const v = await versionOf(P, 'rules')
    const p = await B.tool('patch_section', { pageId: P, section: 'rules', mode: 'replace', markdown: 'be very kind', baseVersion: v })
    assert.equal(p.isError, false, p.text)
    assert.match(p.text, /locked to "agents: suggestions only"/)
    const u = await B.tool('update_page', { pageId: P, mode: 'append', markdown: 'appendix' })
    assert.equal(u.isError, false, u.text)
    assert.match(u.text, /^Not written: kept as suggestion [0-9a-f-]{36} for whole page/)
    assert.match(await sectionText(P, 'rules'), /be kind/)
    // the can: line says so
    const o = await B.tool('read_page', { pageId: P, outline: true })
    assert.match(o.text, /can: read,comment,suggest/)
    // other writes are refused with the suggestion wording
    const ren = await B.tool('rename_page', { pageId: P, title: 'X' })
    assert.equal(ren.isError, true)
    assert.match(ren.text, /suggestions only/)
    // people are not affected
    const byBob = await req(bob, 'POST', `/pages/${P}/section`, { ref: 'rules', mode: 'append', markdown: 'by bob' })
    assert.equal(byBob.statusCode, 200, byBob.body)
    // accepting the whole-page append
    const rows = await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.pageId, P))
    const page = rows.find((r) => r.mode === 'page_append')!
    assert.equal(page.origin, 'lock')
    assert.equal(page.anchor, '')
    const acc = await req(alice, 'POST', `/suggestions/${page.id}/accept`, { confirmChanged: true })
    assert.equal(acc.statusCode, 200, acc.body)
    const md = (await req(alice, 'GET', `/pages/${P}/export?format=md`)).body
    assert.match(md, /appendix/)
    // comment-only for agents: no suggestion, the usual refusal
    await req(alice, 'PUT', `/pages/${P}/lock`, { locked: true, agents: 'comment' })
    const c = await B.tool('patch_section', { pageId: P, section: 'rules', mode: 'append', markdown: 'nope' })
    assert.equal(c.isError, true)
    assert.match(c.text, /comment only/)
    const cs = await B.tool('patch_section', { pageId: P, section: 'rules', mode: 'append', markdown: 'nope', suggest: true })
    assert.equal(cs.isError, true, 'suggest=true does not get around a comment-only lock')
    // people limited to editors: bob's agent cannot suggest either (bob may not edit)
    await req(alice, 'PUT', `/pages/${P}/lock`, { locked: true, people: 'editors', agents: 'suggest' })
    const e = await B.tool('patch_section', { pageId: P, section: 'rules', mode: 'append', markdown: 'nope' })
    assert.equal(e.isError, true)
    assert.match(e.text, /locked for editing/)
    // alice's own agent (she owns the page) leaves suggestions
    const a = await A.tool('patch_section', { pageId: P, section: 'rules', mode: 'append', markdown: 'from alice agent' })
    assert.match(a.text, /^Not written: kept as suggestion/)
  })

  it('patch_sections suggest=true: one suggestion per section, all or none, one approval_request', async () => {
    const P = await newPage('Batch', [heading('One'), para('1'), heading('Two'), para('2')])
    const bad = await B.tool('patch_sections', {
      pageId: P,
      suggest: true,
      edits: [
        { section: 'one', mode: 'append', markdown: 'x' },
        { section: 'nope', mode: 'append', markdown: 'y' },
      ],
    })
    assert.equal(bad.isError, true)
    assert.equal((await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.pageId, P))).length, 0, 'nothing kept')
    // a claim by another connection does not stop suggestions
    assert.equal((await A.tool('claim_section', { pageId: P, section: 'two' })).isError, false)
    const ok = await B.tool('patch_sections', {
      pageId: P,
      suggest: true,
      edits: [
        { section: 'one', mode: 'append', markdown: 'x' },
        { section: 'two', mode: 'replace', markdown: 'zwei', baseVersion: await versionOf(P, 'two') },
      ],
    })
    assert.equal(ok.isError, false, ok.text)
    assert.match(ok.text, /^Not written: kept as 2 suggestions on page .*you asked for suggestions/)
    assert.match(ok.text, /for §one \(append\): waits for a person\n- [0-9a-f-]{36} for §two \(replace\): waits for a person/)
    const rows = await db.select().from(schema.sectionSuggestions).where(eq(schema.sectionSuggestions.pageId, P))
    assert.deepEqual(rows.map((r) => r.anchor).sort(), ['one', 'two'])
    assert.match(await sectionText(P, 'one'), /^## One\n\n1$/)
    await flushNotifications()
    const req1 = (await db.select().from(schema.notifications).where(eq(schema.notifications.userId, alice.id))).filter(
      (n) => n.type === 'approval_request' && n.pageId === P,
    )
    assert.equal(req1.length, 1)
  })

  it('lock bits: a nearer comment-only rule (also a pre-0.12 row) removes an outer "suggest"', async () => {
    const { effectiveCaps, nodePresets, CAP_EDIT, CAP_COMMENT, CAP_SUGGEST } = await import('../editLock')
    const node = (id: string, overrides: { s: string; a: number; d: number }[]) => ({ id, title: id, ownerId: null, overrides })
    const agent = { userId: 'u', role: 'member' as const, agent: true }
    const outer = node('o', [{ s: 'agents', a: CAP_SUGGEST, d: CAP_EDIT }])
    assert.equal(nodePresets(outer).agents, 'suggest')
    assert.equal(effectiveCaps([outer], agent), CAP_COMMENT | CAP_SUGGEST)
    assert.equal(effectiveCaps([outer], { ...agent, agent: false }), CAP_EDIT | CAP_COMMENT)
    const legacyComment = node('l', [{ s: 'agents', a: 0, d: CAP_EDIT }])
    assert.equal(nodePresets(legacyComment).agents, 'comment')
    assert.equal(effectiveCaps([outer, legacyComment], agent), CAP_COMMENT)
    // people limited to editors: the agent of a non-editor may not suggest
    const editorsOnly = node('e', [{ s: 'everyone', a: 0, d: CAP_EDIT }, { s: 'agents', a: CAP_SUGGEST, d: CAP_EDIT }])
    assert.equal(effectiveCaps([editorsOnly], agent), CAP_COMMENT)
    assert.equal(effectiveCaps([editorsOnly], { ...agent, role: 'admin' }), CAP_COMMENT | CAP_SUGGEST)
  })

  it('claims: other agents are refused, suggestions and people are not; read_page shows the claim; expiry', async () => {
    const P = await newPage('Spec', [heading('API'), para('v1'), heading('UI'), para('dark')])
    const cl = await B.tool('claim_section', { pageId: P, section: 'api', minutes: 10 })
    assert.equal(cl.isError, false, cl.text)
    assert.match(cl.text, /^Claimed §api of page [0-9a-f-]{36} until \d{4}-\d\d-\d\dT\d\d:\d\dZ\. release_section/)
    // alice's agent: refused on §api, fine on §ui
    const v = await versionOf(P, 'api')
    const no = await A.tool('patch_section', { pageId: P, section: 'api', mode: 'replace', markdown: 'v2', baseVersion: v })
    assert.equal(no.isError, true)
    assert.match(no.text, /claimed by Claude until .*nothing was written.*suggest=true/s)
    assert.equal((await A.tool('patch_section', { pageId: P, section: 'ui', mode: 'append', markdown: 'light' })).isError, false)
    const sug = await A.tool('patch_section', { pageId: P, section: 'api', mode: 'replace', markdown: 'v2', baseVersion: v, suggest: true })
    assert.match(sug.text, /^Not written: kept as suggestion/)
    // whole-body replace refused, append allowed
    assert.equal((await A.tool('update_page', { pageId: P, mode: 'replace', markdown: '# x' })).isError, true)
    assert.equal((await A.tool('update_page', { pageId: P, mode: 'append', markdown: 'tail' })).isError, false)
    // the claiming connection and people write as usual
    assert.equal((await B.tool('patch_section', { pageId: P, section: 'api', mode: 'append', markdown: 'by claimer' })).isError, false)
    assert.equal((await req(alice, 'POST', `/pages/${P}/section`, { ref: 'api', mode: 'append', markdown: 'by person' })).statusCode, 200)
    // shown to agents and in the web list
    const o = await A.tool('read_page', { pageId: P, outline: true })
    assert.match(o.text, /§api .*claimed by Claude until \d{4}-\d\d-\d\dT\d\d:\d\dZ/)
    assert.match((await B.tool('read_page', { pageId: P, section: 'api' })).text, /claimed by this connection until/)
    const web = (await req(alice, 'GET', `/pages/${P}/suggestions`)).json()
    assert.equal(web.claims.length, 1)
    assert.equal(web.claims[0].by, 'Claude')
    // a second claim by another connection is refused; a person cannot claim
    assert.equal((await A.tool('claim_section', { pageId: P, section: 'api' })).isError, true)
    assert.equal((await req(alice, 'POST', `/pages/${P}/claims`, { section: 'api' })).statusCode, 400)
    // release, then alice's agent may write
    assert.equal((await B.tool('release_section', { pageId: P, section: 'api' })).isError, false)
    assert.equal((await A.tool('patch_section', { pageId: P, section: 'api', mode: 'append', markdown: 'after' })).isError, false)
    // an expired claim is free (and taken over by a new claim)
    await B.tool('claim_section', { pageId: P, section: 'ui' })
    await db.execute(sql`UPDATE section_leases SET expires_at = now() - interval '1 second' WHERE page_id = ${P}`)
    assert.equal((await A.tool('patch_section', { pageId: P, section: 'ui', mode: 'append', markdown: 'free' })).isError, false)
    assert.equal((await A.tool('claim_section', { pageId: P, section: 'ui' })).isError, false)
    const { sweepExpiredLeases } = await import('../leases')
    await db.execute(sql`UPDATE section_leases SET expires_at = now() - interval '2 minutes' WHERE page_id = ${P}`)
    assert.ok((await sweepExpiredLeases()) >= 1)
  })
})
