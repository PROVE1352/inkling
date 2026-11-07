// [db] Database row templates (docs/adr/1180-1184): CRUD and permissions, the one create path
// (defaults, explicit values, relative dates, 'me', inputs, body variables), exclusion from search
// and the template gallery, copies (duplicate, structure templates, template files) and MCP.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-rowtpl-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import * as Y from 'yjs'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] row templates', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const { stateToBlocks, blocksToStateBuffer, markdownToBlocks } = await import('./md/convert')
  const JSZip = (await import('jszip')).default

  const app = await h.buildTestApp()
  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })

  let A: U // owner
  let B: U // member
  let wsId: string
  let C: string // collection
  const FIELDS = [
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'o-todo', name: 'Todo', color: 'gray' }, { id: 'o-done', name: 'Done', color: 'green' }] },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'owner', name: 'Owner', type: 'person' },
    { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'flag', name: 'Flag', type: 'checkbox' },
  ]

  /** Base64 Yjs update of a body written in Markdown. */
  async function body(md: string): Promise<string> {
    return blocksToStateBuffer(await markdownToBlocks(md, () => null)).toString('base64')
  }
  async function docText(pageId: string): Promise<string> {
    const [d] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, pageId))
    return d ? JSON.stringify(stateToBlocks(d.state)) : ''
  }
  async function makeCollection(u: U, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await req(u, 'POST', '/pages', { workspaceId: wsId, kind: 'collection', title, ...extra })
    assert.equal(r.statusCode, 200, r.body)
    const id = r.json().page.id as string
    assert.equal((await req(u, 'PUT', `/pages/${id}/collection/fields`, { fields: FIELDS })).statusCode, 200)
    return id
  }
  const today = (tz: string, plus = 0) => {
    const d = new Date(Date.now() + plus * 86_400_000)
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  }

  before(async () => {
    A = await h.makeUser('Ada')
    B = await h.makeUser('Bob')
    wsId = (await h.makeWorkspace(A, [B], 'Acme')).id
    C = await makeCollection(A, 'Meetings')
  })

  let T1: string // default template
  let T2: string

  it('creates, lists and edits templates; one default at a time', async () => {
    const r1 = await req(A, 'POST', `/pages/${C}/collection/row-templates`, {
      name: 'Meeting',
      icon: '📋',
      title: '{{date}} {{input:Topic|Weekly}} meeting',
      props: { status: 'o-todo', due: 'today+7', owner: 'me', notes: 'by {{author}}', flag: true, ghost: 'x', bogus: null },
      isDefault: true,
    })
    assert.equal(r1.statusCode, 200, r1.body)
    const t1 = r1.json().template
    T1 = t1.id
    assert.equal(t1.isDefault, true)
    assert.deepEqual(t1.props, { status: 'o-todo', due: 'today+7', owner: 'me', notes: 'by {{author}}', flag: true })
    assert.deepEqual(t1.inputs, [{ name: 'Topic', default: 'Weekly' }])

    // body: merged updates from two editors both survive
    const docA = new Y.Doc()
    Y.applyUpdate(docA, Buffer.from(await body('# Agenda\n\nNotes for {{title}} zebraquokka\n\n```\n{{date}} stays\n```'), 'base64'))
    const upA = Buffer.from(Y.encodeStateAsUpdate(docA)).toString('base64')
    assert.equal((await req(A, 'PATCH', `/collection-row-templates/${T1}`, { update: upA })).statusCode, 200)
    const docB = new Y.Doc()
    Y.applyUpdate(docB, Buffer.from((await req(B, 'GET', `/collection-row-templates/${T1}`)).json().state, 'base64'))
    const sv = Y.encodeStateVector(docB)
    docB.getXmlFragment('document').insert(0, [new Y.XmlText('ignored-shape')])
    const upB = Buffer.from(Y.encodeStateAsUpdate(docB, sv)).toString('base64')
    assert.equal((await req(B, 'PATCH', `/collection-row-templates/${T1}`, { update: upB })).statusCode, 200)
    const merged = new Y.Doc()
    Y.applyUpdate(merged, Buffer.from((await req(A, 'GET', `/collection-row-templates/${T1}`)).json().state, 'base64'))
    const xml = merged.getXmlFragment('document').toString()
    assert.match(xml, /zebraquokka/)
    assert.match(xml, /ignored-shape/)
    // repair the body for the rest of the suite (the bare text node is not a block)
    await db.update(schema.collectionRowTemplates).set({ state: Buffer.from(upA, 'base64') }).where(eq(schema.collectionRowTemplates.id, T1))

    const bad = await req(A, 'PATCH', `/collection-row-templates/${T1}`, { update: Buffer.from('not yjs').toString('base64') })
    assert.equal(bad.statusCode, 400)

    const r2 = await req(B, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Quick', isDefault: true })
    T2 = r2.json().template.id
    let list = (await req(B, 'GET', `/pages/${C}/collection/row-templates`)).json()
    assert.equal(list.defaultId, T2)
    assert.deepEqual(list.templates.map((t: { name: string }) => t.name), ['Meeting', 'Quick'])
    assert.equal((await req(A, 'PATCH', `/collection-row-templates/${T1}`, { isDefault: true })).statusCode, 200)
    list = (await req(B, 'GET', `/pages/${C}/collection/row-templates`)).json()
    assert.equal(list.defaultId, T1)
    assert.equal(list.templates.filter((t: { isDefault: boolean }) => t.isDefault).length, 1)
  })

  it('applies the default template on a new row; null makes an empty row; explicit values win', async () => {
    const tz = 'Pacific/Kiritimati' // UTC+14: "today" differs from UTC for part of the day
    const r = await req(B, 'POST', `/pages/${C}/collection/rows`, { tz, inputs: { Topic: 'Budget' } })
    assert.equal(r.statusCode, 200, r.body)
    const { row, templateId } = r.json()
    assert.equal(templateId, T1)
    assert.equal(row.title, `${today(tz)} Budget meeting`)
    assert.equal(row.icon, '📋')
    assert.deepEqual(row.props, { status: 'o-todo', due: today(tz, 7), owner: B.id, notes: 'by Bob', flag: true })
    const text = await docText(row.id)
    assert.match(text, new RegExp(`Notes for ${today(tz)} Budget meeting zebraquokka`))
    assert.match(text, /\{\{date\}\} stays/, 'code blocks are not substituted')
    // indexed for search like any page
    const [pt] = await db.select().from(schema.pageTexts).where(eq(schema.pageTexts.pageId, row.id))
    assert.match(pt.text, /zebraquokka/)
    // created like POST /pages: the creator and the client
    const [p] = await db.select().from(schema.pages).where(eq(schema.pages.id, row.id))
    assert.equal(p.createdBy, B.id)
    assert.equal(p.kind, 'doc')

    const blank = (await req(B, 'POST', `/pages/${C}/collection/rows`, { template: null })).json()
    assert.equal(blank.templateId, null)
    assert.equal(blank.row.title, '')
    assert.deepEqual(blank.row.props, {})
    assert.equal(await docText(blank.row.id), '')

    // board column / calendar day: values over the defaults, one request; a typed title wins
    const col = (await req(B, 'POST', `/pages/${C}/collection/rows`, { title: 'Mine', props: { status: 'o-done', due: '2027-01-02', ghost: 1 } })).json()
    assert.equal(col.row.title, 'Mine')
    assert.equal(col.row.props.status, 'o-done')
    assert.equal(col.row.props.due, '2027-01-02')
    assert.equal(col.row.props.ghost, undefined)
    assert.match(await docText(col.row.id), /Notes for Mine zebraquokka/)

    const other = (await req(B, 'POST', `/pages/${C}/collection/rows`, { template: T2 })).json()
    assert.equal(other.templateId, T2)
    const nf = await req(B, 'POST', `/pages/${C}/collection/rows`, { template: '00000000-0000-4000-8000-000000000000' })
    assert.equal(nf.statusCode, 404)
    const nonMember = await req(B, 'POST', `/pages/${C}/collection/rows`, { template: null, props: { owner: '00000000-0000-4000-8000-000000000000' } })
    assert.equal(nonMember.statusCode, 400)
  })

  it('keeps blocks only the editor knows (callout) and can start from an existing row', async () => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(await body('Intro'), 'base64'))
    const group = d.getXmlFragment('document').get(0) as Y.XmlElement
    d.transact(() => {
      const bc = new Y.XmlElement('blockContainer')
      group.push([bc])
      bc.setAttribute('id', 'callout-block')
      const callout = new Y.XmlElement('callout')
      bc.push([callout])
      callout.setAttribute('emoji', '💡')
      const txt = new Y.XmlText()
      callout.push([txt])
      txt.insert(0, 'Owner: {{author}}')
    })
    const t = (await req(A, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Callout' })).json().template
    const up = await req(A, 'PATCH', `/collection-row-templates/${t.id}`, { update: Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64') })
    assert.equal(up.json().template.hasBody, true)
    const r = (await req(B, 'POST', `/pages/${C}/collection/rows`, { template: t.id, title: 'With callout' })).json()
    const [doc] = await db.select().from(schema.pageDocs).where(eq(schema.pageDocs.pageId, r.row.id))
    const y = new Y.Doc()
    Y.applyUpdate(y, doc.state)
    const xml = y.getXmlFragment('document').toString()
    assert.match(xml, /<callout emoji="💡">Owner: Bob<\/callout>/)

    const fromRow = await req(A, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Copy of row', fromRowId: r.row.id })
    assert.equal(fromRow.statusCode, 200, fromRow.body)
    assert.equal(fromRow.json().template.title, 'With callout')
    const st = (await req(A, 'GET', `/collection-row-templates/${fromRow.json().template.id}`)).json().state
    const y2 = new Y.Doc()
    Y.applyUpdate(y2, Buffer.from(st, 'base64'))
    assert.match(y2.getXmlFragment('document').toString(), /Owner: Bob/)
    const notRow = await req(A, 'POST', `/pages/${C}/collection/row-templates`, { name: 'x', fromRowId: C })
    assert.equal(notRow.statusCode, 400)
    await req(A, 'DELETE', `/collection-row-templates/${t.id}`)
    await req(A, 'DELETE', `/collection-row-templates/${fromRow.json().template.id}`)
  })

  it('stale defaults are dropped, not stored: removed option, removed member', async () => {
    const X = await h.makeUser('Xena')
    await db.insert(schema.workspaceMembers).values({ workspaceId: wsId, userId: X.id, role: 'member' })
    const t = (await req(A, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Stale', props: { owner: X.id, status: 'o-done' } })).json().template
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, wsId), eq(schema.workspaceMembers.userId, X.id)))
    await req(A, 'PUT', `/pages/${C}/collection/fields`, { fields: FIELDS.map((f) => (f.id === 'status' ? { ...f, options: f.options!.slice(0, 1) } : f)) })
    const r = (await req(A, 'POST', `/pages/${C}/collection/rows`, { template: t.id })).json()
    assert.deepEqual(r.row.props, {})
    await req(A, 'PUT', `/pages/${C}/collection/fields`, { fields: FIELDS })
    await req(A, 'DELETE', `/collection-row-templates/${t.id}`)
  })

  it('templates are not pages: no search hit, not in the gallery, not usable as gallery templates', async () => {
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(eq(schema.pages.workspaceId, wsId)))[0].n
    await req(A, 'POST', `/pages/${C}/collection/row-templates`, { name: 'Secret', title: 'okapiwombat' })
    const after = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(eq(schema.pages.workspaceId, wsId)))[0].n
    assert.equal(after, before)
    const s = await req(A, 'GET', `/workspaces/${wsId}/search?q=okapiwombat`)
    assert.equal(s.statusCode, 200)
    assert.doesNotMatch(s.body, /okapiwombat/)
    const gallery = (await req(A, 'GET', `/workspaces/${wsId}/templates`)).json().templates as { id: string }[]
    assert.equal(gallery.some((g) => g.id === T1), false)
    const fromTpl = await req(A, 'POST', '/pages/from-template', { workspaceId: wsId, templateId: T1 })
    assert.equal(fromTpl.statusCode, 404)
    const del = await req(A, 'DELETE', `/templates/${T1}`)
    assert.equal(del.statusCode, 404)
  })

  it('permissions: private collections, edit locks', async () => {
    const P = await makeCollection(A, 'Private', { scope: 'private' })
    const t = (await req(A, 'POST', `/pages/${P}/collection/row-templates`, { name: 'Mine' })).json().template
    assert.equal((await req(B, 'GET', `/pages/${P}/collection/row-templates`)).statusCode, 404)
    assert.equal((await req(B, 'GET', `/collection-row-templates/${t.id}`)).statusCode, 404)
    assert.equal((await req(B, 'PATCH', `/collection-row-templates/${t.id}`, { name: 'x' })).statusCode, 404)
    assert.equal((await req(B, 'POST', `/pages/${P}/collection/rows`, {})).statusCode, 404)

    const L = await makeCollection(A, 'Locked')
    const lt = (await req(A, 'POST', `/pages/${L}/collection/row-templates`, { name: 'Locked one', isDefault: true })).json().template
    assert.equal((await req(A, 'PUT', `/pages/${L}/lock`, { locked: true, people: 'editors' })).statusCode, 200)
    // B can read and pick, but neither edit templates nor add rows
    assert.equal((await req(B, 'GET', `/pages/${L}/collection/row-templates`)).statusCode, 200)
    for (const [m, url, body] of [
      ['POST', `/pages/${L}/collection/row-templates`, { name: 'x' }],
      ['PATCH', `/collection-row-templates/${lt.id}`, { name: 'x' }],
      ['DELETE', `/collection-row-templates/${lt.id}`, undefined],
      ['POST', `/pages/${L}/collection/rows`, {}],
    ] as const) {
      const r = await req(B, m, url, body)
      assert.equal(r.statusCode, 403, `${m} ${url}: ${r.body}`)
      assert.equal(r.json().error.code, 'PAGE_LOCKED')
    }
    // the owner still can
    assert.equal((await req(A, 'POST', `/pages/${L}/collection/rows`, {})).statusCode, 200)
  })

  it('duplicate copies the templates; a saved structure template carries them unrendered', async () => {
    const dup = await req(A, 'POST', `/pages/${C}/duplicate`)
    assert.equal(dup.statusCode, 200, dup.body)
    const copy = dup.json().pages[0].id as string
    const copied = (await req(A, 'GET', `/pages/${copy}/collection/row-templates`)).json()
    assert.deepEqual(copied.templates.map((t: { name: string }) => t.name), ['Meeting', 'Quick', 'Secret'])
    assert.equal(copied.templates.find((t: { id: string }) => t.id === copied.defaultId).name, 'Meeting')
    assert.equal(copied.templates[0].props.owner, 'me')

    // owner default 'me' is kept; a fixed person is dropped from a structure template
    await req(A, 'PATCH', `/collection-row-templates/${T2}`, { props: { owner: B.id } })
    const saved = await req(A, 'POST', `/workspaces/${wsId}/templates`, { name: 'Meetings DB', fromPageId: C })
    assert.equal(saved.statusCode, 200, saved.body)
    const tid = saved.json().template.id as string
    assert.deepEqual(saved.json().template.inputs, [], 'row template prompts are not asked when the structure is created')
    const made = await req(A, 'POST', '/pages/from-template', { workspaceId: wsId, templateId: tid })
    assert.equal(made.statusCode, 200, made.body)
    const newC = made.json().page.id as string
    const got = (await req(A, 'GET', `/pages/${newC}/collection/row-templates`)).json()
    assert.deepEqual(got.templates.map((t: { name: string }) => t.name), ['Meeting', 'Quick', 'Secret'])
    const meeting = got.templates[0]
    assert.equal(meeting.title, '{{date}} {{input:Topic|Weekly}} meeting')
    assert.equal(got.defaultId, meeting.id)
    assert.equal(got.templates[1].props.owner, undefined)
    const body1 = (await req(A, 'GET', `/collection-row-templates/${meeting.id}`)).json().state as string
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(body1, 'base64'))
    assert.match(d.getXmlFragment('document').toString(), /Notes for \{\{title\}\} zebraquokka/)

    // template file: export → import keeps them
    const ex = await req(A, 'GET', `/workspaces/${wsId}/templates/${tid}/export`)
    assert.equal(ex.statusCode, 200)
    const zip = await JSZip.loadAsync(ex.rawPayload)
    const manifest = JSON.parse(await zip.file('inkling-template.json')!.async('string'))
    const rts = manifest.root.rowTemplates as { name: string; file: string; default?: boolean; props: Record<string, unknown> }[]
    assert.deepEqual(rts.map((t) => t.name), ['Meeting', 'Quick', 'Secret'])
    assert.equal(rts[0].default, true)
    assert.match(await zip.file(rts[0].file)!.async('string'), /zebraquokka/)
    const form = new FormData()
    form.append('file', new Blob([ex.rawPayload]), 'meetings.zip')
    const res = await fetchInject(`/api/workspaces/${wsId}/templates/import`, form)
    assert.equal(res.statusCode, 200, res.body)
    const imported = await req(A, 'POST', '/pages/from-template', { workspaceId: wsId, templateId: res.json().template.id })
    const impC = imported.json().page.id as string
    const impList = (await req(A, 'GET', `/pages/${impC}/collection/row-templates`)).json()
    assert.equal(impList.templates.length, 3)
    assert.equal(impList.templates.find((t: { id: string }) => t.id === impList.defaultId).name, 'Meeting')
    assert.deepEqual(impList.templates[0].props, { status: 'o-todo', due: 'today+7', owner: 'me', notes: 'by {{author}}', flag: true })
  })

  /** Multipart through app.inject (Request → buffer). */
  async function fetchInject(url: string, form: FormData) {
    const r = new Request('http://x', { method: 'POST', body: form })
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie: A.cookie, 'content-type': r.headers.get('content-type')! },
      payload: Buffer.from(await r.arrayBuffer()),
    })
  }

  it('MCP: create_row uses the default, a named template, or none; describe lists templates', async () => {
    const mcp = await h.connectMcp(app, { ...B, via: 'Test Agent' }, await h.mintToken(B))
    try {
      const d = await mcp.tool('query_rows', { collectionId: C, describe: true })
      assert.match(d.text, /^- Meeting \[default\] \([0-9a-f-]{36}\); inputs: Topic\|Weekly$/m)
      const r1 = await mcp.tool('create_row', { collectionId: C, inputs: { Topic: 'Agents' } })
      assert.equal(r1.isError, false, r1.text)
      assert.match(r1.text, /^Template: Meeting \(/m)
      assert.match(r1.text, /Agents meeting/)
      const r2 = await mcp.tool('create_row', { collectionId: C, template: 'quick', title: 'q' })
      assert.match(r2.text, /^Template: Quick \(/m)
      const r3 = await mcp.tool('create_row', { collectionId: C, template: 'none', title: 'plain', properties: { Status: 'Done' } })
      assert.match(r3.text, /^Template: none \(empty row\)$/m)
      assert.match(r3.text, /Status: Done/)
      const id3 = /Created row ([0-9a-f-]{36})/.exec(r3.text)![1]
      const [p3] = await db.select().from(schema.pages).where(eq(schema.pages.id, id3))
      assert.equal(p3.createdVia, 'Test Agent')
      const r4 = await mcp.tool('create_row', { collectionId: C, template: 'Nope' })
      assert.equal(r4.isError, true)
      assert.match(r4.text, /No row template "Nope".*Nothing was written/s)
    } finally {
      await mcp.close()
    }
  })

  it('a deleted collection takes its templates along', async () => {
    const D = await makeCollection(A, 'Gone')
    await req(A, 'POST', `/pages/${D}/collection/row-templates`, { name: 'x' })
    await db.delete(schema.pages).where(eq(schema.pages.id, D))
    const left = await db.select().from(schema.collectionRowTemplates).where(eq(schema.collectionRowTemplates.collectionId, D))
    assert.equal(left.length, 0)
  })

  it('at most ROW_TEMPLATES_MAX per collection', async () => {
    const { ROW_TEMPLATES_MAX } = await import('@inkling/shared')
    const E = await makeCollection(A, 'Cap')
    for (let i = 0; i < ROW_TEMPLATES_MAX; i++) {
      assert.equal((await req(A, 'POST', `/pages/${E}/collection/row-templates`, { name: `t${i}` })).statusCode, 200)
    }
    assert.equal((await req(A, 'POST', `/pages/${E}/collection/row-templates`, { name: 'over' })).statusCode, 400)
  })
})
