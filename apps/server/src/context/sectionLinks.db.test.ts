// Section links `[[Page#Heading]]` end to end (docs/adr/2100-*–2103-*): written by an agent and by the
// editor (with a heading block id), read back unchanged through read_page and patch_section, listed
// with their heading in the backlinks, followed through heading renames (block id, then the change
// log), and reported by check_notes when the heading is gone. Also the web routes for the `[[Page#`
// autocomplete and for resolving a link.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-seclinks-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] section links [[Page#Heading]]', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { closeDb } = await import('../db/index')
  const { drainChangeLog } = await import('./changeLog')
  const { reindexPageChunks } = await import('./chunkIndex')
  const { reindexPageLinks } = await import('../md/linkIndex')
  const { reindexPageText } = await import('../md/textIndex')
  const { internalHref } = await import('@inkling/shared/sectionLink')
  const collab = await import('../collab')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let outsider: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  let guide: string
  let notes: string
  let editorPage: string
  let setupBlock: string

  const get = async (who: { cookie: string }, url: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: who.cookie } })
    return { status: res.statusCode, body: res.json() as Record<string, unknown> }
  }
  const idOf = (text: string) => (JSON.parse(text) as { id: string }).id
  const version = (outline: string, anchor: string) => {
    const m = new RegExp(`§${anchor}\\s[^\\n]*v=([0-9a-f]+)`).exec(outline)
    assert.ok(m, `no version for ${anchor} in ${outline}`)
    return m[1]
  }

  before(async () => {
    owner = await h.makeUser('owner')
    outsider = await h.makeUser('outsider')
    ws = await h.makeWorkspace(owner)
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    const g = await mcp.tool('create_page', {
      workspaceId: ws.id,
      title: 'Guide',
      markdown: '# Setup\n\nInstall it.\n\n# Usage\n\nRun it.\n\n# Limits\n\nNone.\n',
    })
    assert.equal(g.isError, false, g.text)
    guide = idOf(g.text)
    const n = await mcp.tool('create_page', {
      workspaceId: ws.id,
      title: 'Notes',
      markdown: '# Links\n\nStart at [[Guide#Usage]], see [[Guide#Limits|the limits]] and [[Guide#Nowhere]].\n',
    })
    assert.equal(n.isError, false, n.text)
    notes = idOf(n.text)
    await drainChangeLog()
  })

  it('headings route lists the sections for the [[Guide# autocomplete', async () => {
    const r = await get(owner, `/api/pages/${guide}/headings`)
    assert.equal(r.status, 200)
    const hs = r.body.headings as { blockId: string; text: string; level: number; anchor: string }[]
    assert.deepEqual(hs.map((x) => [x.text, x.level, x.anchor]), [['Setup', 1, 'setup'], ['Usage', 1, 'usage'], ['Limits', 1, 'limits']])
    setupBlock = hs[0].blockId
    assert.ok(setupBlock)
    // not a member: 404 like the outline
    assert.equal((await get(outsider, `/api/pages/${guide}/headings`)).status, 404)
  })

  it('read_page and patch_section give [[Page#Heading]] back as written', async () => {
    const read = await mcp.tool('read_page', { pageId: notes })
    assert.equal(read.isError, false, read.text)
    assert.match(read.text, /Start at \[\[Guide#Usage\]\], see \[\[Guide#Limits\|the limits\]\] and \[\[Guide#Nowhere\]\]\./)
    const outline = await mcp.tool('read_page', { pageId: notes, outline: true })
    const md = '# Links\n\nNow [[Guide#Setup]] first, then [[Guide#Usage|how to run]].\n'
    const w = await mcp.tool('patch_section', { pageId: notes, section: 'links', mode: 'replace', markdown: md, baseVersion: version(outline.text, 'links') })
    assert.equal(w.isError, false, w.text)
    const sec = await mcp.tool('read_page', { pageId: notes, section: 'links' })
    assert.match(sec.text, /Now \[\[Guide#Setup\]\] first, then \[\[Guide#Usage\|how to run\]\]\./)
    // find_context's section text carries the same notation
    await drainChangeLog()
    const found = await mcp.tool('find_context', { query: 'first then', workspaceId: ws.id })
    assert.match(found.text, /\[\[Guide#Setup\]\]/)
  })

  it('a link made in the editor (heading block id) follows a heading rename; backlinks show the heading as it is now', async () => {
    const href = internalHref(ws.id, guide, { heading: 'Setup', blockId: setupBlock, page: 'Guide' })
    const blocks = [
      { type: 'paragraph', content: [{ type: 'text', text: 'From the editor: ', styles: {} }, { type: 'link', href, content: [{ type: 'text', text: 'Guide#Setup', styles: {} }] }] },
    ]
    const pg = await h.makeDocPage(ws.id, owner.id, 'Editor page', blocks as never)
    editorPage = pg.id
    await reindexPageChunks(pg.id, blocks as never)
    await reindexPageText(pg.id, blocks as never)
    await reindexPageLinks(pg.id, blocks as never)

    // rename Setup → Install guide and Usage → Running (the Markdown links know no block id)
    const o = await mcp.tool('read_page', { pageId: guide, outline: true })
    const r1 = await mcp.tool('patch_section', { pageId: guide, section: 'setup', mode: 'replace', markdown: '# Install guide\n\nInstall it.', baseVersion: version(o.text, 'setup') })
    assert.equal(r1.isError, false, r1.text)
    await drainChangeLog()
    const o2 = await mcp.tool('read_page', { pageId: guide, outline: true })
    const r2 = await mcp.tool('patch_section', { pageId: guide, section: 'usage', mode: 'replace', markdown: '# Running\n\nRun it.', baseVersion: version(o2.text, 'usage') })
    assert.equal(r2.isError, false, r2.text)
    await drainChangeLog()

    const bl = await get(owner, `/api/pages/${guide}/backlinks`)
    assert.equal(bl.status, 200)
    const ids = (bl.body.pages as { id: string }[]).map((p) => p.id).sort()
    assert.deepEqual(ids, [editorPage, notes].sort())
    const sections = bl.body.sections as Record<string, { heading: string; status: string }[]>
    // block id: the editor's link follows the rename
    assert.deepEqual(sections[editorPage], [{ heading: 'Install guide', status: 'renamed' }])
    // by name, then the change log: [[Guide#Setup]] (patched in above, no block id) and [[Guide#Usage|…]]
    assert.deepEqual(
      [...sections[notes]].sort((a, b) => a.heading.localeCompare(b.heading)),
      [
        { heading: 'Install guide', status: 'renamed' },
        { heading: 'Running', status: 'renamed' },
      ],
    )
  })

  it('section-link route resolves by block id, name, change log, or says missing', async () => {
    const q = (s: string) => get(owner, `/api/pages/${guide}/section-link?${s}`)
    const byId = await q(`heading=Setup&block=${setupBlock}`)
    assert.equal(byId.body.status, 'renamed')
    assert.equal(byId.body.heading, 'Install guide')
    assert.equal(byId.body.blockId, setupBlock)
    assert.equal((await q('heading=Limits')).body.status, 'found')
    const traced = await q('heading=Usage')
    assert.equal(traced.body.status, 'renamed')
    assert.equal(traced.body.heading, 'Running')
    assert.equal((await q('heading=Nowhere')).body.status, 'missing')
    assert.equal((await q('heading=')).status, 400)
    assert.equal((await get(outsider, `/api/pages/${guide}/section-link?heading=Limits`)).status, 404)
  })

  it('check_notes reports a section link whose heading is gone, not the renamed ones', async () => {
    // Notes links Setup (renamed), Usage (renamed); write the missing one back in
    const o = await mcp.tool('read_page', { pageId: notes, outline: true })
    const w = await mcp.tool('patch_section', { pageId: notes, section: 'links', mode: 'append', markdown: 'And [[Guide#Nowhere]].', baseVersion: version(o.text, 'links') })
    assert.equal(w.isError, false, w.text)
    // the link index of a write may land just after the response: wait for the backlinks to show it
    let missing: { heading: string; status: string }[] = []
    for (let i = 0; i < 40 && !missing.length; i++) {
      const bl = await get(owner, `/api/pages/${guide}/backlinks`)
      missing = ((bl.body.sections as Record<string, { heading: string; status: string }[]>)[notes] ?? []).filter((x) => x.status === 'missing')
      if (!missing.length) await new Promise((r) => setTimeout(r, 50))
    }
    assert.deepEqual(missing, [{ heading: 'Nowhere', status: 'missing' }])
    const r = await mcp.tool('check_notes', { workspaceId: ws.id })
    assert.equal(r.isError, false, r.text)
    assert.match(r.text, new RegExp(`\\[\\[Guide#Nowhere\\]\\] heading not found in page ${guide.slice(0, 8)}`))
    assert.doesNotMatch(r.text, /Guide#Setup\]\] heading not found|Guide#Usage\]\] heading not found/)
    const dto = await get(owner, `/api/workspaces/${ws.id}/notes-check`)
    const items = (dto.body.broken as { items: { pageId: string; links: { state: string; text: string }[] }[] }).items
    const mine = items.find((i) => i.pageId === notes)
    assert.ok(mine)
    assert.deepEqual(mine.links.filter((l) => l.state === 'noHeading').map((l) => l.text), ['Guide#Nowhere'])
  })

  it('an agent that writes a section back unchanged keeps the editor link (and its block id)', async () => {
    const before = await get(owner, `/api/pages/${guide}/backlinks`)
    assert.deepEqual((before.body.sections as Record<string, unknown[]>)[editorPage], [{ heading: 'Install guide', status: 'renamed' }])
    const read = await mcp.tool('read_page', { pageId: editorPage })
    assert.match(read.text, /From the editor: \[\[Guide#Setup\]\]/)
    const o = await mcp.tool('read_page', { pageId: editorPage, outline: true })
    const intro = /§(_intro)\s[^\n]*v=([0-9a-f]+)/.exec(o.text)
    assert.ok(intro, o.text)
    const w = await mcp.tool('patch_section', {
      pageId: editorPage,
      section: '_intro',
      mode: 'replace',
      markdown: 'From the editor: [[Guide#Setup]]\n\nA new line from the agent.',
      baseVersion: intro[2],
    })
    assert.equal(w.isError, false, w.text)
    // the unchanged paragraph is kept as it was: the link still has its block id and follows the rename
    let ok = false
    for (let i = 0; i < 40 && !ok; i++) {
      const bl = await get(owner, `/api/pages/${guide}/backlinks`)
      const s = (bl.body.sections as Record<string, { heading: string; status: string }[]>)[editorPage]
      ok = JSON.stringify(s) === JSON.stringify([{ heading: 'Install guide', status: 'renamed' }])
      if (!ok) await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(ok)
  })

  it('an H2 under an H1 is found by its own name, and followed through a rename by the change log', async () => {
    const rb = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Runbook', markdown: '# Ops\n\nIntro.\n\n## Deploy\n\nShip it.\n' })
    assert.equal(rb.isError, false, rb.text)
    const runbook = idOf(rb.text)
    await drainChangeLog()
    const q = (s: string) => get(owner, `/api/pages/${runbook}/section-link?${s}`)
    assert.deepEqual([(await q('heading=Deploy')).body.status, (await q('heading=Deploy')).body.anchor], ['found', 'ops/deploy'])
    const o = await mcp.tool('read_page', { pageId: runbook, outline: true })
    const r = await mcp.tool('patch_section', { pageId: runbook, section: 'ops/deploy', mode: 'replace', markdown: '## Shipping\n\nShip it.', baseVersion: version(o.text, 'ops/deploy') })
    assert.equal(r.isError, false, r.text)
    await drainChangeLog()
    const moved = await q('heading=Deploy')
    assert.equal(moved.body.status, 'renamed')
    assert.equal(moved.body.heading, 'Shipping')
    assert.equal(moved.body.anchor, 'ops/shipping')
  })

  it('a page link and a section link to the same page are one backlink row and one graph edge', async () => {
    const o = await mcp.tool('read_page', { pageId: notes, outline: true })
    const w = await mcp.tool('patch_section', { pageId: notes, section: 'links', mode: 'append', markdown: 'Whole page: [[Guide]].', baseVersion: version(o.text, 'links') })
    assert.equal(w.isError, false, w.text)
    const bl = await get(owner, `/api/pages/${guide}/backlinks`)
    assert.equal((bl.body.pages as { id: string }[]).filter((p) => p.id === notes).length, 1)
  })
})
