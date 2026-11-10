// MCP tool surface, 0.15.1 (docs/adr/1940-* .. 1948-*): short ids in every tool and what a prefix
// may reveal, workspace inference, the update_page replace precondition, outline known and short
// anchors, backlinks on read_page, create_page kinds.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-toolsurface-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] MCP tool surface 0.15.1: short ids, inferred workspaces, replace precondition', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { blocksToStateBuffer } = await import('../md/convert')
  const { drainChangeLog } = await import('../context/changeLog')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let owner: U
  let other: U
  let outsider: U
  let ws: { id: string }
  let ws2: { id: string }
  let foreign: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  /** A page row with a chosen id (to share an 8-character prefix on purpose). */
  const insert = async (id: string, workspaceId: string, title: string, by: string, scope: 'shared' | 'private' = 'shared') => {
    await db.insert(schema.pages).values({ id, workspaceId, title, createdBy: by, kind: 'doc', scope })
    await db.insert(schema.pageDocs).values({ pageId: id, state: blocksToStateBuffer([para(title)] as never) })
  }
  const create = async (args: Record<string, unknown>, m = mcp) => {
    const r = await m.tool('create_page', { workspaceId: ws.id, ...args })
    assert.equal(r.isError, false, r.text)
    return JSON.parse(r.text) as { id: string; workspaceId: string; parentId: string | null; kind?: string }
  }
  const hex8 = () => randomBytes(4).toString('hex')

  before(async () => {
    owner = await h.makeUser('Owner')
    other = await h.makeUser('Other')
    outsider = await h.makeUser('Outsider')
    ws = await h.makeWorkspace(owner, [other])
    ws2 = await h.makeWorkspace(owner)
    foreign = await h.makeWorkspace(outsider)
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner), { user: { ...owner, via: 'Test Agent' } })
  })

  // --- short ids and what a prefix reveals (docs/adr/1941-*) ------------------------------------

  it('a prefix shared with a page the agent cannot see resolves to the visible one, silently', async () => {
    const P = hex8()
    const mine = `${P}-0000-4000-8000-000000000001`
    await insert(mine, ws.id, 'Mine', owner.id)
    // the same prefix: another member's private page, a page of a workspace the owner is not in
    await insert(`${P}-0000-4000-8000-000000000002`, ws.id, 'Their diary', other.id, 'private')
    await insert(`${P}-0000-4000-8000-000000000003`, foreign.id, 'Foreign plan', outsider.id)
    for (const [tool, args] of [
      ['read_page', { pageId: P }],
      ['rename_page', { pageId: P, title: 'Mine (renamed)' }],
      ['list_comments', { pageId: P }],
      ['read_page', { pageId: `${P}-0000` }],
    ] as const) {
      const r = await mcp.tool(tool, args)
      assert.equal(r.isError, false, `${tool}: ${r.text}`)
      assert.doesNotMatch(r.text, /Their diary|Foreign plan|matches \d/, `${tool}: ${r.text}`)
    }
    assert.match((await mcp.tool('read_page', { pageId: P })).text, /^# Mine \(renamed\)/)
  })

  it('a prefix that only hidden pages have answers exactly like a prefix nobody has', async () => {
    const Q = hex8()
    const R = hex8()
    await insert(`${Q}-0000-4000-8000-000000000001`, ws.id, 'Hidden diary', other.id, 'private')
    await insert(`${Q}-0000-4000-8000-000000000002`, foreign.id, 'Foreign notes', outsider.id)
    for (const tool of ['read_page', 'trash_page', 'update_page', 'patch_section']) {
      const args = (p: string) =>
        tool === 'update_page' ? { pageId: p, mode: 'append', markdown: 'x' } : tool === 'patch_section' ? { pageId: p, section: 'x', mode: 'append', markdown: 'x' } : { pageId: p }
      const hidden = await mcp.tool(tool, args(Q))
      const none = await mcp.tool(tool, args(R))
      assert.equal(hidden.isError, true)
      assert.equal(hidden.text.replaceAll(Q, 'PREFIX'), none.text.replaceAll(R, 'PREFIX'), `${tool}: same bytes for hidden and missing`)
      assert.doesNotMatch(hidden.text, /Hidden diary|Foreign notes/)
    }
  })

  it('threads and trashed pages: a prefix of a hidden one answers like a prefix nobody has', async () => {
    const otherMcp = await h.connectMcp(app, other, await h.mintToken(other))
    const diary = JSON.parse((await otherMcp.tool('create_page', { workspaceId: ws.id, title: 'Other diary', markdown: 'private words', private: true })).text) as { id: string }
    const c = await otherMcp.tool('add_comment', { pageId: diary.id, text: 'note to self' })
    assert.equal(c.isError, false, c.text)
    const thread = (JSON.parse(c.text) as { threadId: string }).threadId
    const gone = JSON.parse((await otherMcp.tool('create_page', { workspaceId: ws.id, title: 'Other scratch', markdown: 'x', private: true })).text) as { id: string }
    assert.equal((await otherMcp.tool('trash_page', { pageId: gone.id })).isError, false)
    await otherMcp.close()
    const unused = async (taken: string) => {
      for (;;) {
        const p = hex8()
        if (p !== taken.slice(0, 8)) return p
      }
    }
    for (const [tool, args, hiddenId] of [
      ['reply_comment', (t: string) => ({ threadId: t, text: 'hi' }), thread],
      ['resolve_comment', (t: string) => ({ threadId: t }), thread],
      ['restore_page', (t: string) => ({ pageId: t }), gone.id],
    ] as const) {
      const hid = hiddenId.slice(0, 8)
      const none = await unused(hiddenId)
      const a = await mcp.tool(tool, args(hid))
      const b = await mcp.tool(tool, args(none))
      assert.equal(a.isError, true, `${tool}: ${a.text}`)
      assert.equal(a.text.replaceAll(hid, 'PREFIX'), b.text.replaceAll(none, 'PREFIX'), `${tool}: same bytes for hidden and missing`)
      assert.doesNotMatch(a.text, /Other diary|Other scratch|note to self/)
    }
  })

  it('ambiguity lists only visible pages', async () => {
    const P = hex8()
    await insert(`${P}-0000-4000-8000-000000000001`, ws.id, 'Twin one', owner.id)
    await insert(`${P}-0000-4000-8000-000000000002`, ws2.id, 'Twin two', owner.id)
    await insert(`${P}-0000-4000-8000-000000000003`, ws.id, 'Hidden twin', other.id, 'private')
    const r = await mcp.tool('move_page', { pageId: P, parentId: null })
    assert.equal(r.isError, true)
    assert.match(r.text, new RegExp(`"${P}" matches 2 pages: ${P}-0000-4000-8000-000000000001 "Twin one", ${P}-0000-4000-8000-000000000002 "Twin two"\\. Pass a longer prefix or the full id\\.`))
    assert.doesNotMatch(r.text, /Hidden twin/)
  })

  it('every tool takes short page, workspace and thread ids; patch_section too (contextTools.ts unchanged)', async () => {
    const parent = await create({ title: 'Short parent', markdown: '## Notes\n\nfirst' })
    const child = await create({ title: 'Short child', markdown: 'child body', parentId: parent.id.slice(0, 8) })
    assert.equal(child.parentId, parent.id)
    const p = await mcp.tool('patch_section', { pageId: parent.id.slice(0, 8), section: 'notes', mode: 'append', markdown: 'second' })
    assert.equal(p.isError, false, p.text)
    const pages = await mcp.tool('list_pages', { workspaceId: ws.id.slice(0, 8), parentId: parent.id.slice(0, 8) })
    assert.match(pages.text, new RegExp(`- Short child ${child.id.slice(0, 8)}`))
    const c = await mcp.tool('add_comment', { pageId: parent.id.slice(0, 8), section: 'notes', text: 'check this' })
    assert.equal(c.isError, false, c.text)
    const thread = (JSON.parse(c.text) as { threadId: string }).threadId
    const listed = await mcp.tool('list_comments', { pageId: parent.id.slice(0, 8) })
    assert.match(listed.text, new RegExp(`^t:${thread.slice(0, 8)} \\| §notes`, 'm'))
    assert.equal((await mcp.tool('reply_comment', { threadId: thread.slice(0, 8), text: 'done' })).isError, false)
    assert.equal((await mcp.tool('resolve_comment', { threadId: thread.slice(0, 8) })).isError, false)
    const instr = await mcp.tool('get_instructions', { workspaceId: ws.id.slice(0, 8), forPageId: child.id.slice(0, 8) })
    assert.equal(instr.isError, false, instr.text)
    // a trashed page by its prefix (list_trash prints it)
    assert.equal((await mcp.tool('trash_page', { pageId: child.id.slice(0, 8) })).isError, false)
    const back = await mcp.tool('restore_page', { pageId: child.id.slice(0, 8) })
    assert.equal(back.isError, false, back.text)
    // a workspace the owner is not in: not found, no name
    const wf = await mcp.tool('list_pages', { workspaceId: foreign.id.slice(0, 8) })
    assert.equal(wf.isError, true)
    assert.match(wf.text, /no workspace of yours has an id starting with/)
    // a malformed id says what is expected (the SDK's validation, before any lookup)
    const bad = await mcp.tool('rename_page', { pageId: 'not-an-id', title: 'x' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /expected a page id: the full id or its first 8\+ hex characters/)
  })

  // --- workspace inference (docs/adr/1943-*) ------------------------------------------------------

  it('workspaceId is inferred from a page or from the only workspace; with several the error lists them', async () => {
    const solo = await h.makeUser('Solo')
    const soloWs = await h.makeWorkspace(solo)
    const m = await h.connectMcp(app, solo, await h.mintToken(solo))
    const page = JSON.parse((await m.tool('create_page', { title: 'Solo page', markdown: 'hello' })).text) as { workspaceId: string }
    assert.equal(page.workspaceId, soloWs.id)
    for (const [tool, args] of [['list_pages', {}], ['get_instructions', {}], ['list_templates', {}], ['list_trash', {}]] as const) {
      const r = await m.tool(tool, args)
      assert.equal(r.isError, false, `${tool}: ${r.text}`)
    }
    assert.match((await m.tool('get_instructions', {})).text, new RegExp(`^No agent instructions in workspace ${soloWs.id.slice(0, 8)}\\.`))
    await m.close()
    // the owner has two workspaces: a page decides, otherwise the error names both
    const parent = await create({ title: 'Infer parent', markdown: 'x', workspaceId: ws2.id })
    const r = await mcp.tool('create_page', { title: 'Inferred', markdown: 'y', parentId: parent.id })
    assert.equal((JSON.parse(r.text) as { workspaceId: string }).workspaceId, ws2.id)
    const many = await mcp.tool('list_pages', {})
    assert.equal(many.isError, true)
    assert.match(many.text, /^Error: workspaceId is required: this connection has \d+ workspaces: /)
    assert.ok(many.text.includes(ws.id.slice(0, 8)) && many.text.includes(ws2.id.slice(0, 8)), many.text)
    assert.ok(!many.text.includes(foreign.id.slice(0, 8)))
  })

  // --- update_page replace precondition (docs/adr/1947-*) -----------------------------------------

  it('replace: a stale baseVersion writes nothing; without one a person-edited page is refused, an agent-written one is not', async () => {
    const pg = await create({ title: 'Replace target', markdown: 'agent text' })
    const read1 = await mcp.tool('read_page', { pageId: pg.id })
    const v1 = /^- version: (\S+)$/m.exec(read1.text)![1]
    // the agent wrote last: no baseVersion needed (0.15.0 flows keep working)
    const r0 = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: 'agent text two' })
    assert.equal(r0.isError, false, r0.text)
    // a person edits after the agent's read
    const edit = await as(owner, 'POST', `/pages/${pg.id}/content`, { markdown: 'person text', mode: 'append' })
    assert.equal(edit.statusCode, 200, edit.body)
    await drainChangeLog()
    const stale = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: 'overwrite', baseVersion: v1 })
    assert.equal(stale.isError, true)
    assert.match(stale.text, /the page changed since version \S+ \(PAGE_CONFLICT; .*Nothing was written\. read_page\(pageId\) again/)
    const noBase = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: 'overwrite' })
    assert.equal(noBase.isError, true)
    assert.match(noBase.text, /baseVersion is required to replace a page a person edited last \(Owner\)/)
    const body = (await mcp.tool('read_page', { pageId: pg.id })).text
    assert.match(body, /person text/)
    assert.doesNotMatch(body, /overwrite/)
    // with the version just read, it goes through; append never needs one
    const v2 = /^- version: (\S+)$/m.exec(body)![1]
    assert.ok(!stale.text.includes(v2) && !noBase.text.includes(v2), 'the errors do not hand out the current version')
    const ok = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: 'merged text', baseVersion: v2 })
    assert.equal(ok.isError, false, ok.text)
    assert.equal((await mcp.tool('update_page', { pageId: pg.id, mode: 'append', markdown: 'more' })).isError, false)
  })

  // --- outline, short anchors, known (docs/adr/1942-*) --------------------------------------------

  it('outline: anchors without repeated headings, known → one line, knownSections', async () => {
    const pg = await create({
      title: 'Outline page',
      markdown: '# Alpha\n\n## Decided\n\nnothing yet\n\n# Beta\n\n## Decided\n\nzorblat wins\n\n## Notes (draft, v2)\n\nsome notes',
    })
    const o = await mcp.tool('read_page', { pageId: pg.id, outline: true })
    assert.equal(o.isError, false, o.text)
    const ov = /, v=([0-9a-f]{12})\)\n/.exec(o.text)![1]
    assert.match(o.text, new RegExp(`^\\(page ${pg.id.slice(0, 8)}, doc, updated \\S+, ~\\d+ tok, v=${ov}\\)$`, 'm'))
    assert.match(o.text, /\n - §alpha\/decided ~\d+ tok v=[0-9a-f]{12}\n/)
    assert.match(o.text, /\n - §beta\/decided ~\d+ tok v=[0-9a-f]{12}\n/)
    assert.match(o.text, /\n - §beta\/notes-draft-v2 ~\d+ tok v=([0-9a-f]{12})$/)
    assert.doesNotMatch(o.text, /Notes \(draft, v2\)/, 'the heading text is not repeated next to its anchor')
    const same = await mcp.tool('read_page', { pageId: pg.id, outline: true, known: ov })
    assert.match(same.text, new RegExp(`^unchanged \\(page ${pg.id.slice(0, 8)} outline v=${ov}; can: [a-z,]+\\)$`))
    // knownSections keyed by the printed (short) anchors: only the changed section comes back
    const vs = Object.fromEntries([...o.text.matchAll(/§(\S+) ~\d+ tok v=([0-9a-f]{12})/g)].map((m) => [m[1], m[2]]))
    await mcp.tool('patch_section', { pageId: pg.id, section: 'beta/notes-draft-v2', mode: 'append', markdown: 'more notes' })
    const changed = await mcp.tool('read_page', { pageId: pg.id, knownSections: vs })
    assert.match(changed.text, /1 changed or new, 4 unchanged, 0 removed of your 5 known sections/)
    assert.match(changed.text, /more notes/)
    assert.doesNotMatch((await mcp.tool('read_page', { pageId: pg.id, outline: true, known: ov })).text, /^unchanged/)
    // why the outline prints full anchors: a second "Decided" above the first renames it to
    // beta/decided~2, and the short form "decided" would now name the new section
    const single = await create({ title: 'One decided', markdown: '# Alpha\n\n## Decided\n\nkeep me' })
    assert.match((await mcp.tool('read_page', { pageId: single.id, outline: true })).text, /\n - §alpha\/decided ~/)
    await mcp.tool('patch_section', { pageId: single.id, section: 'alpha', mode: 'insert_after', markdown: '# Beta\n\n## Decided\n\nnew one' })
    const viaFull = await mcp.tool('patch_section', { pageId: single.id, section: 'alpha/decided', mode: 'append', markdown: 'appended via the old full anchor' })
    assert.equal(viaFull.isError, false, viaFull.text)
    assert.match(viaFull.text, /beta\/decided~2/, 'the full anchor followed the moved section (ADR 1501)')
    const moved = (await mcp.tool('read_page', { pageId: single.id, section: 'beta/decided~2' })).text
    assert.match(moved, /keep me[^]*appended via the old full anchor/)
  })

  // --- read_page header, backlinks; create_page kinds (docs/adr/1946-*, 1948-*) -------------------

  it('read_page: ids once each (short; full only in the url), backlinks on request, visible sources only', async () => {
    const target = await create({ title: 'Link target', markdown: 'target body' })
    await create({ title: 'Linker A', markdown: 'see [[Link target]]' })
    const priv = await create({ title: 'Secret linker', markdown: 'also [[Link target]]', private: true }, await h.connectMcp(app, other, await h.mintToken(other)))
    void priv
    const r = await mcp.tool('read_page', { pageId: target.id, backlinks: true })
    assert.equal(r.isError, false, r.text)
    assert.equal(r.text.split(target.id).length - 1, 1, 'the full page id appears once (in the url)')
    assert.equal(r.text.split(ws.id).length - 1, 1, 'the full workspace id appears once (in the url)')
    assert.match(r.text, new RegExp(`\\n- id: ${target.id.slice(0, 8)}\\n`))
    assert.match(r.text, /<\/untrusted_content>\n\n- linked from \(1\): [0-9a-f]{8} "Linker A"$/)
    assert.doesNotMatch(r.text, /Secret linker/)
    const none = await mcp.tool('read_page', { pageId: target.id, outline: true, backlinks: true })
    assert.match(none.text, /\nlinked from \(1\): /)
    // the same bytes twice
    assert.equal((await mcp.tool('read_page', { pageId: target.id, backlinks: true })).text, r.text)
  })

  it('create_page kind canvas / folder; a folder takes no Markdown', async () => {
    const folder = await create({ title: 'A folder', kind: 'folder' })
    assert.equal(folder.kind, 'folder')
    const canvas = await create({ title: 'A canvas', kind: 'canvas', parentId: folder.id.slice(0, 8) })
    assert.equal(canvas.kind, 'canvas')
    assert.equal(canvas.parentId, folder.id)
    const bad = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Bad folder', kind: 'folder', markdown: '# no' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /a folder has no Markdown body/)
    const doc = await create({ title: 'Plain doc', markdown: 'x' })
    assert.equal(doc.kind, undefined, 'documents keep the 0.15.0 JSON shape')
    // markdown is optional: an empty document
    const empty = await create({ title: 'Empty doc' })
    assert.equal(empty.kind, undefined)
    const er = await mcp.tool('read_page', { pageId: empty.id })
    assert.equal(er.isError, false, er.text)
    assert.match(er.text, /^# Empty doc\n/)
  })
})
