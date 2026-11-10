// End to end through the MCP server: the agent notation for callouts, mentions and embeds
// (docs/adr/1500-*) and old section anchors after heading renames (docs/adr/1501-*).
// run-tests: db-exclusive (the backfill check re-indexes every stale page of the database)
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-notation-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent notation and moved section anchors', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { reindexPageChunks, backfillPageChunks } = await import('./chunkIndex')
  const { drainChangeLog } = await import('./changeLog')
  const { applyStoredState } = await import('../yState')
  const { stateToBlocks } = await import('../md/convert')
  const { liveDocState } = await import('../liveConnections')
  const collab = await import('../collab')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let other: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>
  let target: { id: string }

  before(async () => {
    owner = await h.makeUser('owner')
    other = await h.makeUser('other')
    ws = await h.makeWorkspace(owner, [other])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    target = await h.makeDocPage(ws.id, owner.id, 'Embedded target', [{ type: 'paragraph', content: 'target' }] as never)
  })

  async function index(pageId: string) {
    const [row] = await db.select({ s: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    await reindexPageChunks(pageId, stateToBlocks(row.s))
  }

  /** The document as stored (or open), as XML. */
  async function docXml(pageId: string): Promise<string> {
    const live = liveDocState(pageId)
    const state = live ?? (await db.select({ s: schema.pageDocs.state }).from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId)))[0].s
    const doc = new Y.Doc()
    applyStoredState(doc, state)
    return doc.getXmlFragment('document').toString()
  }
  const body = (text: string) => {
    const m = /<untrusted_content[^>]*>\n([^]*)\n<\/untrusted_content>/.exec(text)
    assert.ok(m, text)
    return m[1]
  }
  const version = (text: string, anchor: string) => {
    const m = new RegExp(`§${anchor.replace(/[/]/g, '\\/')}\\s[^\\n]*v=([0-9a-f]+)`).exec(text)
    assert.ok(m, `no version for ${anchor} in ${text}`)
    return m[1]
  }

  async function richPage(title: string) {
    const pg = await h.makeDocPage(ws.id, owner.id, title, [
      { type: 'heading', props: { level: 2 }, content: 'Notes' },
      { type: 'paragraph', content: 'Alpha paragraph.' },
      { type: 'callout', props: { type: 'warning' }, content: 'Careful with prod.' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Ask ', styles: {} },
          { type: 'mention', props: { kind: 'user', id: other.id, label: 'Other' } },
          { type: 'text', text: ' first.', styles: { underline: true } },
        ],
      },
      { type: 'pageEmbed', props: { pageId: target.id } },
      { type: 'heading', props: { level: 2 }, content: 'Tail' },
      { type: 'paragraph', props: { textColor: 'red' }, content: 'Red tail.' },
    ] as never)
    await index(pg.id)
    return pg
  }

  it('read_page shows callouts, mentions and embeds in the notation; patch_section keeps or removes them', async () => {
    const pg = await richPage('Notation page')
    const outline = await mcp.tool('read_page', { pageId: pg.id, outline: true })
    const sec = await mcp.tool('read_page', { pageId: pg.id, section: 'notes' })
    assert.equal(sec.isError, false, sec.text)
    const md = body(sec.text)
    assert.match(md, /^> \[!warning\] Careful with prod\.$/m)
    assert.match(md, new RegExp(`Ask @\\[Other\\]\\(user:${other.id}\\) first\\.`))
    assert.match(md, new RegExp(`^<!-- inkling:pageEmbed \\{"pageId":"${target.id}"\\} -->$`, 'm'))
    const full = await mcp.tool('read_page', { pageId: pg.id })
    assert.match(body(full.text), /> \[!warning\] Careful with prod\./)
    // find_context sees the callout text (CHUNKER_VERSION 4)
    const found = await mcp.tool('find_context', { query: 'careful prod', workspaceId: ws.id })
    assert.match(found.text, /Careful with prod/)

    // edit around everything: the nodes, their ids and the underline stay
    const before = await docXml(pg.id)
    const ids = (x: string) => [...x.matchAll(/<blockcontainer id="([^"]+)"><(callout|pageembed)/g)].map((m) => m[1])
    const edited = md.replace('Alpha paragraph.', 'Alpha paragraph, edited.').replace(/^## Notes\n\n/, '')
    const r = await mcp.tool('patch_section', { pageId: pg.id, section: 'notes', mode: 'replace', markdown: edited, baseVersion: version(outline.text, 'notes') })
    assert.equal(r.isError, false, r.text)
    const x = await docXml(pg.id)
    assert.match(x, /Alpha paragraph, edited\./)
    assert.match(x, /<callout type="warning">Careful with prod\.<\/callout>/)
    assert.match(x, new RegExp(`<mention id="${other.id}" kind="user" label="Other"></mention><underline> first.</underline>`))
    assert.deepEqual(ids(x), ids(before))
    assert.match(x, /<paragraph [^>]*textColor="red"[^>]*>Red tail\./)

    // deleting a token deletes the node; a mention of someone not in the page stays text
    const sec2 = await mcp.tool('read_page', { pageId: pg.id, section: 'notes' })
    const md2 = body(sec2.text)
      .replace(/^<!-- inkling:pageEmbed .* -->\n*/m, '')
      .replace(/^## Notes\n\n/, '')
      .concat(`\n\nAlso @[Owner](user:${owner.id}).`)
    const outline2 = await mcp.tool('read_page', { pageId: pg.id, outline: true })
    const r2 = await mcp.tool('patch_section', { pageId: pg.id, section: 'notes', mode: 'replace', markdown: md2, baseVersion: version(outline2.text, 'notes') })
    assert.equal(r2.isError, false, r2.text)
    const x2 = await docXml(pg.id)
    assert.doesNotMatch(x2, /<pageembed/)
    assert.match(x2, /<callout type="warning">/)
    assert.match(x2, /Also @Owner\./)
    assert.doesNotMatch(x2, new RegExp(`<mention id="${owner.id}"`))
  })

  it('update_page(replace) with the page as read changes nothing; tokens restore nodes', async () => {
    const pg = await richPage('Replace page')
    const before = await docXml(pg.id)
    const full = await mcp.tool('read_page', { pageId: pg.id })
    const md = body(full.text)
    // a replace names the version it read (docs/adr/1947-*): a person made this page
    const baseVersion = /^- version: (\S+)$/m.exec(full.text)![1]
    const r = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: md, baseVersion })
    assert.equal(r.isError, false, r.text)
    assert.equal(await docXml(pg.id), before, 'update_page with the page as read rewrote it')
    // an edit keeps the ids of untouched blocks, colors included
    const r2 = await mcp.tool('update_page', { pageId: pg.id, mode: 'replace', markdown: md.replace('Red tail.', 'Red tail, edited.'), baseVersion })
    assert.equal(r2.isError, false, r2.text)
    const x = await docXml(pg.id)
    assert.equal(x.replace('Red tail, edited.', 'Red tail.'), before)
  })

  it('backfill: version-3 indexes without the new nodes are kept, others re-indexed', async () => {
    const plain = await h.makeDocPage(ws.id, owner.id, 'Plain v3', [{ type: 'heading', props: { level: 2 }, content: 'P' }, { type: 'paragraph', content: 'plain text' }] as never)
    await index(plain.id)
    const rich = await richPage('Rich v3')
    for (const p of [plain, rich]) {
      await db.execute(sql`UPDATE page_chunk_index SET version = 3 WHERE page_id = ${p.id}`)
      // (the hash too: a re-index rewrites only rows whose hash differs)
      await db.execute(sql`UPDATE page_chunks SET text = 'TAMPERED', hash = 'tampered' WHERE page_id = ${p.id}`)
    }
    const logs: string[] = []
    await backfillPageChunks((m) => logs.push(m))
    const v = async (id: string) => (await db.execute(sql`SELECT version FROM page_chunk_index WHERE page_id = ${id}`)) as unknown as { version: number }[]
    const texts = async (id: string) => ((await db.execute(sql`SELECT text FROM page_chunks WHERE page_id = ${id} ORDER BY ord`)) as unknown as { text: string }[]).map((r) => r.text)
    assert.equal((await v(plain.id))[0].version, 4)
    assert.equal((await v(rich.id))[0].version, 4)
    assert.deepEqual(await texts(plain.id), ['TAMPERED'], 'promoted without a re-index')
    assert.ok((await texts(rich.id)).some((t) => t.includes('Careful with prod')), 're-indexed')
    assert.ok(logs.some((l) => /kept as version 4/.test(l)), logs.join('\n'))
  })

  it('an anchor from before a heading rename reads and patches the section under its new anchor', async () => {
    const created = await mcp.tool('create_page', {
      workspaceId: ws.id,
      title: 'Moves',
      markdown: '## Setup\n\nInstall it.\n\n## Backups\n\nNightly.\n\n## Other\n\nOther text.\n',
    })
    assert.equal(created.isError, false, created.text)
    const pageId = (JSON.parse(created.text) as { id: string }).id
    await drainChangeLog()
    const o1 = await mcp.tool('read_page', { pageId, outline: true })
    const oldV = version(o1.text, 'setup')
    // the agent (or a person) renames the heading
    const ren = await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'replace', markdown: '## Install guide\n\nInstall it.', baseVersion: oldV })
    assert.equal(ren.isError, false, ren.text)
    await drainChangeLog()

    const read = await mcp.tool('read_page', { pageId, section: 'setup' })
    assert.equal(read.isError, false, read.text)
    assert.match(read.text, /§install-guide v=/)
    assert.match(read.text, /^moved_to: §install-guide \(the heading was renamed; "setup" no longer exists\)$/m)
    assert.match(read.text, /Install it\./)

    const app1 = await mcp.tool('patch_section', { pageId, section: '§setup', mode: 'append', markdown: 'Then run it.' })
    assert.equal(app1.isError, false, app1.text)
    assert.match(app1.text, /^Done \(append\): §install-guide is now v=[0-9a-f]+\.\nmoved_to: §install-guide/m)

    // the version includes the heading: the old baseVersion is a conflict that names the new anchor
    const stale = await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'replace', markdown: 'X.', baseVersion: oldV })
    assert.equal(stale.isError, true)
    assert.match(stale.text, /Section "setup" was renamed to "install-guide"/)
    assert.match(stale.text, /Current §install-guide \(v=[0-9a-f]+\)/)
    assert.doesNotMatch(await docXml(pageId), />X\.</)

    // a new "Setup" section renamed again: the old anchor now means two sections
    const ins = await mcp.tool('patch_section', { pageId, section: 'other', mode: 'insert_after', markdown: '## Setup\n\nSecond setup.' })
    assert.equal(ins.isError, false, ins.text)
    await drainChangeLog()
    const o2 = await mcp.tool('read_page', { pageId, outline: true })
    const ren2 = await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'replace', markdown: '## Setup two\n\nSecond setup.', baseVersion: version(o2.text, 'setup') })
    assert.equal(ren2.isError, false, ren2.text)
    await drainChangeLog()
    const amb = await mcp.tool('read_page', { pageId, section: 'setup' })
    assert.equal(amb.isError, true)
    assert.match(amb.text, /Section "setup" was renamed and now matches several sections: install-guide, setup-two/)
    const ambPatch = await mcp.tool('patch_section', { pageId, section: 'setup', mode: 'append', markdown: 'Y.' })
    assert.equal(ambPatch.isError, true)
    assert.match(ambPatch.text, /several sections/)

    // never there at all: as before
    const miss = await mcp.tool('read_page', { pageId, section: 'nowhere' })
    assert.equal(miss.isError, true)
    assert.match(miss.text, /not found\. Available anchors:/)
  })
})
