// Where agents' new pages go when they name no parent (docs/adr/2592-*): who sets it, every create path
// a token uses, the explicit top level, and the cases where it must not apply (locked, instruction,
// out-of-range, trashed, purged) without telling the connection the page's title.
// Run: cd apps/server && DATABASE_URL=postgres://… node --import tsx --test src/agentDefaultParent.db.test.ts
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-agentdefault-${process.pid}`

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { PageMetaDTO, WorkspaceSettingsDTO } from '@inkling/shared'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] the agents\' default place for new pages', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const collab = await import('./collab')
  const { createApiToken } = await import('./apiTokens')
  const { createAgentToken } = await import('./agentTokens')
  const { getBearerUser } = await import('./oauth')
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

  const word = `dp${randomBytes(4).toString('hex')}`
  const inbox = `Agent inbox ${word}`
  let owner: U, member: U, guest: U
  let ws: { id: string }
  let other: { id: string }
  let inboxId: string
  const pageOf = async (id: string) => (await db.select().from(schema.pages).where(eq(schema.pages.id, id)).limit(1))[0]
  const mkPage = async (u: U, title: string, extra: Record<string, unknown> = {}) => {
    const r = await asCookie(u, 'POST', '/api/pages', { workspaceId: ws.id, title, ...extra })
    assert.equal(r.statusCode, 200, r.body)
    return (r.json() as { page: PageMetaDTO }).page
  }
  const setDefault = (u: U, pageId: string | null, wsId = ws.id) =>
    asCookie(u, 'PUT', `/api/workspaces/${wsId}/settings/agent-default-parent`, { pageId })
  const settings = async () => (await asCookie(owner, 'GET', `/api/workspaces/${ws.id}/settings`)).json() as { settings: WorkspaceSettingsDTO }

  before(async () => {
    owner = await h.makeUser('Owner')
    member = await h.makeUser('Member')
    guest = await h.makeUser('Guest')
    ws = await h.makeWorkspace(owner, [member], `WS ${word}`)
    other = await h.makeWorkspace(owner, [], `Other ${word}`)
    inboxId = (await mkPage(owner, inbox, { kind: 'folder' })).id
  })

  it('only owners and admins set it, in the browser; the page must be a shared, non-database page outside the instructions', async () => {
    assert.equal((await setDefault(member, inboxId)).statusCode, 403, 'a member')
    const api = (await createApiToken(owner.id, { name: 'script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
    assert.equal((await asToken(api, 'PUT', `/api/workspaces/${ws.id}/settings/agent-default-parent`, { pageId: inboxId })).statusCode, 403, 'an API token')
    // a guest with full access to the page is not a member
    await db.insert(schema.pageGrants).values({ pageId: inboxId, userId: guest.id, level: 'full', createdBy: owner.id })
    assert.equal((await setDefault(guest, inboxId)).statusCode, 403, 'a guest')
    const priv = await mkPage(owner, 'Mine', { scope: 'private' })
    assert.equal((await setDefault(owner, priv.id)).statusCode, 400, 'a private page')
    const coll = await mkPage(owner, 'Tasks db', { kind: 'collection' })
    assert.equal((await setDefault(owner, coll.id)).statusCode, 400, 'a database')
    const elsewhere = await asCookie(owner, 'POST', '/api/pages', { workspaceId: other.id, title: 'x' })
    assert.equal((await setDefault(owner, (elsewhere.json() as { page: PageMetaDTO }).page.id)).statusCode, 400, "another workspace's page")
    // an instruction page (locked first, as instruction pages must be) and a page under it
    const rules = await mkPage(owner, 'Rules')
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${rules.id}/lock`, { locked: true })).statusCode, 200)
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${rules.id}/agent-instructions`, { mode: 'always' })).statusCode, 200)
    const under = await mkPage(owner, 'Under rules', { parentId: rules.id })
    for (const id of [rules.id, under.id]) {
      const r = await setDefault(owner, id)
      assert.equal(r.statusCode, 400, r.body)
      assert.equal((r.json() as { error: { code: string } }).error.code, 'DEFAULT_PARENT_INSTRUCTIONS')
    }
    const ok = await setDefault(owner, inboxId)
    assert.equal(ok.statusCode, 200, ok.body)
    assert.deepEqual((ok.json() as { settings: WorkspaceSettingsDTO }).settings.agentDefaultParent, { id: inboxId, title: inbox })
    const wl = (await asCookie(member, 'GET', '/api/workspaces')).json() as { workspaces: { id: string; agentDefaultParentId?: string }[] }
    assert.equal(wl.workspaces.find((w) => w.id === ws.id)?.agentDefaultParentId, inboxId, 'members see which page it is')
    const audit = await db.select().from(schema.workspaceAuditEvents).where(eq(schema.workspaceAuditEvents.workspaceId, ws.id))
    assert.ok(audit.some((e) => e.action === 'settings.updated' && JSON.stringify(e.after).includes(inboxId)))
  })

  it('an agent that names no parent: every create tool goes under it and says so', async () => {
    const mcp = await h.connectMcp(app, member, await h.mintToken(member))
    const inboxShort = inboxId.slice(0, 8)
    // create_page (document, through the import route)
    const doc = await mcp.tool('create_page', { workspaceId: ws.id, title: `Report ${word}`, markdown: 'hello' })
    assert.equal(doc.isError, false, doc.text)
    const d = JSON.parse(doc.text) as { id: string; parentId: string; placed?: string }
    assert.equal(d.parentId, inboxId)
    assert.match(d.placed ?? '', new RegExp(`placed under "${inbox}" \\(${inboxShort}\\)`))
    // create_page kind folder (POST /pages)
    const folder = JSON.parse((await mcp.tool('create_page', { workspaceId: ws.id, title: 'Folder', kind: 'folder' })).text) as { parentId: string; placed?: string }
    assert.equal(folder.parentId, inboxId)
    assert.ok(folder.placed)
    // create_collection
    const coll = await mcp.tool('create_collection', { workspaceId: ws.id, title: 'Runs', fields: [] })
    assert.equal(coll.isError, false, coll.text)
    assert.match(coll.text, new RegExp(`under ${inboxId}`))
    assert.match(coll.text, /placed under "/)
    // create_from_template
    const tpl = await mcp.tool('create_from_template', { workspaceId: ws.id, template: 'meeting', title: 'Sync' })
    assert.equal(tpl.isError, false, tpl.text)
    const t = JSON.parse(tpl.text) as { id: string; placed?: string }
    assert.equal((await pageOf(t.id)).parentId, inboxId)
    assert.ok(t.placed)
    // import_folder
    const fold = JSON.parse((await mcp.tool('import_folder', { workspaceId: ws.id, folderName: 'Notes', files: [{ path: 'a.md', markdown: 'a' }] })).text) as {
      root: { id: string }
      placed?: string
    }
    assert.equal((await pageOf(fold.root.id)).parentId, inboxId)
    assert.ok(fold.placed)
    // import_zip
    const JSZip = (await import('jszip')).default
    const z = new JSZip()
    z.file('Zipped/one.md', '# one')
    const b64 = (await z.generateAsync({ type: 'nodebuffer' })).toString('base64')
    const zip = await mcp.tool('import_zip', { workspaceId: ws.id, base64: b64 })
    assert.equal(zip.isError, false, zip.text)
    assert.match(zip.text, /under the page below/)
    assert.match(zip.text, /placed under "/)
    const zipped = (await db.select().from(schema.pages).where(eq(schema.pages.title, 'Zipped')))[0]
    assert.equal(zipped.parentId, inboxId)
    // list_pages shows them under the page
    const list = await mcp.tool('list_pages', { workspaceId: ws.id, parentId: inboxId, format: 'json' })
    assert.ok(JSON.parse(list.text).pages.length >= 6, list.text)
  })

  it('a default only: a named parent, the private section and an explicit top level are left alone; people are never moved', async () => {
    const mcp = await h.connectMcp(app, member, await h.mintToken(member))
    const target = await mkPage(owner, 'Somewhere')
    const named = JSON.parse((await mcp.tool('create_page', { workspaceId: ws.id, title: 'Named', parentId: target.id })).text) as { parentId: string; placed?: string }
    assert.equal(named.parentId, target.id)
    assert.equal(named.placed, undefined)
    const priv = JSON.parse((await mcp.tool('create_page', { workspaceId: ws.id, title: 'Private note', private: true })).text) as { parentId: string | null; section: string; placed?: string }
    assert.equal(priv.parentId, null)
    assert.equal(priv.section, 'private')
    assert.equal(priv.placed, undefined)
    const privColl = await mcp.tool('create_collection', { workspaceId: ws.id, title: 'Private runs', fields: [], private: true })
    assert.doesNotMatch(privColl.text, /placed under/)
    // REST with a personal API token: absent parentId = default, `parentId: null` = top level on purpose
    const api = (await createApiToken(member.id, { name: 'script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
    const viaApi = await asToken(api, 'POST', '/api/pages', { workspaceId: ws.id, title: 'From a script' })
    assert.equal(viaApi.statusCode, 200, viaApi.body)
    const va = viaApi.json() as { page: PageMetaDTO; defaultParent?: { id: string; title: string } }
    assert.equal(va.page.parentId, inboxId)
    assert.deepEqual(va.defaultParent, { id: inboxId, title: inbox })
    const top = (await asToken(api, 'POST', '/api/pages', { workspaceId: ws.id, title: 'Top on purpose', parentId: null })).json() as {
      page: PageMetaDTO
      defaultParent?: unknown
    }
    assert.equal(top.page.parentId, null)
    assert.equal(top.defaultParent, undefined)
    // import with ?parentId=root
    const boundary = '----x'
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Top.md"\r\nContent-Type: text/markdown\r\n\r\n# x\r\n--${boundary}--\r\n`)
    const imp = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/import?parentId=root`,
      headers: { authorization: `Bearer ${api}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    assert.equal(imp.statusCode, 200, imp.body)
    assert.equal((imp.json() as { pages: PageMetaDTO[] }).pages[0].parentId, null)
    // a person in the browser: the top level as always
    const person = await mkPage(member, 'By hand')
    assert.equal(person.parentId, null)
  })

  it('not applied where the agent may not write or see: locked for agents, an instruction page above it, out of its range; nothing names the page', async () => {
    const mcp = await h.connectMcp(app, member, await h.mintToken(member))
    const noTitle = (s: string) => assert.ok(!s.includes(inbox) && !s.includes(inboxId.slice(0, 8)), s)
    // agents may only read under the page (lock with an agent rule)
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${inboxId}/lock`, { locked: true, agents: 'read' })).statusCode, 200)
    const locked = await mcp.tool('create_page', { workspaceId: ws.id, title: 'While locked', markdown: 'x' })
    assert.equal(locked.isError, false, locked.text)
    assert.equal((JSON.parse(locked.text) as { parentId: string | null }).parentId, null, 'top level, as before 0.26')
    noTitle(locked.text)
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${inboxId}/lock`, { locked: false })).statusCode, 200)
    // a subtree connection whose range does not hold the page: the top level stays refused, as before
    const elsewhere = await mkPage(owner, 'Elsewhere')
    const sub = (await createAgentToken(member, { name: `sub ${word}`, expiresInDays: 30, access: 'write', range: { kind: 'subtree', pageId: elsewhere.id } })).secret
    const subUser = (await getBearerUser(sub))!
    const subMcp = await h.connectMcp(app, subUser, sub)
    const out = await subMcp.tool('create_page', { workspaceId: ws.id, title: 'Out of range', markdown: 'x' })
    assert.equal(out.isError, true, out.text)
    noTitle(out.text)
    // a subtree connection whose range holds the page may use it
    const inSub = (await createAgentToken(member, { name: `in ${word}`, expiresInDays: 30, access: 'write', range: { kind: 'subtree', pageId: inboxId } })).secret
    const inMcp = await h.connectMcp(app, (await getBearerUser(inSub))!, inSub)
    const inside = await inMcp.tool('create_page', { workspaceId: ws.id, title: 'In range', markdown: 'x' })
    assert.equal(inside.isError, false, inside.text)
    assert.equal((JSON.parse(inside.text) as { parentId: string }).parentId, inboxId)
    // the page sits under a page that became an instruction page after it was chosen
    const parent = await mkPage(owner, 'Agent area')
    const child = await mkPage(owner, 'Drop here', { parentId: parent.id })
    assert.equal((await setDefault(owner, child.id)).statusCode, 200)
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${parent.id}/lock`, { locked: true })).statusCode, 200)
    assert.equal((await asCookie(owner, 'PUT', `/api/pages/${parent.id}/agent-instructions`, { mode: 'always' })).statusCode, 200)
    const api = (await createApiToken(owner.id, { name: 'owner script', expiresInDays: null, access: 'write', range: { kind: 'all' } })).secret
    const byOwner = (await asToken(api, 'POST', '/api/pages', { workspaceId: ws.id, title: 'Owner script page' })).json() as { page: PageMetaDTO; defaultParent?: unknown }
    assert.equal(byOwner.page.parentId, null, 'not under instructions, even for a token of someone who may edit there')
    assert.equal(byOwner.defaultParent, undefined)
    const byAgent = await mcp.tool('create_page', { workspaceId: ws.id, title: 'Agent page', markdown: 'x' })
    assert.equal((JSON.parse(byAgent.text) as { parentId: string | null }).parentId, null)
    assert.doesNotMatch(byAgent.text, /Drop here/)
    assert.equal((await setDefault(owner, inboxId)).statusCode, 200)
  })

  it('trashed counts as unset, restored applies again, purged clears the setting', async () => {
    const mcp = await h.connectMcp(app, member, await h.mintToken(member))
    const spot = await mkPage(owner, `Spot ${word}`)
    assert.equal((await setDefault(owner, spot.id)).statusCode, 200)
    assert.equal((await asCookie(owner, 'DELETE', `/api/pages/${spot.id}`)).statusCode, 204)
    assert.equal((await settings()).settings.agentDefaultParent, null)
    const wl = (await asCookie(owner, 'GET', '/api/workspaces')).json() as { workspaces: { id: string; agentDefaultParentId?: string }[] }
    assert.equal(wl.workspaces.find((w) => w.id === ws.id)?.agentDefaultParentId, undefined)
    const r1 = await mcp.tool('create_page', { workspaceId: ws.id, title: 'While trashed', markdown: 'x' })
    assert.equal((JSON.parse(r1.text) as { parentId: string | null }).parentId, null)
    assert.doesNotMatch(r1.text, /Spot/)
    assert.equal((await asCookie(owner, 'POST', `/api/pages/${spot.id}/restore`)).statusCode, 200)
    const r2 = await mcp.tool('create_page', { workspaceId: ws.id, title: 'After restore', markdown: 'x' })
    assert.equal((JSON.parse(r2.text) as { parentId: string }).parentId, spot.id)
    assert.equal((await asCookie(owner, 'DELETE', `/api/pages/${spot.id}`)).statusCode, 204)
    assert.equal((await asCookie(owner, 'DELETE', `/api/pages/${spot.id}/purge`)).statusCode, 204)
    const [row] = await db.select({ p: schema.workspaces.agentDefaultParentId }).from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
    assert.equal(row.p, null, 'on delete set null')
    // unset by hand
    assert.equal((await setDefault(owner, inboxId)).statusCode, 200)
    const unset = await setDefault(owner, null)
    assert.equal(unset.statusCode, 200)
    assert.equal((unset.json() as { settings: WorkspaceSettingsDTO }).settings.agentDefaultParent, null)
    // deleting a workspace whose setting points at one of its pages works (the two foreign keys)
    const gone = await h.makeWorkspace(owner, [])
    const g = await asCookie(owner, 'POST', '/api/pages', { workspaceId: gone.id, title: 'g' })
    await setDefault(owner, (g.json() as { page: PageMetaDTO }).page.id, gone.id)
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, gone.id))
  })
})
