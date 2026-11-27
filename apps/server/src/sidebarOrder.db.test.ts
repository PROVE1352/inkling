// Pinned pages and title order (docs/adr/2590-*, 2591-*): who may switch them, and the order the page
// list, list_pages and the reorder guard give.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/sidebarOrder.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-sidebarorder-${process.pid}`

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { PageMetaDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] sidebar order: pinned pages and title order', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const collab = await import('./collab')
  const { createApiToken } = await import('./apiTokens')
  const app = await h.buildTestApp()
  after(async () => {
    await collab.destroyCollab()
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const asCookie = (u: U, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const asToken = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

  let owner: U, member: U, other: U, guest: U, outsider: U
  let ws: { id: string }
  const create = async (u: U, title: string, extra: Record<string, unknown> = {}) => {
    const r = await asCookie(u, 'POST', '/api/pages', { workspaceId: ws.id, title, ...extra })
    assert.equal(r.statusCode, 200, r.body)
    return (r.json() as { page: PageMetaDTO }).page
  }
  const tree = async (u: U) => {
    const r = await asCookie(u, 'GET', `/api/workspaces/${ws.id}/pages`)
    assert.equal(r.statusCode, 200, r.body)
    return r.json() as { pages: PageMetaDTO[]; rootSort?: { shared?: string; private?: string } }
  }
  const childrenTitles = (pages: PageMetaDTO[], parentId: string | null, scope?: 'shared' | 'private') =>
    pages.filter((p) => p.parentId === parentId && (!scope || p.scope === scope)).map((p) => p.title)

  before(async () => {
    owner = await h.makeUser('Owner')
    member = await h.makeUser('Member')
    other = await h.makeUser('Other')
    guest = await h.makeUser('Guest')
    outsider = await h.makeUser('Outsider')
    ws = await h.makeWorkspace(owner, [member, other])
  })

  it('pin: a member who may edit the page pins it for everyone; it stays above its siblings, and new or moved pages land below it', async () => {
    const a = await create(owner, '00 Summary')
    const b = await create(owner, '01 Plan')
    const c = await create(owner, 'Experiments')
    const r = await asCookie(member, 'PUT', `/api/pages/${c.id}/pin`, { pinned: true })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((r.json() as { page: PageMetaDTO }).page.pinned, true)
    // every member sees it first, not only the one who pinned it (unlike favorites)
    for (const u of [owner, member, other]) assert.deepEqual(childrenTitles((await tree(u)).pages, null, 'shared'), ['Experiments', '00 Summary', '01 Plan'])
    // a new top-level page goes below the pinned one (and the others)
    await create(owner, 'To do')
    assert.deepEqual(childrenTitles((await tree(owner)).pages, null, 'shared'), ['Experiments', '00 Summary', '01 Plan', 'To do'])
    // a page dragged to the very top (smallest sort_order) still sits below the pinned one
    const moved = await asCookie(owner, 'PATCH', `/api/pages/${b.id}`, { sortOrder: -1_000_000 })
    assert.equal(moved.statusCode, 200, moved.body)
    assert.deepEqual(childrenTitles((await tree(owner)).pages, null, 'shared'), ['Experiments', '01 Plan', '00 Summary', 'To do'])
    // a page moved in from elsewhere too
    const folder = await create(owner, 'Folder', { kind: 'folder' })
    const inner = await create(owner, 'Inner', { parentId: folder.id })
    await asCookie(owner, 'PATCH', `/api/pages/${inner.id}`, { parentId: null, sortOrder: -5_000_000 })
    assert.equal(childrenTitles((await tree(owner)).pages, null, 'shared')[0], 'Experiments')
    // two pinned pages keep their drag order among themselves
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${a.id}/pin`, { pinned: true })).statusCode, 200)
    const top2 = childrenTitles((await tree(owner)).pages, null, 'shared').slice(0, 2)
    assert.deepEqual(top2, ['00 Summary', 'Experiments'], 'a was created before c, so its sort_order is lower')
    // unpin
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${a.id}/pin`, { pinned: false })).statusCode, 200)
    assert.equal(childrenTitles((await tree(owner)).pages, null, 'shared')[0], 'Experiments')
  })

  it('pin and title order are refused for tokens, guests, outsiders and people who may not edit the page', async () => {
    const p = await create(owner, 'Locked notes')
    // lock it: only the page owner and the workspace owners/admins edit (docs/adr/0970-*)
    const lock = await asCookie(owner, 'PUT', `/api/pages/${p.id}/lock`, { locked: true })
    assert.equal(lock.statusCode, 200, lock.body)
    for (const url of [`/api/pages/${p.id}/pin`, `/api/pages/${p.id}/child-sort`]) {
      const body = url.endsWith('pin') ? { pinned: true } : { childSort: 'title' }
      assert.equal((await asCookie(member, 'PUT', url, body)).statusCode, 403, `member on a locked page: ${url}`)
      assert.equal((await asCookie(outsider, 'PUT', url, body)).statusCode, 404, `outsider: ${url}`)
      // an API token of the owner (all access, write): browser only
      const api = (await createApiToken(owner.id, { name: 'script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
      assert.equal((await asToken(api, 'PUT', url, body)).statusCode, 403, `API token: ${url}`)
      // an MCP access token cannot reach REST from outside at all
      const oauth = await h.mintToken(owner)
      assert.equal((await asToken(oauth, 'PUT', url, body)).statusCode, 401, `MCP token outside /mcp: ${url}`)
      assert.equal((await asCookie(owner, 'PUT', url, body)).statusCode, 200, `the owner may: ${url}`)
    }
    // a guest with edit access to a page does not arrange the workspace's tree
    const shared = await create(owner, 'Shared with a guest')
    await db.insert(schema.pageGrants).values({ pageId: shared.id, userId: guest.id, level: 'edit', createdBy: owner.id })
    assert.equal((await asCookie(guest, 'GET', `/api/pages/${shared.id}/lock`)).statusCode, 200, 'the guest sees the page')
    assert.equal((await asCookie(guest, 'PUT', `/api/pages/${shared.id}/pin`, { pinned: true })).statusCode, 403)
    assert.equal((await asCookie(guest, 'PUT', `/api/pages/${shared.id}/child-sort`, { childSort: 'title' })).statusCode, 403)
    assert.equal((await asCookie(guest, 'PUT', `/api/workspaces/${ws.id}/root-sort`, { section: 'shared', childSort: 'title' })).statusCode, 403)
    // the guest's own tree is still ordered (pinned first) without failing
    const g = await asCookie(guest, 'GET', `/api/workspaces/${ws.id}/pages`)
    assert.equal(g.statusCode, 200, g.body)
    // the root order is a member's switch; an outsider gets the outsider answer, a token 403
    assert.notEqual((await asCookie(outsider, 'PUT', `/api/workspaces/${ws.id}/root-sort`, { section: 'shared', childSort: 'title' })).statusCode, 200)
    const api = (await createApiToken(member.id, { name: 'script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
    assert.equal((await asToken(api, 'PUT', `/api/workspaces/${ws.id}/root-sort`, { section: 'shared', childSort: 'title' })).statusCode, 403)
  })

  it('title order of a parent: numeric-aware, pinned first, drag reorder refused inside, moving in and out still works', async () => {
    const parent = await create(owner, 'Contest', { kind: 'folder' })
    for (const t of ['10 Notes', '2 Plan', 'Todo', '05 Tasks', '1 Intro']) await create(owner, t, { parentId: parent.id })
    let pages = (await tree(owner)).pages
    assert.deepEqual(childrenTitles(pages, parent.id), ['10 Notes', '2 Plan', 'Todo', '05 Tasks', '1 Intro'], 'manual by default')
    const r = await asCookie(member, 'PUT', `/api/pages/${parent.id}/child-sort`, { childSort: 'title' })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((r.json() as { page: PageMetaDTO }).page.childSort, 'title')
    pages = (await tree(other)).pages
    assert.deepEqual(childrenTitles(pages, parent.id), ['1 Intro', '2 Plan', '05 Tasks', '10 Notes', 'Todo'])
    // pinned still on top
    const todo = pages.find((p) => p.title === 'Todo' && p.parentId === parent.id)!
    await asCookie(owner, 'PUT', `/api/pages/${todo.id}/pin`, { pinned: true })
    pages = (await tree(owner)).pages
    assert.deepEqual(childrenTitles(pages, parent.id), ['Todo', '1 Intro', '2 Plan', '05 Tasks', '10 Notes'])
    // a drag among these siblings is refused (it would change nothing anyone sees)
    const plan = pages.find((p) => p.title === '2 Plan')!
    const drag = await asCookie(owner, 'PATCH', `/api/pages/${plan.id}`, { sortOrder: -1 })
    assert.equal(drag.statusCode, 409, drag.body)
    assert.equal((drag.json() as { error: { code: string } }).error.code, 'SORTED_BY_TITLE')
    // moving a page in from elsewhere works and lands in title order
    const loose = await create(owner, '3 Results')
    const moveIn = await asCookie(owner, 'PATCH', `/api/pages/${loose.id}`, { parentId: parent.id, sortOrder: 99_999 })
    assert.equal(moveIn.statusCode, 200, moveIn.body)
    assert.deepEqual(childrenTitles((await tree(owner)).pages, parent.id), ['Todo', '1 Intro', '2 Plan', '3 Results', '05 Tasks', '10 Notes'])
    // and out again
    const moveOut = await asCookie(owner, 'PATCH', `/api/pages/${loose.id}`, { parentId: null })
    assert.equal(moveOut.statusCode, 200, moveOut.body)
    // back to manual: the drag order returns and drags work again
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${parent.id}/child-sort`, { childSort: 'manual' })).statusCode, 200)
    assert.deepEqual(childrenTitles((await tree(owner)).pages, parent.id), ['Todo', '10 Notes', '2 Plan', '05 Tasks', '1 Intro'])
    assert.equal((await asCookie(owner, 'PATCH', `/api/pages/${plan.id}`, { sortOrder: -1 })).statusCode, 200)
  })

  it('top level: the shared order is the workspace\'s, the private order each person\'s own; the ETag follows both', async () => {
    const w2 = await h.makeWorkspace(owner, [member])
    const mk = async (u: U, title: string, scope: 'shared' | 'private' = 'shared') => {
      const r = await asCookie(u, 'POST', '/api/pages', { workspaceId: w2.id, title, scope })
      assert.equal(r.statusCode, 200, r.body)
    }
    for (const t of ['10 b', '2 a', '1 c']) await mk(owner, t)
    for (const t of ['P 10', 'P 9']) await mk(owner, t, 'private')
    for (const t of ['M 10', 'M 9']) await mk(member, t, 'private')
    const list = async (u: U, etag?: string) =>
      app.inject({ method: 'GET', url: `/api/workspaces/${w2.id}/pages`, headers: { cookie: u.cookie, ...(etag ? { 'if-none-match': etag } : {}) } })
    const first = await list(member)
    const etag = first.headers.etag as string
    assert.ok(etag)
    assert.equal((await list(member, etag)).statusCode, 304)
    // a member sorts the shared top level by title: everyone sees it, and the old ETag no longer matches
    const r = await asCookie(member, 'PUT', `/api/workspaces/${w2.id}/root-sort`, { section: 'shared', childSort: 'title' })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual((r.json() as { rootSort: unknown }).rootSort, { shared: 'title' })
    assert.equal((await list(member, etag)).statusCode, 200, 'the order changed without a page row changing')
    for (const u of [owner, member]) {
      const t = (await list(u)).json() as { pages: PageMetaDTO[]; rootSort?: unknown }
      assert.deepEqual(t.pages.filter((p) => !p.parentId && p.scope === 'shared').map((p) => p.title), ['1 c', '2 a', '10 b'])
    }
    // the owner sorts their private section; the member's stays manual
    assert.equal((await asCookie(owner, 'PUT', `/api/workspaces/${w2.id}/root-sort`, { section: 'private', childSort: 'title' })).statusCode, 200)
    const o = (await list(owner)).json() as { pages: PageMetaDTO[]; rootSort?: unknown }
    assert.deepEqual(o.rootSort, { shared: 'title', private: 'title' })
    assert.deepEqual(o.pages.filter((p) => p.scope === 'private').map((p) => p.title), ['P 9', 'P 10'])
    const m = (await list(member)).json() as { pages: PageMetaDTO[]; rootSort?: unknown }
    assert.deepEqual(m.rootSort, { shared: 'title' })
    assert.deepEqual(m.pages.filter((p) => p.scope === 'private').map((p) => p.title), ['M 10', 'M 9'])
    // GET /workspaces carries the same for the web app
    const wl = (await asCookie(owner, 'GET', '/api/workspaces')).json() as { workspaces: { id: string; rootSort?: unknown }[] }
    assert.deepEqual(wl.workspaces.find((w) => w.id === w2.id)?.rootSort, { shared: 'title', private: 'title' })
    // a drag at a title-sorted top level is refused; at the manual private level of the member it works
    const sharedPage = m.pages.find((p) => p.title === '2 a')!
    assert.equal((await asCookie(member, 'PATCH', `/api/pages/${sharedPage.id}`, { sortOrder: -1 })).statusCode, 409)
    const mine = m.pages.find((p) => p.title === 'M 9')!
    assert.equal((await asCookie(member, 'PATCH', `/api/pages/${mine.id}`, { sortOrder: -1 })).statusCode, 200)
  })

  it('list_pages prints the order the sidebar shows', async () => {
    const w3 = await h.makeWorkspace(owner, [])
    const mk = async (title: string, extra: Record<string, unknown> = {}) => {
      const r = await asCookie(owner, 'POST', '/api/pages', { workspaceId: w3.id, title, ...extra })
      assert.equal(r.statusCode, 200, r.body)
      return (r.json() as { page: PageMetaDTO }).page
    }
    const parent = await mk('Reports', { kind: 'folder' })
    for (const t of ['10 Oct', '9 Sep', '11 Nov']) await mk(t, { parentId: parent.id })
    const pin = await mk('Pinned')
    await asCookie(owner, 'PUT', `/api/pages/${pin.id}/pin`, { pinned: true })
    await asCookie(owner, 'PUT', `/api/pages/${parent.id}/child-sort`, { childSort: 'title' })
    const mcp = await h.connectMcp(app, owner, await h.mintToken(owner))
    const lines = await mcp.tool('list_pages', { workspaceId: w3.id, format: 'lines' })
    assert.equal(lines.isError, false, lines.text)
    const order = ['Pinned', 'Reports', '9 Sep', '10 Oct', '11 Nov'].map((t) => lines.text.indexOf(t))
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] >= 0 && order[i - 1] < order[i], lines.text)
    const json = JSON.parse((await mcp.tool('list_pages', { workspaceId: w3.id, parentId: parent.id, format: 'json' })).text) as { pages: { title: string }[] }
    assert.deepEqual(json.pages.map((p) => p.title), ['9 Sep', '10 Oct', '11 Nov'])
    const compact = await mcp.tool('list_pages', { workspaceId: w3.id })
    assert.ok(compact.text.indexOf('Pinned') < compact.text.indexOf('Reports'), compact.text)
    // agents cannot pin or sort: no tool does it and the REST routes are browser only
    const { tools } = await mcp.client.listTools()
    assert.ok(!tools.some((t) => /pin|sort/.test(t.name)))
  })
})
