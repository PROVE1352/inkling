// Per-hunk acceptance of replace suggestions (docs/adr/1621-*, 1622-*) against a real database: the
// base is stored when the agent suggests, a person edits another block meanwhile, the review shows
// hunks with the overlapping one marked as a conflict, accepting only the clean hunk keeps the
// person's edit (and the untouched blocks' ids and colors), accepted_partial is reported to the
// agent, a stale merge key is refused, an unknown base marks every hunk.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] suggestion hunks (3-way partial accept)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { and, eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { reindexPageChunks } = await import('../context/chunkIndex')
  const { drainChangeLog } = await import('../context/changeLog')
  const { currentBlocks } = await import('../context/sectionSource')
  const { flushNotifications } = await import('../notify/engine')
  const { SUGGESTION_BASE_STORE } = await import('../suggestionMerge')
  const app = await h.buildTestApp()

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const para = (text: string, props: Record<string, unknown> = {}) => ({ type: 'paragraph', props, content: [{ type: 'text', text, styles: {} }] })
  const heading = (text: string) => ({ type: 'heading', props: { level: 2 }, content: [{ type: 'text', text, styles: {} }] })

  let alice: U, bob: U
  let wsId: string
  let B: Awaited<ReturnType<typeof h.connectMcp>>

  async function newPage(title: string, blocks: unknown[]) {
    const pg = await h.makeDocPage(wsId, alice.id, title, blocks as never)
    await reindexPageChunks(pg.id, blocks as never)
    await drainChangeLog()
    return pg.id
  }
  const versionOf = async (pageId: string, anchor: string) =>
    ((await req(alice, 'GET', `/pages/${pageId}/outline`)).json().sections as { anchor: string; version: string }[]).find((s) => s.anchor === anchor)!.version
  const sectionText = async (pageId: string, anchor: string) => (await req(alice, 'GET', `/pages/${pageId}/section?ref=${anchor}`)).json().markdown as string
  const suggestionId = (t: string) => /suggestion ([0-9a-f-]{36})/.exec(t)![1]
  const previewOf = async (id: string) => (await req(alice, 'GET', `/suggestions/${id}?preview=1`)).json().suggestion.preview

  before(async () => {
    alice = await h.makeUser('Alice')
    bob = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(alice, [bob])).id
    B = await h.connectMcp(app, bob, await h.mintToken(bob, 'notes', 'Claude'))
  })
  after(async () => {
    await B.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  it('stores the base, splits the change into hunks and accepts only the clean one around a person edit', async () => {
    const P = await newPage('Plan page', [heading('Plan'), para('alpha', { backgroundColor: 'yellow' }), para('beta'), para('gamma'), para('delta'), heading('Tail'), para('t')])
    const v = await versionOf(P, 'plan')
    const r = await B.tool('patch_section', { pageId: P, section: 'plan', mode: 'replace', markdown: 'alpha\n\nBETA by agent\n\ngamma\n\nDELTA by agent', baseVersion: v, suggest: true })
    assert.equal(r.isError, false, r.text)
    const id = suggestionId(r.text)
    const [stored] = await db
      .select()
      .from(schema.pluginStorage)
      .where(and(eq(schema.pluginStorage.pluginId, SUGGESTION_BASE_STORE), eq(schema.pluginStorage.key, id)))
    assert.ok(stored, 'base stored at suggestion time')
    assert.match(JSON.parse(stored.value).md, /delta/)

    // unchanged section: two clean hunks
    const p0 = await previewOf(id)
    assert.equal(p0.merge.baseKnown, true)
    assert.deepEqual(
      p0.merge.hunks.map((x: { conflict: boolean; before: string; after: string }) => [x.conflict, x.before, x.after]),
      [
        [false, 'beta', 'BETA by agent'],
        [false, 'delta', 'DELTA by agent'],
      ],
    )

    // the person edits delta meanwhile (another block than beta)
    const before = await currentBlocks(P)
    const alphaId = before[1].id
    const edit = await req(alice, 'POST', `/pages/${P}/section`, { ref: 'plan', mode: 'replace', markdown: '## Plan\n\nalpha\n\nbeta\n\ngamma\n\ndelta by person' })
    assert.equal(edit.statusCode, 200, edit.body)
    const p1 = await previewOf(id)
    assert.equal(p1.changed, true)
    const [clean, clash] = p1.merge.hunks
    assert.equal(clean.conflict, false)
    assert.equal(clash.conflict, true)
    assert.equal(clash.ours, 'delta by person')

    // a stale key is refused with the fresh hunks
    const stale = await req(alice, 'POST', `/suggestions/${id}/accept`, { hunks: [clean.id], mergeKey: p0.merge.key })
    assert.equal(stale.statusCode, 409, stale.body)
    assert.equal(stale.json().error.code, 'SUGGESTION_CHANGED')
    assert.equal(stale.json().error.preview.merge.key, p1.merge.key)
    // nothing chosen → 400
    assert.equal((await req(alice, 'POST', `/suggestions/${id}/accept`, { hunks: [], mergeKey: p1.merge.key })).statusCode, 400)

    const ok = await req(alice, 'POST', `/suggestions/${id}/accept`, { hunks: [clean.id], mergeKey: p1.merge.key })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().suggestion.status, 'accepted_partial')
    assert.deepEqual(ok.json().suggestion.partial, { applied: 1, total: 2 })
    assert.equal(await sectionText(P, 'plan'), '## Plan\n\nalpha\n\nBETA by agent\n\ngamma\n\ndelta by person')
    assert.match(await sectionText(P, 'tail'), /^## Tail\n\nt$/)
    // the untouched block kept its id and its color (not expressible in Markdown)
    const afterBlocks = await currentBlocks(P)
    assert.equal(afterBlocks[1].id, alphaId)
    assert.equal(afterBlocks[1].props?.backgroundColor, 'yellow')

    // the agent learns that only part of it went in
    const list = await B.tool('list_suggestions', { status: 'decided' })
    assert.match(list.text, new RegExp(`${id} \\| accepted_partial \\(1 of 2 changes applied\\)`))
    await flushNotifications()
    const inbox = await B.tool('inbox', { kinds: ['approval_result'] })
    assert.match(inbox.text, new RegExp(`accepted_partial \\(1 of 2 changes\\): suggestion ${id}`))
    // the history keeps the record
    const all = (await req(alice, 'GET', `/pages/${P}/suggestions?all=1`)).json().suggestions
    assert.deepEqual(all.find((s: { id: string }) => s.id === id).partial, { applied: 1, total: 2 })
  })

  it('choosing every hunk of a changed section merges instead of overwriting the person (accepted)', async () => {
    const P = await newPage('Merge page', [heading('Notes'), para('one'), para('two'), para('three')])
    const v = await versionOf(P, 'notes')
    const id = suggestionId((await B.tool('patch_section', { pageId: P, section: 'notes', mode: 'replace', markdown: 'one\n\nTWO\n\nthree', baseVersion: v, suggest: true })).text)
    const edit = await req(alice, 'POST', `/pages/${P}/section`, { ref: 'notes', mode: 'append', markdown: 'four by person' })
    assert.equal(edit.statusCode, 200, edit.body)
    const p = await previewOf(id)
    assert.equal(p.merge.hunks.length, 1)
    assert.equal(p.merge.hunks[0].conflict, false)
    const ok = await req(alice, 'POST', `/suggestions/${id}/accept`, { hunks: [0], mergeKey: p.merge.key })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(ok.json().suggestion.status, 'accepted')
    assert.equal(await sectionText(P, 'notes'), '## Notes\n\none\n\nTWO\n\nthree\n\nfour by person')
    const left = await db.select().from(schema.pluginStorage).where(and(eq(schema.pluginStorage.pluginId, SUGGESTION_BASE_STORE), eq(schema.pluginStorage.key, id)))
    assert.equal(left.length, 0, 'base dropped once decided')
  })

  it('a stale baseVersion stores no base: once the section changed, every hunk is marked', async () => {
    const P = await newPage('Stale page', [heading('Sec'), para('x'), para('y')])
    const v = await versionOf(P, 'sec')
    await req(alice, 'POST', `/pages/${P}/section`, { ref: 'sec', mode: 'append', markdown: 'z' })
    const id = suggestionId((await B.tool('patch_section', { pageId: P, section: 'sec', mode: 'replace', markdown: 'X\n\ny', baseVersion: v, suggest: true })).text)
    const p = await previewOf(id)
    assert.equal(p.merge.baseKnown, false)
    assert.ok(p.merge.hunks.length > 0)
    assert.ok(p.merge.hunks.every((x: { conflict: boolean; same: boolean }) => x.conflict || x.same))
    // whole accept still works as before (with the warning)
    const first = await req(alice, 'POST', `/suggestions/${id}/accept`, {})
    assert.equal(first.json().error.code, 'SUGGESTION_CHANGED')
  })

  it('hunks only for section replace', async () => {
    const P = await newPage('Append page', [heading('Log'), para('a')])
    const id = suggestionId((await B.tool('patch_section', { pageId: P, section: 'log', mode: 'append', markdown: 'b', suggest: true })).text)
    const p = await previewOf(id)
    assert.equal(p.merge, undefined)
    const r = await req(alice, 'POST', `/suggestions/${id}/accept`, { hunks: [0], mergeKey: 'x' })
    assert.equal(r.statusCode, 400, r.body)
  })
})
