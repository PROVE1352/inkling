// Splitting a page into subpages and automatic splitting of growing logs (docs/adr/1140-*, 1141-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-split-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

const t = (text: string) => [{ type: 'text', text, styles: {} }]

/** Intro, an h1 group with three h2 runs (one with nested children), a second h1 with one run. */
function logBlocks(): Record<string, unknown>[] {
  return [
    { type: 'paragraph', content: t('Log intro') },
    { type: 'heading', props: { level: 1 }, content: t('October') },
    { type: 'paragraph', content: t('october notes') },
    { type: 'heading', props: { level: 2 }, content: t('Run 1') },
    { type: 'paragraph', content: t('run one body'), children: [{ type: 'paragraph', content: t('nested under run one') }] },
    { type: 'heading', props: { level: 3 }, content: t('Run 1 detail') },
    { type: 'paragraph', content: t('detail body') },
    { type: 'heading', props: { level: 2 }, content: t('Run 2') },
    { type: 'table', content: { type: 'tableContent', rows: [{ cells: [t('loss'), t('0.12')] }] } },
    { type: 'heading', props: { level: 2 }, content: t('Run 3') },
    { type: 'paragraph', content: t('run three body') },
    { type: 'heading', props: { level: 1 }, content: t('November') },
    { type: 'heading', props: { level: 2 }, content: t('Run 4') },
    { type: 'paragraph', content: t('run four body') },
  ]
}

