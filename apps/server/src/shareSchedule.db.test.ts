// Scheduled public links (docs/adr/1844-*): a link with a start time answers exactly like a token
// that is not shared (404 NOT_FOUND, same body, plain shell) on every public route until the start,
// without counting the visits as token guesses; inside the window it is an ordinary link; after the
// expiry it answers 410 SHARE_EXPIRED as before (docs/adr/1170-*). The owner side validates the
// window, audits changes, lists the start, and unpublishing clears it.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-shareschedule-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR = DATA
process.env.WEB_DIST = path.join(DATA, 'web')
// A low ban threshold: if not-started visits counted as guesses, the scenario's IP would be banned.
process.env.AUTH_GUARD_MAX_FAILURES = '4'
mkdirSync(path.join(DATA, 'web'), { recursive: true })
mkdirSync(path.join(DATA, 'uploads'), { recursive: true })
writeFileSync(path.join(DATA, 'web', 'index.html'), '<!doctype html><html><head><title>Inkling</title></head><body></body></html>')

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] scheduled public links (start and expiry)', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const { AppError } = await import('./errors')
  const { guardHook } = await import('./guard')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter))
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  app.addHook('onRequest', guardHook)
  await app.register(
    async (api) => {
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
    },
    { prefix: '/api' },
  )
  await (await import('./routes/shareMeta')).registerShareMetaRoutes(app)
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  let ipSeq = 10
  const newIp = () => `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
  const member = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const visit = (url: string, ip = '10.2.2.2') => app.inject({ method: 'GET', url, remoteAddress: ip })
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

  async function setup() {
    const owner = await h.makeUser('owner')
    const ws = await h.makeWorkspace(owner)
    const fileFor = () => {
      const id = randomUUID()
      writeFileSync(path.join(DATA, 'uploads', id), Buffer.from('89504e470d0a1a0a', 'hex'))
      return id
    }
    const docFile = fileFor()
    const doc = await h.makeDocPage(ws.id, owner.id, 'Launch announcement', [para('embargoed until launch')], { coverUrl: `/files/${docFile}` })
    await db.insert(schema.files).values({ id: docFile, workspaceId: ws.id, pageId: doc.id, name: 'c.png', mime: 'image/png', size: 8 })
    const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Press kit', kind: 'folder', createdBy: owner.id }).returning()
    const childFile = fileFor()
    const child = await h.makeDocPage(ws.id, owner.id, 'Press release', [para('child body')], { parentId: folder.id, coverUrl: `/files/${childFile}` })
    await db.insert(schema.files).values({ id: childFile, workspaceId: ws.id, pageId: child.id, name: 'd.png', mime: 'image/png', size: 8 })
    return { owner, ws, doc, docFile, folder, child, childFile }
  }

  /** Every public path of an open doc link and folder link (the folder ref is read while open). */
  async function paths(s: Awaited<ReturnType<typeof setup>>, docToken: string, folderToken: string) {
    const f = await visit(`/api/public/${folderToken}`)
    assert.equal(f.statusCode, 200, f.body)
    const ref = (f.json() as { tree: { ref: string }[] }).tree[0].ref
    return {
      json: [
        `/api/public/${docToken}`,
        `/api/public/${docToken}/f/${s.docFile}`,
        `/api/public/${folderToken}`,
        `/api/public/${folderToken}/p/${ref}`,
        `/api/public/${folderToken}/p/${ref}/f/${s.childFile}`,
      ],
      html: [`/s/${docToken}`, `/s/${folderToken}`, `/s/${folderToken}/p/${ref}`],
    }
  }

  const setWindow = (pageId: string, startsAt: Date | null, expiresAt: Date | null) =>
    db.update(schema.pages).set({ shareStartsAt: startsAt, shareExpiresAt: expiresAt }).where(eq(schema.pages.id, pageId))

  it('before the start: every route answers like an unshared token, uncounted; in the window: open; after the expiry: 410', async () => {
    const s = await setup()
    const d = (await member(s.owner, 'POST', `/pages/${s.doc.id}/share`)).json() as { token: string }
    const f = (await member(s.owner, 'POST', `/pages/${s.folder.id}/share`)).json() as { token: string }
    const p = await paths(s, d.token, f.token)

    // An unknown token's answer, to compare bodies with.
    const unknown = await visit(`/api/public/${randomBytes(24).toString('base64url')}`, newIp())
    assert.equal(unknown.statusCode, 404)

    // Schedule both links to open tomorrow.
    for (const id of [s.doc.id, s.folder.id]) {
      const r = await member(s.owner, 'PATCH', `/pages/${id}/share`, { startsAt: inHours(24) })
      assert.equal(r.statusCode, 200, r.body)
      const dto = r.json() as { startsAt: string | null; notStarted: boolean; expired: boolean }
      assert.equal(dto.notStarted, true)
      assert.equal(dto.expired, false)
      assert.ok(dto.startsAt)
    }
    // One IP visits every route more times than the ban threshold: never banned, never anything about the page.
    const ip = newIp()
    for (let round = 0; round < 2; round++) {
      for (const url of p.json) {
        const r = await visit(url, ip)
        assert.equal(r.statusCode, 404, url)
        assert.equal(r.body, unknown.body, url)
        assert.equal(r.headers['cache-control'], 'no-store', url)
        assert.doesNotMatch(r.body, /Launch|Press|embargoed/)
      }
    }
    // The unfurl shell is the plain one (no title, no robots line that would tell it apart).
    for (const url of p.html) {
      const r = await visit(url, ip)
      assert.equal(r.statusCode, 200)
      assert.doesNotMatch(r.body, /og:|Launch|Press|noindex/, url)
      assert.match(r.body, /<title>Inkling<\/title>/)
    }
    // Unlock before the start: the unknown-link answer too.
    const un = await app.inject({ method: 'POST', url: `/api/public/${d.token}/unlock`, payload: { password: 'whatever' }, remoteAddress: ip })
    assert.equal(un.statusCode, 404)

    // In the window (start passed, expiry ahead): ordinary open links, from the same IP (not banned).
    for (const id of [s.doc.id, s.folder.id]) await setWindow(id, new Date(Date.now() - 60_000), new Date(Date.now() + 3_600_000))
    for (const url of p.json) assert.equal((await visit(url, ip)).statusCode, 200, url)
    assert.match((await visit(p.html[0], ip)).body, /Launch announcement/)

    // After the expiry: 410 SHARE_EXPIRED as before (docs/adr/1170-*).
    for (const id of [s.doc.id, s.folder.id]) await setWindow(id, new Date(Date.now() - 7_200_000), new Date(Date.now() - 60_000))
    for (const url of p.json) {
      const r = await visit(url, ip)
      assert.equal(r.statusCode, 410, url)
      assert.equal(r.json().error.code, 'SHARE_EXPIRED')
    }
    const st = (await member(s.owner, 'GET', `/pages/${s.doc.id}/share`)).json() as { expired: boolean; notStarted: boolean }
    assert.equal(st.expired, true)
    assert.equal(st.notStarted, false)
  })

  it('publishing with a start, validation, audit, list and unpublish', async () => {
    const s = await setup()
    // the start must come before the expiry
    const bad = await member(s.owner, 'POST', `/pages/${s.doc.id}/share`, { startsAt: inHours(48), expiresAt: inHours(24) })
    assert.equal(bad.statusCode, 400, bad.body)
    const ok = await member(s.owner, 'POST', `/pages/${s.doc.id}/share`, { startsAt: inHours(2), expiresInDays: 7 })
    assert.equal(ok.statusCode, 200, ok.body)
    const dto = ok.json() as { token: string; startsAt: string; notStarted: boolean; expiresAt: string }
    assert.equal(dto.notStarted, true)
    assert.ok(new Date(dto.startsAt).getTime() < new Date(dto.expiresAt).getTime())
    assert.equal((await visit(`/api/public/${dto.token}`, newIp())).statusCode, 404)

    // moving the expiry before the start is refused; removing the start opens the link at once
    const clash = await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { expiresAt: inHours(1) })
    assert.equal(clash.statusCode, 400, clash.body)
    const open = await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { startsAt: null })
    assert.equal(open.statusCode, 200, open.body)
    assert.equal(open.json().notStarted, false)
    assert.equal(open.json().startsAt, null)
    assert.equal((await visit(`/api/public/${dto.token}`, newIp())).statusCode, 200)
    // a start in the past is "at once"
    const past = await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { startsAt: inHours(-3) })
    assert.equal(past.json().startsAt, null)

    const audit = (await db.execute(sql`
      SELECT action, before, after FROM workspace_audit_events WHERE workspace_id = ${s.ws.id} ORDER BY id
    `)) as unknown as { action: string; before: { startsAt?: string | null } | null; after: { startsAt?: string | null } | null }[]
    const published = audit.find((a) => a.action === 'share.published')
    assert.ok(published?.after?.startsAt, 'published records the start')
    const changes = audit.filter((a) => a.action === 'share.start_changed')
    assert.equal(changes.length, 1, 'only the real change is audited (a past start equals none)')
    assert.equal(changes[0].after?.startsAt, null)

    // the workspace list carries the start; unpublishing clears it with the token
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { startsAt: inHours(5) })
    const list = (await member(s.owner, 'GET', `/workspaces/${s.ws.id}/shared`)).json() as { items: { id: string; startsAt: string | null; notStarted: boolean }[] }
    const row = list.items.find((i) => i.id === s.doc.id)
    assert.ok(row?.startsAt)
    assert.equal(row?.notStarted, true)
    assert.equal((await member(s.owner, 'DELETE', `/pages/${s.doc.id}/share`)).statusCode, 200)
    const [after] = await db
      .select({ starts: schema.pages.shareStartsAt, expires: schema.pages.shareExpiresAt })
      .from(schema.pages)
      .where(and(eq(schema.pages.id, s.doc.id)))
    assert.equal(after.starts, null)
    assert.equal(after.expires, null)
  })
})
