// Agent arguments as the tools print them (0.24.1): option names in view filters, `v=` versions,
// cursors and ids pasted from another tool's output, and the errors that say what to pass instead.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/mcpTools/agentArgs024.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] agent arguments as printed (0.24.1)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./testHarness')
  const { closeDb, db } = await import('../db/index')
  const schema = await import('../db/schema')
  const collab = await import('../collab')
  const app = await h.buildTestApp()
  const alice = await h.makeUser('alice')
  const ws = await h.makeWorkspace(alice)
  const mcp = await h.connectMcp(app, alice, await h.mintToken(alice))
  after(async () => {
    await mcp.close()
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })
  type U = typeof alice
  const as = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie: u.cookie }, payload: payload as object })

  it('create_view: select / multiSelect filter values by option name are stored as ids; unknown names list the options', async () => {
    const res = await as(alice, 'POST', '/pages', { workspaceId: ws.id, kind: 'collection', title: 'Bugs' })
    assert.equal(res.statusCode, 200, res.body)
    const coll = res.json().page.id as string
    const put = await as(alice, 'PUT', `/pages/${coll}/collection/fields`, {
      fields: [
        { id: 'area', name: 'Area', type: 'select', options: [{ id: 'a1', name: 'Web', color: 'gray' }, { id: 'a3', name: 'QA', color: 'blue' }] },
        { id: 'tg', name: 'Tags', type: 'multiSelect', options: [{ id: 't1', name: 'UI', color: 'red' }, { id: 't2', name: 'API', color: 'blue' }] },
      ],
    })
    assert.equal(put.statusCode, 200, put.body)
    await db.insert(schema.pages).values(
      [
        { title: 'one', props: { area: 'a3', tg: ['t1'] } },
        { title: 'two', props: { area: 'a3', tg: ['t2'] } },
        { title: 'three', props: { area: 'a1', tg: ['t1', 't2'] } },
      ].map((r, i) => ({ workspaceId: ws.id, parentId: coll, title: r.title, createdBy: alice.id, kind: 'doc' as const, props: r.props, sortOrder: i })),
    )
    const viewsOf = async () =>
      (await as(alice, 'GET', `/pages/${coll}/collection?rows=0`)).json().collection.views as { id: string; name: string; config: Record<string, unknown> }[]
    const rowsOf = async (viewId: string) => {
      const view = (await viewsOf()).find((v) => v.id === viewId)!
      const r = await as(alice, 'POST', `/workspaces/${ws.id}/charts/aggregate`, { source: { type: 'collection', collectionId: coll, viewId: view.id }, groupBy: { field: 'area' } })
      assert.equal(r.statusCode, 200, r.body)
      return r.json().rowCount as number
    }
    const idOf = (t: string) => /created: id (\S+)\./.exec(t)![1]

    // by name (case-insensitive), flat list
    const qa = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'QA', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'qa' }] } })
    assert.equal(qa.isError, false, qa.text)
    const qaView = (await viewsOf()).find((v) => v.id === idOf(qa.text))!
    assert.deepEqual(qaView.config.filters, [{ fieldId: 'area', op: 'eq', value: 'a3' }])
    assert.equal(await rowsOf(qaView.id), 2)
    // multiSelect contains, in the tree form with a group
    const tree = await mcp.tool('create_view', {
      collectionId: coll,
      type: 'table',
      name: 'UI or Web',
      config: { filter: { mode: 'or', items: [{ fieldId: 'Tags', op: 'contains', value: 'UI' }, { mode: 'and', items: [{ fieldId: 'Area', op: 'ne', value: 'QA' }] }] } },
    })
    assert.equal(tree.isError, false, tree.text)
    const treeView = (await viewsOf()).find((v) => v.id === idOf(tree.text))!
    assert.deepEqual(treeView.config.filter, { mode: 'or', items: [{ fieldId: 'tg', op: 'contains', value: 't1' }, { mode: 'and', items: [{ fieldId: 'area', op: 'ne', value: 'a3' }] }] })
    assert.equal(await rowsOf(treeView.id), 2)
    // ids as the web app stores them: unchanged
    const byId = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'Web', config: { filters: [{ fieldId: 'area', op: 'eq', value: 'a1' }] } })
    assert.equal(byId.isError, false, byId.text)
    const webView = (await viewsOf()).find((v) => v.id === idOf(byId.text))!
    assert.deepEqual(webView.config.filters, [{ fieldId: 'area', op: 'eq', value: 'a1' }])
    assert.equal(await rowsOf(webView.id), 1)
    // an unknown name: refused with the options, nothing written
    const before = (await viewsOf()).length
    const bad = await mcp.tool('create_view', { collectionId: coll, type: 'table', name: 'Nope', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'Ops' }] } })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /filters: "Area" has no option "Ops"\. Options: "Web", "QA"\. Nothing was written\./)
    assert.equal((await viewsOf()).length, before)

    // a chart through a view whose filter keeps nothing says why it is empty
    const empty = await mcp.tool('create_view', { collectionId: coll, type: 'chart', name: 'Web UI', config: { filters: [{ fieldId: 'Area', op: 'eq', value: 'Web' }, { fieldId: 'Tags', op: 'eq', value: 'API' }, { fieldId: 'Tags', op: 'ne', value: 'API' }] }, chart: { kind: 'bar', groupBy: 'Area' } })
    assert.equal(empty.isError, false, empty.text)
    assert.match(empty.text, /no data \(0 rows\)/)
    assert.match(empty.text, /\nnote: no rows match the view's filter \(3 rows without it\)/)
    const doc = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Report', markdown: '## Charts\n\nbelow' })
    assert.equal(doc.isError, false, doc.text)
    const docId = /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(doc.text)![1]
    const chart = await mcp.tool('create_chart', { pageId: docId, collectionId: coll, view: 'Web UI', kind: 'bar', groupBy: 'Area' })
    assert.equal(chart.isError, false, chart.text)
    assert.match(chart.text, /\nnote: no rows match the view's filter \(3 rows without it\)\n/)
    // a view with rows: no note
    const full = await mcp.tool('create_chart', { pageId: docId, collectionId: coll, view: 'QA', kind: 'bar', groupBy: 'Area' })
    assert.equal(full.isError, false, full.text)
    assert.doesNotMatch(full.text, /note: no rows match/)
    // query_rows already takes option names in its filter
    const q = await mcp.tool('query_rows', { collectionId: coll, filter: 'Area = QA' })
    assert.equal(q.isError, false, q.text)
    assert.match(q.text, /one/)
    assert.match(q.text, /two/)
    assert.doesNotMatch(q.text, /three/)
  })
  it('baseVersion / known with the printed `v=` prefix act like the bare version; a stale one still conflicts', async () => {
    const made = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Versions', markdown: '## Plan\n\nold plan\n\n## Notes\n\nold notes' })
    assert.equal(made.isError, false, made.text)
    const pageId = /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(made.text)![1]
    const sectionV = async (anchor: string) => {
      const o = await mcp.tool('read_page', { pageId, outline: true })
      const m = new RegExp(`§${anchor}\\b[^\\n]*?v=([0-9a-f]+)`).exec(o.text)
      assert.ok(m, o.text)
      return m[1]
    }
    const v1 = await sectionV('plan')
    // patch_section: `v=` + version, with spaces
    const p = await mcp.tool('patch_section', { pageId, section: 'plan', mode: 'replace', markdown: 'new plan', baseVersion: ` v=${v1}` })
    assert.equal(p.isError, false, p.text)
    // the same (now stale) version, either way, conflicts
    for (const base of [`v=${v1}`, v1]) {
      const stale = await mcp.tool('patch_section', { pageId, section: 'plan', mode: 'replace', markdown: 'lost', baseVersion: base })
      assert.equal(stale.isError, true, base)
      assert.match(stale.text, new RegExp(`changed since baseVersion ${v1};`))
    }
    // patch_sections
    const v2 = await sectionV('notes')
    const many = await mcp.tool('patch_sections', { pageId, edits: [{ section: 'notes', mode: 'replace', markdown: 'new notes', baseVersion: `V=${v2}` }] })
    assert.equal(many.isError, false, many.text)
    // read_page known: `v=` + version gives the one-line "unchanged" answer
    const read = await mcp.tool('read_page', { pageId })
    const pv = /^- version: (\S+)$/m.exec(read.text)![1]
    const same = await mcp.tool('read_page', { pageId, known: `v=${pv}` })
    const bare = await mcp.tool('read_page', { pageId, known: pv })
    assert.equal(same.text, bare.text)
    assert.match(same.text, /unchanged/)
    // update_page replace
    const rep = await mcp.tool('update_page', { pageId, mode: 'replace', markdown: '## Plan\n\nreplaced', baseVersion: `v=${pv}` })
    assert.equal(rep.isError, false, rep.text)
    const old = await mcp.tool('update_page', { pageId, mode: 'replace', markdown: 'again', baseVersion: `v=${pv}` })
    assert.equal(old.isError, true)
    assert.match(old.text, new RegExp(`the page changed since version ${pv} \\(PAGE_CONFLICT`))
  })
  it("catch_up's `next since:` works in changes_since; a future since says so; inbox/ack take what inbox printed", async () => {
    const { drainChangeLog } = await import('../context/changeLog')
    const first = await mcp.tool('catch_up', { workspaceId: ws.id, peek: true })
    assert.equal(first.isError, false, first.text)
    const sinceLine = first.text.trimEnd().split('\n').at(-1)!
    assert.match(sinceLine, /^next since: \S+ \(up to [^)]+\)$/)
    const token = /^next since: (\S+)/.exec(sinceLine)![1]
    await mcp.tool('create_page', { workspaceId: ws.id, title: 'After catch up', markdown: 'hello' })
    await drainChangeLog()
    for (const [wsRef, cursor] of [[ws.id, token], [ws.id, sinceLine], [ws.id.slice(0, 8), token]]) {
      const r = await mcp.tool('changes_since', { workspaceId: wsRef, cursor })
      assert.equal(r.isError, false, r.text)
      assert.match(r.text, /After catch up/)
      assert.match(r.text.trimEnd().split('\n').at(-1)!, /^next cursor: \S+$/)
    }
    // and the printed line works as catch_up's own since
    const again = await mcp.tool('catch_up', { workspaceId: ws.id, since: sinceLine, peek: true })
    assert.equal(again.isError, false, again.text)
    assert.match(again.text, /After catch up/)
    // garbage is still refused
    const bad = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: 'garbage!!' })
    assert.equal(bad.isError, true)
    // a time is refused with where it belongs
    const time = await mcp.tool('changes_since', { workspaceId: ws.id, cursor: '2099-01-01T00:00Z' })
    assert.equal(time.isError, true)
    assert.match(time.text, /changes_since takes a cursor, not a time \("2099-01-01T00:00Z"\)\. For what changed since a time use catch_up\(since=…\)/)

    // a future since: a note on the first line, not a silent "nothing happened"
    for (const since of ['2099-01-01', '2099-01-01T09:00Z']) {
      const fut = await mcp.tool('catch_up', { workspaceId: ws.id, since, peek: true })
      assert.equal(fut.isError, false, fut.text)
      assert.match(fut.text.split('\n')[0], /^note: since is in the future \(server time \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z, UTC\); nothing can match$/)
    }
    const past = await mcp.tool('catch_up', { workspaceId: ws.id, since: '2020-01-01', peek: true })
    assert.doesNotMatch(past.text, /in the future/)

    // inbox / ack: ids as numbers, the cursor line as printed; anything else says what to pass
    const inbox = await mcp.tool('inbox', {})
    assert.equal(inbox.isError, false, inbox.text)
    const cursorLine = inbox.text.trimEnd().split('\n').at(-1)!
    assert.match(cursorLine, /^cursor: \d+/)
    const viaLine = await mcp.tool('inbox', { cursor: cursorLine })
    assert.equal(viaLine.isError, false, viaLine.text)
    const nums = await mcp.tool('ack', { ids: [987654321, '987654322'] })
    assert.equal(nums.isError, false, nums.text)
    assert.match(nums.text, /^Acknowledged 0 item\(s\)\.$/)
    const line = await mcp.tool('ack', { cursor: cursorLine })
    assert.equal(line.isError, false, line.text)
    for (const cursor of ['since: 4', 'abc']) {
      const wrong = await mcp.tool('ack', { cursor })
      assert.equal(wrong.isError, true, cursor)
      assert.match(wrong.text, /is not an inbox cursor\. Pass the value after "cursor:" on the last line of inbox \(like 91 or 91;ws=…\), or ids: the numbers at the start of inbox lines\. Nothing was acknowledged\./)
    }
  })
  it('get_instructions: forPageId of another workspace is named as such; hidden and missing pages read alike', async () => {
    const ws2 = await h.makeWorkspace(alice)
    const bob = await h.makeUser('bob')
    const bobWs = await h.makeWorkspace(bob)
    const there = await h.makeDocPage(ws2.id, alice.id, 'Elsewhere', [] as never)
    const hidden = await h.makeDocPage(bobWs.id, bob.id, 'Bob only', [] as never)
    const other = await mcp.tool('get_instructions', { workspaceId: ws.id, forPageId: there.id })
    assert.equal(other.isError, true)
    assert.match(other.text, new RegExp(`forPageId is not a page of workspace ${ws.id.slice(0, 8)}: it is in workspace ${ws2.id.slice(0, 8)}\\. Call get_instructions again without workspaceId`))
    const viaPage = await mcp.tool('get_instructions', { forPageId: there.id })
    assert.equal(viaPage.isError, false, viaPage.text)
    // the page's own workspace, by full id, 8-character prefix or name: answered as before
    const [row] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where((await import('drizzle-orm')).eq(schema.workspaces.id, ws2.id))
    for (const ref of [ws2.id, ws2.id.slice(0, 8), row.name]) {
      const same = await mcp.tool('get_instructions', { workspaceId: ref, forPageId: there.id })
      assert.equal(same.isError, false, `${ref}: ${same.text}`)
      assert.equal(same.text, viaPage.text, ref)
    }
    const a = await mcp.tool('get_instructions', { workspaceId: ws.id, forPageId: hidden.id })
    const b = await mcp.tool('get_instructions', { workspaceId: ws.id, forPageId: '00000000-0000-4000-8000-000000000000' })
    assert.equal(a.isError, true)
    assert.equal(a.text, b.text)
    assert.match(a.text, /^Error: forPageId: page not found or not visible to you;/)
  })

  it('update_page over the request limit names the limit in bytes and what to do', async () => {
    const made = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Big', markdown: 'start' })
    const pageId = /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(made.text)![1]
    const big = '가나다라마바사아자차'.repeat(40_000) // 400k characters, 1.2 MB as UTF-8
    const r = await mcp.tool('update_page', { pageId, mode: 'append', markdown: big })
    assert.equal(r.isError, true)
    assert.match(r.text, /Request too large \(PAYLOAD_TOO_LARGE\): 1\.\d+ MiB of UTF-8 JSON; this server takes at most 1 MiB \(1048576 bytes\) per request\. Text is counted in bytes \(Korean is 3 bytes a character: about 349000 characters\)\. Nothing was written\. Split it: put parts into child pages/)
    assert.doesNotMatch(r.text, /25MB/)
  })

  it('POST /mcp: arguments that are not an object are invalid params (-32602); a body over the limit names it', async () => {
    const Fastify = (await import('fastify')).default
    const door = Fastify()
    // the root app's handler shape (index.ts): errors the /mcp scope does not handle still reach it
    door.setErrorHandler((err, _req, reply) => {
      const e = err as { status?: number; statusCode?: number; code?: string; message: string }
      return reply.code(e.status ?? e.statusCode ?? 500).send({ error: { code: e.code ?? 'INTERNAL', message: e.message } })
    })
    await door.register(async (root) => {
      await (await import('../mcp')).registerMcpRoutes(root, app)
    })
    await door.ready()
    try {
      const token = await h.mintToken(alice)
      const post = (payload: string) =>
        door.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload })
      for (const args of ['[]', '["x"]', '"x"']) {
        const r = await post(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_workspaces","arguments":${args}}}`)
        assert.equal(r.statusCode, 200, r.body)
        const body = r.json() as { id: number; error: { code: number; message: string } }
        assert.equal(body.id, 7)
        assert.equal(body.error.code, -32602)
        assert.match(body.error.message, /^Invalid params: tools\/call arguments must be a JSON object/)
      }
      // an object (or none) still runs
      const ok = await post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"list_workspaces","arguments":{}}}')
      assert.equal(ok.statusCode, 200, ok.body)
      assert.doesNotMatch(ok.body, /"error"/)
      const big = await post(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"update_page","arguments":{"markdown":"${'x'.repeat(13 * 1024 * 1024)}"}}}`)
      assert.equal(big.statusCode, 413)
      assert.match(big.json().error.message, /^Request body is larger than \d+ MB, the most this server takes on \/mcp; nothing was done\. Send large content in several calls/)
      // the value cap's own 413 is passed on unchanged
      const { MCP_MAX_JSON_VALUES } = await import('../mcpBody')
      const many = await post(`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_workspaces","arguments":{"x":[${'0,'.repeat(MCP_MAX_JSON_VALUES + 10)}0]}}}`)
      assert.equal(many.statusCode, 413)
      assert.equal(many.json().error.code, 'TOO_MANY_VALUES')
    } finally {
      await door.close()
    }
  })
})
