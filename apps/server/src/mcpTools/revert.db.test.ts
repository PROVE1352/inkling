// Reverting logged changes (docs/adr/1620-* .. 1624-*) against a real database: one agent edit is
// reverted while a person's later edit and the agent's other edit stay; the revert is a change of
// the person (audit-linked) and can itself be reverted; overlapping edits are conflicts and nothing
// is written; removed text comes back with its formatting from the "Before AI edit" version (as
// plain text when no version has it); added/removed sections; one agent's run on a page and in the
// workspace (owners/admins only); agents may not revert; changes_since shows the revert.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// run-tests: db-exclusive
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] reverting changes', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { currentBlocks } = await import('../context/sectionSource')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('../oauth')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'paragraph', content: [{ type: 'text', text, styles }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })

  let alice: U, bob: U
  let wsId: string
  let tokenA: string
  let A: Awaited<ReturnType<typeof h.connectMcp>> // alice's agent "Claude"

  async function newPage(title: string, blocks: unknown[]) {
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const sectionText = async (pageId: string, anchor: string) => (await req(alice, 'GET', `/pages/${pageId}/section?ref=${anchor}`)).json().markdown as string
  const versionOf = async (pageId: string, anchor: string) =>
    ((await req(alice, 'GET', `/pages/${pageId}/outline`)).json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === anchor)!.version
  const agentPatch = async (pageId: string, section: string, mode: string, markdown: string, agent = A) => {
    const baseVersion = mode === 'replace' || mode === 'delete' ? await versionOf(pageId, section) : undefined
    const r = await agent.tool('patch_section', { pageId, section, mode, markdown, ...(baseVersion ? { baseVersion } : {}) })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
  }
  const personPatch = async (pageId: string, ref: string, mode: string, markdown: string) => {
    const r = await req(alice, 'POST', `/pages/${pageId}/section`, { ref, mode, markdown })
    assert.equal(r.statusCode, 200, r.body)
    await drainChangeLog()
  }
  type Item = { seq: string; kind: string; anchor: string | null; via: string | null; actor: { name: string } | null; revert?: { revertable: boolean; revertedBy: { name: string } | null; isRevert: boolean } }
  const changes = async (pageId: string) => (await req(alice, 'GET', `/pages/${pageId}/changes`)).json().items as Item[]

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    tokenA = await h.mintToken(alice, 'notes', 'Claude')
    A = await h.connectMcp(app, alice, tokenA)
  })
  after(async () => {
    await A.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('reverts one agent edit; the person\'s later edit and the agent\'s other edit stay; the revert is revertable', async () => {
    const P = await newPage('Revert one', [heading('Notes'), para('one'), para('two'), para('three'), heading('Other'), para('x')])
    await agentPatch(P, 'notes', 'replace', 'one\n\nTWO by agent\n\nthree')
    await agentPatch(P, 'other', 'append', 'agent line')
    await personPatch(P, 'notes', 'replace', '## Notes\n\none\n\nTWO by agent\n\nthree by person')
    const list = await changes(P)
    const agentNotes = list.find((c) => c.anchor === 'notes' && c.via === 'Claude')!
    assert.ok(agentNotes, JSON.stringify(list))
    assert.equal(agentNotes.revert?.revertable, true)
    const human = list.find((c) => c.anchor === 'notes' && c.via === null)!
    assert.equal(human.actor?.name, 'Alice')

    const dry = await req(alice, 'POST', `/changes/${agentNotes.seq}/revert`, { dryRun: true })
    assert.equal(dry.statusCode, 200, dry.body)
    assert.equal(dry.json().dryRun, true)
    assert.equal(dry.json().pages[0].changes[0].outcome, 'applied')
    assert.equal(dry.json().pages[0].written, false)
    assert.match(await sectionText(P, 'notes'), /TWO by agent/)

    const run = await req(alice, 'POST', `/changes/${agentNotes.seq}/revert`, {})
    assert.equal(run.statusCode, 200, run.body)
    assert.equal(run.json().pages[0].written, true)
    assert.equal(run.json().pages[0].changes[0].plainText, 0, 'two came back from the page versions')
    assert.equal(await sectionText(P, 'notes'), '## Notes\n\none\n\ntwo\n\nthree by person')
    assert.match(await sectionText(P, 'other'), /agent line/)

    // the revert is the person's change, linked in the audit log, and marked in the history
    const after1 = await changes(P)
    const own = after1.find((c) => c.revert?.isRevert)!
    assert.ok(own, JSON.stringify(after1))
    assert.equal(own.via, null)
    assert.equal(own.actor?.name, 'Alice')
    assert.equal(after1.find((c) => c.seq === agentNotes.seq)!.revert?.revertedBy?.name, 'Alice')
    const audit = await db
      .select()
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.workspaceId, wsId), eq(schema.workspaceAuditEvents.action, 'page.changes_reverted')))
    assert.ok(audit.some((e) => (e.before as { seqs: string[] }).seqs.includes(agentNotes.seq)))

    // revert the revert: the agent's text is back, the person's edit still stays
    const again = await req(alice, 'POST', `/changes/${own.seq}/revert`, {})
    assert.equal(again.statusCode, 200, again.body)
    assert.equal(await sectionText(P, 'notes'), '## Notes\n\none\n\nTWO by agent\n\nthree by person')
  })

  it('an edit that overlaps a later edit is a conflict and nothing is written', async () => {
    const P = await newPage('Revert clash', [heading('S'), para('a'), para('b')])
    await agentPatch(P, 's', 'replace', 'a\n\nB agent')
    await personPatch(P, 's', 'replace', '## S\n\na\n\nB person')
    const seq = (await changes(P)).find((c) => c.via === 'Claude')!.seq
    const r = await req(alice, 'POST', `/changes/${seq}/revert`, {})
    assert.equal(r.statusCode, 200, r.body)
    const c = r.json().pages[0].changes[0]
    assert.equal(c.outcome, 'conflict')
    assert.deepEqual(c.conflicts, [{ wanted: 'b', now: 'B person', reason: 'overlap' }])
    assert.equal(r.json().pages[0].written, false)
    assert.equal(await sectionText(P, 's'), '## S\n\na\n\nB person')
  })

  it('removed text comes back with its marks from the "Before AI edit" version, else as plain text', async () => {
    const P = await newPage('Revert format', [heading('F'), para('keep'), para('important', { bold: true })])
    await agentPatch(P, 'f', 'replace', 'keep\n\nreplaced')
    const seq = (await changes(P)).find((c) => c.via === 'Claude')!.seq
    const dry = (await req(alice, 'POST', `/changes/${seq}/revert`, { dryRun: true })).json()
    assert.equal(dry.pages[0].changes[0].plainText, 0)
    // without any stored version the same text comes back as plain text (and says so)
    await db.delete(schema.pageSnapshots).where(eq(schema.pageSnapshots.pageId, P))
    const plain = (await req(alice, 'POST', `/changes/${seq}/revert`, { dryRun: true })).json()
    assert.equal(plain.pages[0].changes[0].plainText, 1)

    const P2 = await newPage('Revert format 2', [heading('F'), para('keep'), para('important', { bold: true })])
    await agentPatch(P2, 'f', 'replace', 'keep\n\nreplaced')
    const seq2 = (await changes(P2)).find((c) => c.via === 'Claude')!.seq
    const keepId = (await currentBlocks(P2))[1].id
    const run = await req(alice, 'POST', `/changes/${seq2}/revert`, {})
    assert.equal(run.statusCode, 200, run.body)
    const blocks = await currentBlocks(P2)
    assert.equal(blocks[1].id, keepId, 'untouched block keeps its id')
    const restored = blocks[2].content as { text: string; styles: Record<string, unknown> }[]
    assert.equal(restored[0].text, 'important')
    assert.equal(restored[0].styles.bold, true)
  })

  it('a run of AI steps right after the change does not push its formatting source out (docs/adr/2180-*)', async () => {
    const P = await newPage('Revert long run', [heading('F'), para('keep'), para('important', { bold: true }), heading('G'), para('g')])
    await agentPatch(P, 'f', 'replace', 'keep\n\nreplaced')
    // ten more agent writes within seconds: ten AI step rows newer than the change
    for (let i = 0; i < 10; i++) await agentPatch(P, 'g', 'append', `g line ${i}`)
    const seq = (await changes(P)).find((c) => c.via === 'Claude' && c.anchor === 'f')!.seq
    const dry = (await req(alice, 'POST', `/changes/${seq}/revert`, { dryRun: true })).json()
    assert.equal(dry.pages[0].changes[0].plainText, 0, JSON.stringify(dry))
  })

  it('an added section is removed again; a removed section comes back after its old neighbour', async () => {
    const P = await newPage('Revert sections', [heading('One'), para('1'), heading('Two'), para('2'), heading('Three'), para('3')])
    await agentPatch(P, 'one', 'insert_after', '## Added\n\nnew text')
    const added = (await changes(P)).find((c) => c.via === 'Claude' && c.kind === 'added')!
    assert.ok(added)
    const r1 = await req(alice, 'POST', `/changes/${added.seq}/revert`, {})
    assert.equal(r1.json().pages[0].changes[0].outcome, 'applied', r1.body)
    const outline = async () => ((await req(alice, 'GET', `/pages/${P}/outline`)).json().sections as { anchor: string }[]).map((s) => s.anchor)
    assert.deepEqual(await outline(), ['one', 'two', 'three'])

    const v = await versionOf(P, 'two')
    const del = await A.tool('patch_section', { pageId: P, section: 'two', mode: 'delete', markdown: '', baseVersion: v })
    assert.equal(del.isError, false, del.text)
    await drainChangeLog()
    assert.deepEqual(await outline(), ['one', 'three'])
    const removed = (await changes(P)).find((c) => c.via === 'Claude' && c.kind === 'removed')!
    const r2 = await req(alice, 'POST', `/changes/${removed.seq}/revert`, {})
    assert.equal(r2.json().pages[0].changes[0].outcome, 'applied', r2.body)
    assert.deepEqual(await outline(), ['one', 'two', 'three'])
    assert.equal(await sectionText(P, 'two'), '## Two\n\n2')
  })

  it("one agent's run on a page and in the workspace: preview, owners/admins only, per-page results", async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const tokenW = await h.mintToken(alice, 'notes', 'Writer')
    const W = await h.connectMcp(app, alice, tokenW)
    const P1 = await newPage('Run one', [heading('A'), para('a1'), para('a2')])
    const P2 = await newPage('Run two', [heading('B'), para('b1')])
    await agentPatch(P1, 'a', 'replace', 'a1 agent\n\na2', W)
    await agentPatch(P2, 'b', 'append', 'b2 agent', W)
    await personPatch(P1, 'a', 'append', 'a3 person')
    const cursor = /cursor: (\S+)$/m.exec((await A.tool('changes_since', { workspaceId: wsId })).text)![1]

    const pagePreview = await req(alice, 'POST', `/pages/${P1}/revert`, { via: 'Writer', since, dryRun: true })
    assert.equal(pagePreview.statusCode, 200, pagePreview.body)
    assert.equal(pagePreview.json().pages.length, 1)

    // only owners and admins revert workspace-wide
    const byMember = await req(bob, 'POST', `/workspaces/${wsId}/revert`, { via: 'Writer', since, dryRun: true })
    assert.equal(byMember.statusCode, 403, byMember.body)
    // an agent connection may never revert (people decide)
    const byAgent = await app.inject({
      method: 'POST',
      url: `/api/pages/${P1}/revert`,
      headers: { authorization: `Bearer ${tokenA}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET },
      payload: { via: 'Writer', since },
    })
    assert.equal(byAgent.statusCode, 403, byAgent.body)

    const preview = (await req(alice, 'POST', `/workspaces/${wsId}/revert`, { via: 'Writer', since, dryRun: true })).json()
    const titles = preview.pages.map((p: { title: string }) => p.title).sort()
    assert.deepEqual(titles, ['Run one', 'Run two'])
    assert.equal(preview.totals.applied, 2)
    assert.equal(await sectionText(P2, 'b'), '## B\n\nb1\n\nb2 agent', 'preview writes nothing')

    const run = (await req(alice, 'POST', `/workspaces/${wsId}/revert`, { via: 'Writer', since })).json()
    assert.equal(run.totals.applied, 2)
    assert.ok(run.pages.every((p: { written: boolean }) => p.written))
    assert.equal(await sectionText(P1, 'a'), '## A\n\na1\n\na2\n\na3 person')
    assert.equal(await sectionText(P2, 'b'), '## B\n\nb1')

    // the agent reading the feed sees the revert as Alice's edits
    await W.close()
    const feed = await A.tool('changes_since', { workspaceId: wsId, cursor })
    assert.equal(feed.isError, false, feed.text)
    // a plain modification by the person who reverted, with the inverse diff (no agent tool, ADR 1624)
    assert.match(feed.text, /page "Run two" \S+ \(by Alice\)\n  modified b \(B\)\n      b1\n    - b2 agent/)
    assert.match(feed.text, /page "Run one" \S+ \(by Alice\)\n  modified a \(A\)\n    - a1 agent\n    \+ a1/)
  })
})
