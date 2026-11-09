// Access leaks closed in the 0.10 security pass (docs/adr/1300-*, 1301-*):
//   - "require two-step verification" (docs/adr/1112-*) also closes the cross-workspace reads
//     (agent inbox, find_context without a workspace, read_pages);
//   - someone outside a workspace gets the same answer for its pages, change rows, templates, files
//     and comment threads as for ids that do not exist (no 403, no TWO_FACTOR_REQUIRED, same text);
//   - deleting a comment needs the COMMENT bit like editing it (edit lock, docs/adr/0970-*, 0971-*);
//   - a public link serves only files of pages inside what it shares.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-accessleaks-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR = DATA
mkdirSync(path.join(DATA, 'uploads'), { recursive: true })

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] access leaks: 2FA on cross-workspace reads, existence oracles, comment delete lock, public file scope', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { sql } = await import('drizzle-orm')
  const { reindexPageChunks } = await import('./context/chunkIndex')
  const { AppError } = await import('./errors')
  const { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('./oauth')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = await h.buildTestApp()
  // Files and public links are not in the shared harness app.
  const app2 = Fastify()
  await app2.register(import('@fastify/cookie'))
  await app2.register(import('@fastify/multipart'))
  app2.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app2.register(
    async (api) => {
      await (await import('./routes/files')).registerFileRoutes(api)
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
      await (await import('./routes/webhooks')).registerWebhookRoutes(api)
      await (await import('./routes/sync')).registerSyncRoutes(api)
      await (await import('./routes/notificationSettings')).registerNotificationSettingsRoutes(api)
    },
    { prefix: '/api' },
  )
  await (await import('./routes/files')).registerFileDownloadRoute(app2)
  await app2.ready()

  after(async () => {
    await app.close()
    await app2.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  const req = (u: U, method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  // An agent request as the MCP tools send it (call() in mcpTools/core.ts).
  const bearer = (token: string, method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: { authorization: `Bearer ${token}`, [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const enable2fa = (u: { id: string }) =>
    db.insert(schema.userTotp).values({ userId: u.id, secretEnc: 'x', enabledAt: new Date() }).onConflictDoNothing()
  /** Requirement on, grace period over: members without 2FA are blocked now. */
  const require2fa = (wsId: string) =>
    db.execute(sql`UPDATE workspaces SET two_factor_required_at = now() - interval '1 day', two_factor_grace_days = 0 WHERE id = ${wsId}`)
  const errorOf = (r: { statusCode: number; json: () => unknown }) => ({ status: r.statusCode, body: r.json() })
  const fileOnDisk = () => {
    const id = randomUUID()
    writeFileSync(path.join(DATA, 'uploads', id), Buffer.from('89504e470d0a1a0a', 'hex'))
    return id
  }

  it('two-step verification also closes the agent inbox, find_context and read_pages across workspaces', async () => {
    const owner = await h.makeUser('tfx-owner')
    const member = await h.makeUser('tfx-member')
    await enable2fa(owner)
    const ws = await h.makeWorkspace(owner, [member])
    const blocks = [para('Zebracornix launch plan for the quarter')]
    const page = await h.makeDocPage(ws.id, owner.id, 'Zebracornix plans', blocks)
    await reindexPageChunks(page.id, blocks)
    await db.insert(schema.notifications).values({ userId: member.id, type: 'comment_mention', pageId: page.id, workspaceId: ws.id, actorId: owner.id } as never)

    const inboxPages = async () =>
      ((await req(member, 'GET', '/inbox')).json() as { items: { pageId: string | null }[] }).items.map((i) => i.pageId)
    const readPages = async () => (await req(member, 'GET', `/pages/read?ids=${page.id}`)).json() as { pages: { id: string }[]; missing: string[] }
    const contextPages = async () =>
      ((await req(member, 'GET', '/context?q=Zebracornix')).json() as { fragments: { pageId: string }[]; titleOnly: { pageId: string }[] }).fragments.map((f) => f.pageId)

    // not required yet: everything is there
    assert.ok((await inboxPages()).includes(page.id))
    assert.deepEqual((await readPages()).pages.map((p) => p.id), [page.id])
    assert.ok((await contextPages()).includes(page.id))

    await require2fa(ws.id)
    // the workspace-scoped forms already refused (docs/adr/1112-*)
    assert.equal((await req(member, 'GET', `/inbox?workspaceId=${ws.id}`)).json().error.code, 'TWO_FACTOR_REQUIRED')
    // the cross-workspace forms leave the blocked workspace out
    assert.ok(!(await inboxPages()).includes(page.id), 'inbox without workspaceId')
    const rp = await readPages()
    assert.deepEqual(rp.pages, [], 'read_pages')
    assert.deepEqual(rp.missing, [page.id])
    assert.ok(!(await contextPages()).includes(page.id), 'find_context without workspaceId')

    // turning 2FA on brings them back
    await enable2fa(member)
    assert.ok((await inboxPages()).includes(page.id))
    assert.deepEqual((await readPages()).pages.map((p) => p.id), [page.id])
  })

  it('outsiders get the same 404 for a page as for a missing id, with or without a 2FA requirement', async () => {
    const owner = await h.makeUser('fvp-owner')
    const member = await h.makeUser('fvp-member')
    const outsider = await h.makeUser('fvp-outsider')
    await enable2fa(owner)
    const ws = await h.makeWorkspace(owner, [member])
    const page = await h.makeDocPage(ws.id, owner.id, 'Existence probe', [para('x')])
    const missing = errorOf(await req(outsider, 'GET', `/pages/${randomUUID()}/outline`))
    assert.equal(missing.status, 404)

    for (const route of ['outline', 'comments', 'snapshots']) {
      assert.deepEqual(errorOf(await req(outsider, 'GET', `/pages/${page.id}/${route}`)), missing, `${route}, no requirement`)
    }
    await require2fa(ws.id)
    for (const route of ['outline', 'comments', 'snapshots']) {
      assert.deepEqual(errorOf(await req(outsider, 'GET', `/pages/${page.id}/${route}`)), missing, `${route}, 2FA required`)
    }
    // a member is still told why (they can fix it)
    const blocked = await req(member, 'GET', `/pages/${page.id}/outline`)
    assert.equal(blocked.statusCode, 403)
    assert.equal(blocked.json().error.code, 'TWO_FACTOR_REQUIRED')
    assert.equal((await req(owner, 'GET', `/pages/${page.id}/outline`)).statusCode, 200)
  })

  it('records looked up before the permission check answer outsiders like missing ones', async () => {
    const owner = await h.makeUser('orc-owner')
    const outsider = await h.makeUser('orc-outsider')
    const ws = await h.makeWorkspace(owner)
    const page = await h.makeDocPage(ws.id, owner.id, 'Oracle page', [para('y')])

    // change rows (activity diff)
    const [change] = await db
      .insert(schema.pageChanges)
      .values({ workspaceId: ws.id, pageId: page.id, kind: 'modified', scope: 'shared', beforeText: 'a', afterText: 'b', actorId: owner.id })
      .returning({ seq: schema.pageChanges.seq })
    assert.equal((await req(owner, 'GET', `/changes/${change.seq}/diff`)).statusCode, 200)
    assert.deepEqual(errorOf(await req(outsider, 'GET', `/changes/${change.seq}/diff`)), errorOf(await req(outsider, 'GET', '/changes/999999999999/diff')))

    // templates
    const [tpl] = await db.insert(schema.templates).values({ workspaceId: ws.id, name: 'Shared tpl', createdBy: owner.id }).returning({ id: schema.templates.id })
    const tplMissing = errorOf(await req(outsider, 'DELETE', `/templates/${randomUUID()}`))
    assert.equal(tplMissing.status, 404)
    assert.deepEqual(errorOf(await req(outsider, 'DELETE', `/templates/${tpl.id}`)), tplMissing)

    // files
    const fileId = fileOnDisk()
    await db.insert(schema.files).values({ id: fileId, workspaceId: ws.id, pageId: page.id, name: 'a.png', mime: 'image/png', size: 8 })
    const legacyId = fileOnDisk()
    await db.insert(schema.files).values({ id: legacyId, workspaceId: ws.id, pageId: null, name: 'b.png', mime: 'image/png', size: 8 })
    const getFile = (u: U, id: string) => app2.inject({ method: 'GET', url: `/files/${id}`, headers: { cookie: u.cookie } })
    assert.equal((await getFile(owner, fileId)).statusCode, 200)
    const fileMissing = errorOf(await getFile(outsider, randomUUID()))
    assert.equal(fileMissing.status, 404)
    assert.deepEqual(errorOf(await getFile(outsider, fileId)), fileMissing)
    assert.deepEqual(errorOf(await getFile(outsider, legacyId)), fileMissing)

    // comment threads through the agent tools
    const threadId = randomUUID()
    await db.insert(schema.comments).values({ id: threadId, threadId, pageId: page.id, blockId: 'b1', authorId: owner.id, body: 'root' })
    const agent = await h.connectMcp(app, { ...outsider, via: 'Test Agent' }, await h.mintToken(outsider))
    try {
      const none = await agent.tool('reply_comment', { threadId: randomUUID(), text: 'hi' })
      const real = await agent.tool('reply_comment', { threadId, text: 'hi' })
      assert.equal(none.isError, true)
      assert.deepEqual(real, none)
      const noneR = await agent.tool('resolve_comment', { threadId: randomUUID() })
      const realR = await agent.tool('resolve_comment', { threadId })
      assert.equal(noneR.isError, true)
      assert.deepEqual(realR, noneR)
    } finally {
      await agent.close()
    }
    // and the REST routes behind them
    const comMissing = errorOf(await req(outsider, 'DELETE', `/comments/${randomUUID()}`))
    assert.equal(comMissing.status, 404)
    assert.deepEqual(errorOf(await req(outsider, 'DELETE', `/comments/${threadId}`)), comMissing)
    assert.deepEqual(errorOf(await req(outsider, 'PATCH', `/comments/${threadId}`, { resolved: true })), errorOf(await req(outsider, 'PATCH', `/comments/${randomUUID()}`, { resolved: true })))
  })

  it('deleting a comment needs the comment right, like editing it (agents: read lock)', async () => {
    const owner = await h.makeUser('cdl-owner')
    const member = await h.makeUser('cdl-member')
    const ws = await h.makeWorkspace(owner, [member])
    const page = await h.makeDocPage(ws.id, owner.id, 'Locked for agents', [para('z')])
    const mk = async () => {
      const id = randomUUID()
      await db.insert(schema.comments).values({ id, threadId: id, pageId: page.id, blockId: 'b1', authorId: member.id, body: 'mine' })
      return id
    }
    const c1 = await mk()
    const c2 = await mk()
    assert.equal((await req(owner, 'PUT', `/pages/${page.id}/lock`, { locked: true, people: 'everyone', agents: 'read' })).statusCode, 200)
    const token = await h.mintToken(member)
    // the agent of the comment's author may neither edit nor delete it under an agents: read lock
    assert.equal((await bearer(token, 'PATCH', `/comments/${c1}`, { body: 'changed' })).statusCode, 403)
    const del = await bearer(token, 'DELETE', `/comments/${c1}`)
    assert.equal(del.statusCode, 403, del.body)
    assert.equal(del.json().error.code, 'PAGE_LOCKED')
    assert.equal((await db.select().from(schema.comments).where(sql`id = ${c1}`)).length, 1)
    // the person keeps the comment right (people: everyone)
    assert.equal((await req(member, 'DELETE', `/comments/${c2}`)).statusCode, 204)
  })

  it('two-step verification also covers agent context, workspace notifications, member candidates, subscriptions and workspace delete/restore', async () => {
    const owner = await h.makeUser('tfy-owner')
    const member = await h.makeUser('tfy-member')
    const zed = await h.makeUser('Zedblockedperson')
    await enable2fa(owner)
    await enable2fa(zed)
    const ws = await h.makeWorkspace(owner, [member, zed])
    const page = await h.makeDocPage(ws.id, owner.id, 'Blocked title Quokka', [para('q')])
    // the member's own workspace without a requirement (they own it, so they may add people)
    const mine = await h.makeWorkspace(member)
    await db.insert(schema.notifications).values({ userId: member.id, workspaceId: ws.id, type: 'agent_digest', excerpt: 'AI edits: Blocked title Quokka' } as never)
    await db.insert(schema.notificationPrefs).values({ userId: member.id, workspaceId: ws.id, rootPageId: page.id, level: 'all' })
    const ctxIds = async () => ((await req(member, 'GET', `/pages/agent-context?ids=${page.id}`)).json() as { pages: { id: string }[] }).pages.map((p) => p.id)
    const notifText = async () => (await req(member, 'GET', '/notifications')).body
    const candidates = async () =>
      ((await req(member, 'GET', `/workspaces/${mine.id}/member-candidates?q=Zedblocked`)).json() as { candidates: { id: string }[] }).candidates.map((c) => c.id)
    const subs = async () => (await app2.inject({ method: 'GET', url: '/api/me/notification-settings', headers: { cookie: member.cookie } })).body
    assert.deepEqual(await ctxIds(), [page.id])
    assert.match(await notifText(), /Quokka/)
    assert.deepEqual(await candidates(), [zed.id])
    assert.match(await subs(), /Quokka/)

    await require2fa(ws.id)
    assert.deepEqual(await ctxIds(), [], 'agent-context')
    assert.doesNotMatch(await notifText(), /Quokka/, 'workspace-level notification')
    assert.deepEqual(await candidates(), [], 'member candidates found through the blocked workspace')
    assert.doesNotMatch(await subs(), /Quokka/, 'subscriptions')

    // an owner blocked by the requirement can neither delete nor restore the workspace
    const owner2 = await h.makeUser('tfy-owner2')
    const ws2 = await h.makeWorkspace(owner2)
    await require2fa(ws2.id)
    const del = await req(owner2, 'DELETE', `/workspaces/${ws2.id}`, { name: ws2.name })
    assert.equal(del.statusCode, 403, del.body)
    assert.equal(del.json().error.code, 'TWO_FACTOR_REQUIRED')
    await db.execute(sql`UPDATE workspaces SET deleted_at = now() WHERE id = ${ws2.id}`)
    const res = await req(owner2, 'POST', `/workspaces/${ws2.id}/restore`)
    assert.equal(res.statusCode, 403, res.body)
    assert.equal(res.json().error.code, 'TWO_FACTOR_REQUIRED')
    await enable2fa(owner2)
    assert.equal((await req(owner2, 'POST', `/workspaces/${ws2.id}/restore`)).statusCode, 200)
  })

  it('webhooks, trash, vault sync and moves answer outsiders like missing ids', async () => {
    const owner = await h.makeUser('orc2-owner')
    const outsider = await h.makeUser('orc2-outsider')
    const ws = await h.makeWorkspace(owner)
    const as2 = (u: U, method: Method, url: string, payload?: unknown) =>
      app2.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
    const same = async (method: Method, real: string, fake: string, payload?: unknown, via = as2) => {
      const a = errorOf(await via(outsider, method, real, payload))
      const b = errorOf(await via(outsider, method, fake, payload))
      assert.equal(b.status, 404, `${method} ${fake}`)
      assert.deepEqual(a, b, `${method} ${real}`)
    }
    const [hook] = await db.insert(schema.workspaceWebhooks).values({ workspaceId: ws.id, kind: 'generic', url: 'https://example.com/hook' }).returning({ id: schema.workspaceWebhooks.id })
    await same('DELETE', `/webhooks/${hook.id}`, `/webhooks/${randomUUID()}`)
    await same('PATCH', `/webhooks/${hook.id}`, `/webhooks/${randomUUID()}`, { enabled: false })

    const trashed = await h.makeDocPage(ws.id, owner.id, 'Trashed', [para('t')], { deletedAt: new Date() })
    await same('POST', `/pages/${trashed.id}/restore`, `/pages/${randomUUID()}/restore`)
    await same('DELETE', `/pages/${trashed.id}/purge`, `/pages/${randomUUID()}/purge`)

    const live = await h.makeDocPage(ws.id, owner.id, 'Synced', [para('s')])
    await same('PUT', `/pages/${live.id}/sync/md`, `/pages/${randomUUID()}/sync/md`, { markdown: 'x', expectedRevision: 'r1' })
    await same('DELETE', `/pages/${live.id}/sync`, `/pages/${randomUUID()}/sync`)

    // moving one's own page under another workspace's page: the same 400 as for a missing parent
    const home = await h.makeWorkspace(outsider)
    const own = await h.makeDocPage(home.id, outsider.id, 'Mine', [para('m')])
    const a = errorOf(await req(outsider, 'PATCH', `/pages/${own.id}`, { parentId: live.id }))
    const b = errorOf(await req(outsider, 'PATCH', `/pages/${own.id}`, { parentId: randomUUID() }))
    assert.equal(b.status, 400)
    assert.deepEqual(a, b)
  })

  it('public links serve only files of pages inside what they share', async () => {
    const owner = await h.makeUser('pub-owner')
    const ws = await h.makeWorkspace(owner)
    const ownerReq = (method: Method, url: string, payload?: unknown) =>
      app2.inject({ method, url: `/api${url}`, headers: { cookie: owner.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
    const image = (fileId: string) => ({ type: 'image', props: { url: `/files/${fileId}` } })

    // a shared page outside every link, with an attachment of its own
    const outside = await h.makeDocPage(ws.id, owner.id, 'Outside page', [para('not shared')])
    const outsideFile = fileOnDisk()
    await db.insert(schema.files).values({ id: outsideFile, workspaceId: ws.id, pageId: outside.id, name: 'o.png', mime: 'image/png', size: 8 })

    // folder link: a child page that embeds its own file and the outside page's file
    const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Shared folder', kind: 'folder', createdBy: owner.id }).returning()
    const childFile = fileOnDisk()
    const child = await h.makeDocPage(ws.id, owner.id, 'Child', [image(childFile), image(outsideFile)], { parentId: folder.id })
    await db.insert(schema.files).values({ id: childFile, workspaceId: ws.id, pageId: child.id, name: 'c.png', mime: 'image/png', size: 8 })
    const fShare = await ownerReq('POST', `/pages/${folder.id}/share`)
    assert.equal(fShare.statusCode, 200, fShare.body)
    const fToken = fShare.json().token as string
    const tree = await app2.inject({ method: 'GET', url: `/api/public/${fToken}` })
    assert.equal(tree.statusCode, 200, tree.body)
    const ref = (tree.json() as { tree: { ref: string }[] }).tree[0].ref
    assert.equal((await app2.inject({ method: 'GET', url: `/api/public/${fToken}/p/${ref}/f/${childFile}` })).statusCode, 200)
    assert.equal((await app2.inject({ method: 'GET', url: `/api/public/${fToken}/p/${ref}/f/${outsideFile}` })).statusCode, 404)

    // single-page link: the same rule
    const docFile = fileOnDisk()
    const doc = await h.makeDocPage(ws.id, owner.id, 'Shared doc', [image(docFile), image(outsideFile)])
    await db.insert(schema.files).values({ id: docFile, workspaceId: ws.id, pageId: doc.id, name: 'd.png', mime: 'image/png', size: 8 })
    const dShare = await ownerReq('POST', `/pages/${doc.id}/share`)
    assert.equal(dShare.statusCode, 200, dShare.body)
    const dToken = dShare.json().token as string
    assert.equal((await app2.inject({ method: 'GET', url: `/api/public/${dToken}/f/${docFile}` })).statusCode, 200)
    assert.equal((await app2.inject({ method: 'GET', url: `/api/public/${dToken}/f/${outsideFile}` })).statusCode, 404)
  })
})