describe('[db] split page and rotation', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('../mcpTools/testHarness')
  const { db, closeDb } = await import('../db/index')
  const { sql } = await import('drizzle-orm')
  const collab = await import('../collab')
  const { docFromStoredState } = await import('../yState')
  const { getServerEditor } = await import('../md/editor')
  const { splitTestHooks, monthKey, flushSplitIndexing } = await import('./splitPage')
  const { flushDocIndexes } = await import('../docIndexer')
  const app = await h.buildTestApp()

  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  let owner: Awaited<ReturnType<typeof h.makeUser>>
  let member: Awaited<ReturnType<typeof h.makeUser>>
  let ws: { id: string }
  let mcp: Awaited<ReturnType<typeof h.connectMcp>>

  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.tool(name, args)
    assert.equal(r.isError, false, r.text)
    return r.text
  }
  const req = (user: { cookie: string }, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: user.cookie }, ...(payload === undefined ? {} : { payload: payload as object }) })

  async function blocksOf(pageId: string): Promise<Record<string, unknown>[]> {
    const [row] = (await db.execute(sql`SELECT state FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { state: Uint8Array }[]
    if (!row) return []
    return getServerEditor().yDocToBlocks(docFromStoredState(row.state), 'document') as unknown as Record<string, unknown>[]
  }
  const text = (b: Record<string, unknown>) => ((b.content as { text?: string; content?: { text: string }[] }[]) ?? []).map((c) => c.text ?? (c.content ?? []).map((x) => x.text).join('')).join('')

  async function makeLog(title = 'Lab log') {
    const p = await h.makeDocPage(ws.id, owner.id, title, logBlocks() as never)
    return p
  }

  before(async () => {
    owner = await h.makeUser('owner')
    member = await h.makeUser('member')
    ws = await h.makeWorkspace(owner, [member])
    mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
  })

  it('preview lists the sections of a level and changes nothing', async () => {
    const p = await makeLog()
    const before = await blocksOf(p.id)
    const r = await req(owner, 'POST', `/pages/${p.id}/split`, { level: 2, preview: true })
    assert.equal(r.statusCode, 200, r.body)
    const plan = r.json() as { sections: { title: string; blocks: number; anchor: string }[]; levels: number[]; preview: boolean }
    assert.equal(plan.preview, true)
    assert.deepEqual(plan.sections.map((s) => [s.title, s.blocks]), [['Run 1', 4], ['Run 2', 2], ['Run 3', 2], ['Run 4', 2]])
    assert.deepEqual(plan.levels.slice(0, 3), [2, 4, 1])
    assert.equal(plan.sections[0].anchor, 'october/run-1')
    assert.deepEqual(await blocksOf(p.id), before)
    const kids = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE parent_id = ${p.id}`)) as unknown as { n: number }[]
    assert.equal(kids[0].n, 0)
  })

  it('split moves sections with their block ids and comments, leaves links, keeps backlinks working', async () => {
    const p = await makeLog()
    const before = await blocksOf(p.id)
    const run1 = before.find((b) => text(b) === 'Run 1')!
    const nested = (before[4].children as Record<string, unknown>[])[0]
    // A page that links to the log, and comments on a moved (nested) block and on a kept block.
    const linker = await tool('create_page', { workspaceId: ws.id, title: 'Index', markdown: 'see [[Lab log]]' })
    const linkerId = (JSON.parse(linker) as { id: string }).id
    const c1 = await req(member, 'POST', `/pages/${p.id}/comments`, { blockId: nested.id, body: 'about the nested block' })
    assert.equal(c1.statusCode, 200, c1.body)
    const c2 = await req(member, 'POST', `/pages/${p.id}/comments`, { blockId: before[0].id, body: 'about the intro' })
    assert.equal(c2.statusCode, 200, c2.body)

    const out = await tool('split_page', { pageId: p.id, level: 2 })
    assert.match(out, /created 4 subpage\(s\)/)
    assert.match(out, /- "Run 1" id=[0-9a-f-]{36} \(was section=october\/run-1, heading=/)
    assert.match(out, /1 comment thread\(s\) moved/)

    const kids = (await db.execute(sql`
      SELECT id, title, scope FROM pages WHERE parent_id = ${p.id} AND deleted_at IS NULL ORDER BY sort_order
    `)) as unknown as { id: string; title: string }[]
    assert.deepEqual(kids.map((k) => k.title), ['Run 1', 'Run 2', 'Run 3', 'Run 4'])

    // Subpage 1: the heading keeps its id; nested children and the h3 came along.
    const k1 = await blocksOf(kids[0].id)
    assert.equal(k1[0].id, run1.id)
    assert.deepEqual(k1.map(text), ['Run 1', 'run one body', 'Run 1 detail', 'detail body'])
    assert.equal(((k1[1].children as Record<string, unknown>[])[0]).id, nested.id)
    assert.equal((await blocksOf(kids[1].id))[1].type, 'table')

    // The page keeps intro + h1 headings + one link per section, in place.
    const rest = await blocksOf(p.id)
    assert.deepEqual(rest.map((b) => [b.type, text(b)]), [
      ['paragraph', 'Log intro'],
      ['heading', 'October'],
      ['paragraph', 'october notes'],
      ['bulletListItem', 'Run 1'],
      ['bulletListItem', 'Run 2'],
      ['bulletListItem', 'Run 3'],
      ['heading', 'November'],
      ['bulletListItem', 'Run 4'],
    ])
    assert.equal(rest[0].id, before[0].id, 'kept blocks keep their ids')
    const link = (rest[3].content as { type: string; href: string }[])[0]
    assert.equal(link.href, `/w/${ws.id}/p/${kids[0].id}`)

    // Comments: the one in Run 1 moved, the one on the intro stayed.
    const cm = (await db.execute(sql`SELECT page_id AS "pageId", body FROM comments WHERE thread_id = id AND page_id IN (${p.id}, ${kids[0].id})`)) as unknown as { pageId: string; body: string }[]
    assert.deepEqual(cm.map((c) => [c.pageId === kids[0].id ? 'child' : 'page', c.body]).sort(), [['child', 'about the nested block'], ['page', 'about the intro']])
    const listed = await req(owner, 'GET', `/pages/${kids[0].id}/comments`)
    assert.equal((listed.json() as { comments: unknown[] }).comments.length, 1)

    // Indexes: the subpages are indexed, the page links to each of them, links to the page still resolve.
    await flushSplitIndexing()
    await flushDocIndexes()
    const bl = await req(owner, 'GET', `/pages/${kids[0].id}/backlinks`)
    assert.ok((bl.json() as { pages: { id: string }[] }).pages.some((x) => x.id === p.id))
    const bl2 = await req(owner, 'GET', `/pages/${p.id}/backlinks`)
    assert.ok((bl2.json() as { pages: { id: string }[] }).pages.some((x) => x.id === linkerId))
    const chunks = (await db.execute(sql`SELECT count(*)::int AS n FROM page_chunks WHERE page_id = ${kids[3].id}`)) as unknown as { n: number }[]
    assert.ok(chunks[0].n > 0)
    const read = await tool('read_page', { pageId: kids[2].id })
    assert.match(read, /run three body/)

    // Version history has the page as it was before the split.
    const snaps = (await db.execute(sql`SELECT label FROM page_snapshots WHERE page_id = ${p.id}`)) as unknown as { label: string }[]
    assert.ok(snaps.some((s) => s.label === 'Before split'))

    // [[Page#Heading]] written later resolves to the subpage made from that section; without such a
    // subpage it is a section link to the page (0.17, docs/adr/2100-*).
    const later = await tool('create_page', { workspaceId: ws.id, title: 'Later', markdown: 'see [[Lab log#Run 2]] and [[Lab log#Nope]]' })
    const laterBlocks = await blocksOf((JSON.parse(later) as { id: string }).id)
    const hrefs = (laterBlocks[0].content as { type: string; href?: string }[]).filter((c) => c.type === 'link').map((c) => c.href)
    assert.deepEqual(hrefs, [`/w/${ws.id}/p/${kids[1].id}`, `/w/${ws.id}/p/${p.id}#h=Nope&p=Lab%20log`])
  })

  it('split of a page open in an editor reaches the live document; an edit inside a moved section in between aborts it', async () => {
    const p = await makeLog()
    // Someone has the page open (a direct connection holds the live document).
    const other = await collab.hocuspocus.openDirectConnection(p.id)
    try {
      // 1) a concurrent edit inside a moved section between commit and removal → 409, nothing changed
      splitTestHooks.afterCommit = () => {
        const doc = other.document!
        const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
        const run2 = group.get(7) as Y.XmlElement
        const textNode = (run2.get(0) as Y.XmlElement).get(0) as Y.XmlText
        doc.transact(() => textNode.insert(textNode.length, ' (edited)'))
      }
      const r = await req(owner, 'POST', `/pages/${p.id}/split`, { level: 2 })
      assert.equal(r.statusCode, 409, r.body)
      assert.equal((r.json() as { error: { code: string } }).error.code, 'SPLIT_CONFLICT')
      const kids0 = (await db.execute(sql`SELECT count(*)::int AS n FROM pages WHERE parent_id = ${p.id}`)) as unknown as { n: number }[]
      assert.equal(kids0[0].n, 0, 'subpages were removed again')
      splitTestHooks.afterCommit = undefined

      // 2) an edit elsewhere (intro) does not block it; the live document loses the sections at once
      splitTestHooks.afterCommit = () => {
        const doc = other.document!
        const group = doc.getXmlFragment('document').get(0) as Y.XmlElement
        const intro = (group.get(0) as Y.XmlElement).get(0) as Y.XmlElement
        const tn = intro.get(0) as Y.XmlText
        doc.transact(() => tn.insert(tn.length, ' typed meanwhile'))
      }
      const ok = await req(owner, 'POST', `/pages/${p.id}/split`, { level: 2 })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal((ok.json() as { openBy: number }).openBy, 0, 'server connections are not people')
      const group = other.document!.getXmlFragment('document').get(0) as Y.XmlElement
      assert.equal(group.length, 8)
      assert.equal(((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0)!.toString(), 'Log intro typed meanwhile')
    } finally {
      splitTestHooks.afterCommit = undefined
      await other.disconnect()
    }
  })

  it('split respects the edit lock and only takes document pages', async () => {
    const p = await makeLog('Locked log')
    const lock = await req(owner, 'PUT', `/pages/${p.id}/lock`, { locked: true })
    assert.equal(lock.statusCode, 200, lock.body)
    const r = await req(member, 'POST', `/pages/${p.id}/split`, { level: 2 })
    assert.equal(r.statusCode, 403, r.body)
    assert.equal((r.json() as { error: { code: string } }).error.code, 'PAGE_LOCKED')
    const rot = await req(member, 'PUT', `/pages/${p.id}/rotation`, { mode: 'month' })
    assert.equal(rot.statusCode, 403)
    const plain = await tool('create_page', { workspaceId: ws.id, title: 'Plain', markdown: 'no headings here' })
    const none = await req(owner, 'POST', `/pages/${(JSON.parse(plain) as { id: string }).id}/split`, { level: 2 })
    assert.equal(none.statusCode, 400)
    const fold = await req(owner, 'POST', '/pages', { workspaceId: ws.id, kind: 'folder', title: 'Folder' })
    const notDoc = await req(owner, 'POST', `/pages/${(fold.json() as { page: { id: string } }).page.id}/split`, { level: 2 })
    assert.equal(notDoc.statusCode, 400)
  })

  it('a monthly log takes update_page appends in the current month subpage and says so', async () => {
    const p = await makeLog('Monthly log')
    const set = await req(owner, 'PUT', `/pages/${p.id}/rotation`, { mode: 'month' })
    assert.equal(set.statusCode, 200, set.body)
    const a = await tool('update_page', { pageId: p.id, mode: 'append', markdown: 'entry one' })
    const key = monthKey()
    assert.match(a, new RegExp(`Appended to the end of subpage "${key}" \\(pageId=[0-9a-f-]{36}\\), not to the page you addressed: that page splits itself by month`))
    assert.match(a, /created by this call/)
    const b = await tool('update_page', { pageId: p.id, mode: 'append', markdown: 'entry two' })
    assert.doesNotMatch(b, /created by this call/)
    const kids = (await db.execute(sql`SELECT id, title FROM pages WHERE parent_id = ${p.id}`)) as unknown as { id: string; title: string }[]
    assert.deepEqual(kids.map((k) => k.title), [key])
    assert.deepEqual((await blocksOf(kids[0].id)).map(text), ['entry one', 'entry two'])
    const got = (await req(owner, 'GET', `/pages/${p.id}/rotation`)).json() as { mode: string; current: { id: string } }
    assert.equal(got.mode, 'month')
    assert.equal(got.current.id, kids[0].id)
    // replace still writes the page itself
    const rep = await tool('update_page', { pageId: kids[0].id, mode: 'replace', markdown: 'replaced' })
    assert.match(rep, /Replaced the body/)
  })

  it('a size-rotating log starts a new subpage once the current one is past its size', async () => {
    const p = await makeLog('Sized log')
    const set = await req(owner, 'PUT', `/pages/${p.id}/rotation`, { mode: 'size', maxBytes: 64 * 1024 })
    assert.equal(set.statusCode, 200, set.body)
    // The page itself is small: appends stay on it.
    const a = await tool('update_page', { pageId: p.id, mode: 'append', markdown: 'small entry' })
    assert.match(a, /^Appended to the end of the body\./)
    // Grow it past 64 KB, then the next append goes to a new dated subpage.
    await tool('update_page', { pageId: p.id, mode: 'append', markdown: `big ${'x'.repeat(90_000)}` })
    const c = await tool('update_page', { pageId: p.id, mode: 'append', markdown: 'after the cut' })
    assert.match(c, /that page splits itself by size/)
    const kids = (await db.execute(sql`SELECT id, title FROM pages WHERE parent_id = ${p.id}`)) as unknown as { id: string; title: string }[]
    assert.equal(kids.length, 1)
    assert.match(kids[0].title, /^\d{4}-\d{2}-\d{2}$/)
    const d = await tool('update_page', { pageId: p.id, mode: 'append', markdown: 'next' })
    assert.match(d, new RegExp(`pageId=${kids[0].id}`))
  })

  it('appending to a large page tells its owner once', async () => {
    const md = ['# Big', '']
    for (let i = 0; i < 120; i++) md.push(`## Entry ${i}`, '', `${'word loss val epoch baseline '.repeat(90)}`, '')
    const created = await tool('create_page', { workspaceId: ws.id, title: 'Huge log', markdown: md.join('\n') })
    const id = (JSON.parse(created) as { id: string }).id
    await flushDocIndexes()
    const memberMcp = await h.connectMcp(app, member, await h.mintToken(member))
    for (let i = 0; i < 3; i++) {
      const r = await memberMcp.tool('update_page', { pageId: id, mode: 'append', markdown: `more ${i}` })
      assert.equal(r.isError, false, r.text)
    }
    const n = (await db.execute(sql`
      SELECT user_id AS "userId", actor_id AS "actorId" FROM notifications WHERE page_id = ${id} AND type = 'large_page'
    `)) as unknown as { userId: string; actorId: string }[]
    assert.deepEqual([...n], [{ userId: owner.id, actorId: member.id }])
    const list = await req(owner, 'GET', '/notifications')
    assert.ok((list.json() as { notifications: { type: string; pageId: string }[] }).notifications.some((x) => x.type === 'large_page' && x.pageId === id))
  })
})
