// Columns through the agent tools (docs/adr/2422-*, 2424-*): read_page writes the column markers,
// create_page / update_page read them back into a group, outline and find_context do not take a
// heading inside a column for a section, and the zip export → import keeps the group. patch_section
// works next to a group and on the section that holds one (ADR 2424).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync } from 'node:fs'
import path from 'node:path'

process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-columns-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import type { AnyBlock } from './convert'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] columns through the agent tools', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  mkdirSync(path.join(process.env.DATA_DIR!, 'uploads'), { recursive: true })
  const h = await import('../mcpTools/testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { stateToBlocks } = await import('./convert')
  const JSZip = (await import('jszip')).default
  const app = await h.buildTestApp()
  const W = randomBytes(3).toString('hex')
  const owner = await h.makeUser('Cora')
  const ws = await h.makeWorkspace(owner, [], `Columns ${W}`)
  const m = await h.connectMcp(app, owner, await h.mintToken(owner, 'notes', 'Columnist'))
  after(async () => {
    await m.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await m.tool(name, args)
    assert.equal(r.isError, false, `${name}: ${r.text}`)
    return r.text
  }
  const stored = async (pageId: string): Promise<AnyBlock[]> => {
    // the live document is written through the collab store; read what it saved
    await collab.flushLiveDocuments([pageId])
    const [row] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return row ? stateToBlocks(row.state as Uint8Array) : []
  }
  const shape = (blocks: AnyBlock[]): unknown =>
    blocks.map((b) =>
      b.type === 'columnList'
        ? { columns: (b.children ?? []).map((c) => ({ width: Number(c.props?.width ?? 1), blocks: (c.children ?? []).map((x) => `${x.type}:${(Array.isArray(x.content) ? x.content : []).map((i) => (i as { text?: string }).text ?? '').join('')}`) })) }
        : `${b.type}:${(Array.isArray(b.content) ? b.content : []).map((i) => (i as { text?: string }).text ?? '').join('')}`,
    )

  const BODY = [
    '## Plan',
    '',
    'intro text',
    '',
    '<!-- inkling:columns {"widths":[60,40]} -->',
    '<!-- inkling:column -->',
    '### Inside left',
    '',
    'left body',
    '<!-- inkling:column -->',
    '- [ ] right task',
    '<!-- /inkling:columns -->',
    '',
    '## Later',
    '',
    'later body',
  ].join('\n')

  let pageId = ''

  it('create_page with the markers makes a group; read_page writes them back the same', async () => {
    pageId = (JSON.parse(await ok('create_page', { workspaceId: ws.id, title: 'Cols', markdown: BODY })) as { id: string }).id
    const blocks = await stored(pageId)
    assert.deepEqual(shape(blocks), [
      'heading:Plan',
      'paragraph:intro text',
      { columns: [{ width: 1.2, blocks: ['heading:Inside left', 'paragraph:left body'] }, { width: 0.8, blocks: ['checkListItem:right task'] }] },
      'heading:Later',
      'paragraph:later body',
    ])
    const read = await ok('read_page', { pageId })
    assert.match(read, /<!-- inkling:columns \{"widths":\[60,40\]\} -->\n\n<!-- inkling:column -->\n\n### Inside left\n\nleft body\n\n<!-- inkling:column -->\n\n[-*] \[ \] right task\n\n<!-- \/inkling:columns -->/)
  })

  it('outline and find_context: a heading inside a column is not a section', async () => {
    const outline = await ok('read_page', { pageId, outline: true })
    assert.match(outline, /§plan /)
    assert.match(outline, /§later /)
    assert.doesNotMatch(outline, /inside/i)
    const section = await ok('read_page', { pageId, section: 'plan' })
    assert.match(section, /<!-- inkling:column -->/)
    assert.match(section, /left body/)
    const found = await ok('find_context', { query: 'right task', workspaceId: ws.id })
    assert.match(found, /right task/)
  })

  it('update_page replace with the page as read keeps the group (edited text inside it)', async () => {
    const read = await ok('read_page', { pageId })
    const body = read.slice(read.indexOf('## Plan'))
    await ok('update_page', { pageId, mode: 'replace', markdown: body.replace('left body', 'left body edited') })
    const blocks = await stored(pageId)
    const group = blocks.find((b) => b.type === 'columnList')
    assert.ok(group, JSON.stringify(shape(blocks)))
    assert.match(JSON.stringify(group), /left body edited/)
    assert.deepEqual(group!.children!.map((c) => Number(c.props?.width)), [1.2, 0.8])
  })

  it('update_page append with markers adds a second group', async () => {
    await ok('update_page', { pageId, mode: 'append', markdown: '<!-- inkling:columns -->\n<!-- inkling:column -->\na\n<!-- inkling:column -->\nb\n<!-- inkling:column -->\nc\n<!-- /inkling:columns -->' })
    const blocks = await stored(pageId)
    const groups = blocks.filter((b) => b.type === 'columnList')
    assert.equal(groups.length, 2)
    assert.equal(groups[1].children!.length, 3)
  })

  it('patch_section: a section next to a group patches; the section holding one keeps its group', async () => {
    const v = (anchor: string) => async () => new RegExp(`§${anchor} [^\\n]*v=([0-9a-f]+)`).exec(await ok('read_page', { pageId, outline: true }))![1]
    // 'later' holds the group appended above: given back with its markers, the group stays
    const appended = '<!-- inkling:columns -->\n<!-- inkling:column -->\na\n<!-- inkling:column -->\nb\n<!-- inkling:column -->\nc\n<!-- /inkling:columns -->'
    await ok('patch_section', { pageId, section: 'later', markdown: `## Later\n\nlater body patched\n\n${appended}`, mode: 'replace', baseVersion: await v('later')() })
    let blocks = await stored(pageId)
    assert.match(JSON.stringify(blocks), /later body patched/)
    assert.equal(blocks.filter((b) => b.type === 'columnList').length, 2)
    assert.equal(blocks.filter((b) => b.type === 'columnList')[1].children!.length, 3)
    await ok('patch_section', { pageId, section: 'plan', markdown: '## Plan\n\nintro changed\n\n<!-- inkling:columns {"widths":[60,40]} -->\n<!-- inkling:column -->\nx\n<!-- inkling:column -->\ny\n<!-- /inkling:columns -->', mode: 'replace', baseVersion: await v('plan')() })
    blocks = await stored(pageId)
    assert.match(JSON.stringify(blocks), /intro changed/)
    const groups = blocks.filter((b) => b.type === 'columnList')
    assert.equal(groups.length, 2, 'the patched section has its new group, the appended one stays')
    assert.deepEqual(groups[0].children!.map((c) => Number(c.props?.width)), [1.2, 0.8])
    assert.match(JSON.stringify(groups[0]), /"x"/)
    assert.match(JSON.stringify(groups[0]), /"y"/)
  })

  it('broken markers from an agent keep every line and make no group', async () => {
    const id = (JSON.parse(await ok('create_page', { workspaceId: ws.id, title: 'Broken', markdown: 'one\n\n<!-- inkling:columns -->\n<!-- inkling:column -->\ntwo\n\nthree' })) as { id: string }).id
    const blocks = await stored(id)
    assert.deepEqual(shape(blocks), ['paragraph:one', 'paragraph:two', 'paragraph:three'])
  })

  it('split_page moves a section with a group to its subpage whole', async () => {
    const id = (JSON.parse(await ok('create_page', { workspaceId: ws.id, title: 'Splittable', markdown: BODY })) as { id: string }).id
    const out = await ok('split_page', { pageId: id, level: 2 })
    const sub = /([0-9a-f]{8}-[0-9a-f-]{27})[^\n]*Plan|Plan[^\n]*?([0-9a-f]{8}-[0-9a-f-]{27})/.exec(out)
    const pages = await db.select().from(schema.pages).where(eq(schema.pages.parentId, id))
    const plan = pages.find((p) => p.title === 'Plan')
    assert.ok(plan, `${out} ${JSON.stringify(sub)}`)
    const blocks = await stored(plan!.id)
    const group = blocks.find((b) => b.type === 'columnList')
    assert.ok(group, JSON.stringify(shape(blocks)))
    assert.deepEqual(group!.children!.map((c) => Number(c.props?.width)), [1.2, 0.8])
    assert.ok(!(await stored(id)).some((b) => b.type === 'columnList'), 'the group left the parent page')
  })

  it('zip export → import keeps the group and its widths', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/export`, headers: { cookie: owner.cookie } })
    assert.equal(res.statusCode, 200)
    const zip = await JSZip.loadAsync(res.rawPayload)
    const name = Object.keys(zip.files).find((f) => /Cols\.md$/.test(f))!
    const md = await zip.file(name)!.async('string')
    assert.match(md, /<!-- inkling:columns \{"widths":\[60,40\]\} -->/)
    const id = (JSON.parse(await ok('create_page', { workspaceId: ws.id, title: 'Back', markdown: md.replace(/^---[\s\S]*?---\n/, '') })) as { id: string }).id
    const blocks = await stored(id)
    const group = blocks.find((b) => b.type === 'columnList')!
    assert.deepEqual(group.children!.map((c) => Number(c.props?.width)), [1.2, 0.8])
  })
})
