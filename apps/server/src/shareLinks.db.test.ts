// Public link expiry, passwords and the workspace rules for new links (docs/adr/1170-*, 1171-*,
// 1172-*): every public route (JSON pages, files, folder children and their files) and the unfurl
// shell are closed by an expired link or a missing unlock; the unlock cookie is scoped to its link
// and dies with a password change; wrong passwords are throttled per link and per IP and answered
// no faster than the floor; nothing about a gated page leaks into meta tags; audit rows never hold
// the password.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DATA = `${process.env.TMPDIR || '/tmp'}/inkling-sharelinks-${process.pid}`
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR = DATA
process.env.WEB_DIST = path.join(DATA, 'web')
// Per-link backoff after 3 wrong passwords; IP ban after 6 failures (each scenario uses its own IP).
process.env.AUTH_GUARD_ACCOUNT_FAILURES = '3'
process.env.AUTH_GUARD_MAX_FAILURES = '6'
mkdirSync(path.join(DATA, 'web'), { recursive: true })
mkdirSync(path.join(DATA, 'uploads'), { recursive: true })
writeFileSync(path.join(DATA, 'web', 'index.html'), '<!doctype html><html><head><title>Inkling</title></head><body></body></html>')

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] public link expiry and password', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const { AppError } = await import('./errors')
  const { guardHook } = await import('./guard')
  const { SHARE_UNLOCK_COOKIE, SHARE_UNLOCK_FLOOR_MS } = await import('./shareAccess')
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
  /** A fresh client address per scenario, so failure counters never cross scenarios. */
  const newIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`
  const member = (u: U, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const visit = (url: string, opts: { cookie?: string; ip?: string } = {}) =>
    app.inject({ method: 'GET', url, headers: opts.cookie ? { cookie: opts.cookie } : {}, remoteAddress: opts.ip ?? '10.1.1.1' })
  const unlock = (token: string, password: string, ip: string) =>
    app.inject({ method: 'POST', url: `/api/public/${token}/unlock`, payload: { password }, remoteAddress: ip })
  /** `name=value` of the unlock cookie in a response, plus its attributes. */
  const unlockCookie = (res: Awaited<ReturnType<typeof app.inject>>) => {
    const c = res.cookies.find((x) => x.name === SHARE_UNLOCK_COOKIE)
    assert.ok(c, 'unlock cookie set')
    return { pair: `${c.name}=${c.value}`, c }
  }

  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] })

  /** Owner, workspace, a doc with a cover file, a folder with one child doc (with its own cover file). */
  async function setup() {
    const owner = await h.makeUser('owner')
    const ws = await h.makeWorkspace(owner)
    const fileFor = async (pageName: string) => {
      const id = randomUUID()
      writeFileSync(path.join(DATA, 'uploads', id), Buffer.from('89504e470d0a1a0a', 'hex'))
      return { id, pageName }
    }
    const docFile = await fileFor('doc')
    const doc = await h.makeDocPage(ws.id, owner.id, 'Quarterly secret plan', [para('the body nobody may read')], {
      coverUrl: `/files/${docFile.id}`,
    })
    await db.insert(schema.files).values({ id: docFile.id, workspaceId: ws.id, pageId: doc.id, name: 'c.png', mime: 'image/png', size: 8 })
    await db.insert(schema.pageTexts).values({ pageId: doc.id, text: 'the body nobody may read' }).onConflictDoNothing()
    const [folder] = await db.insert(schema.pages).values({ workspaceId: ws.id, title: 'Board folder', kind: 'folder', createdBy: owner.id }).returning()
    const childFile = await fileFor('child')
    const child = await h.makeDocPage(ws.id, owner.id, 'Child minutes', [para('child body')], {
      parentId: folder.id,
      coverUrl: `/files/${childFile.id}`,
    })
    await db.insert(schema.files).values({ id: childFile.id, workspaceId: ws.id, pageId: child.id, name: 'd.png', mime: 'image/png', size: 8 })
    return { owner, ws, doc, docFile, folder, child, childFile }
  }

  async function publish(u: U, pageId: string, body?: unknown) {
    const res = await member(u, 'POST', `/pages/${pageId}/share`, body)
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as { token: string; expiresAt: string | null; expired: boolean; hasPassword: boolean; policy: { defaultExpiryDays: number | null; passwordRequired: boolean } }
  }

  /** Paths of every public route for the doc and folder links, resolved while they are open. */
  async function allPaths(s: Awaited<ReturnType<typeof setup>>, docToken: string, folderToken: string, cookieFolder?: string) {
    const folderRes = await visit(`/api/public/${folderToken}`, { cookie: cookieFolder })
    assert.equal(folderRes.statusCode, 200, folderRes.body)
    const ref = (folderRes.json() as { tree: { ref: string }[] }).tree[0].ref
    return {
      doc: [`/api/public/${docToken}`, `/api/public/${docToken}/f/${s.docFile.id}`],
      folder: [
        `/api/public/${folderToken}`,
        `/api/public/${folderToken}/p/${ref}`,
        `/api/public/${folderToken}/p/${ref}/f/${s.childFile.id}`,
      ],
      html: [`/s/${docToken}`, `/s/${folderToken}`, `/s/${folderToken}/p/${ref}`],
    }
  }

  it('open links behave as before; a password closes every JSON route and the shell says nothing', async () => {
    const s = await setup()
    const d = await publish(s.owner, s.doc.id)
    const f = await publish(s.owner, s.folder.id)
    assert.equal(d.expiresAt, null)
    assert.equal(d.hasPassword, false)
    const paths = await allPaths(s, d.token, f.token)
    for (const p of [...paths.doc, ...paths.folder]) assert.equal((await visit(p)).statusCode, 200, p)
    const shell = await visit(paths.html[0])
    assert.match(shell.body, /Quarterly secret plan/)
    assert.equal(shell.headers['x-robots-tag'], undefined)
    // Files of open links stay publicly cacheable for five minutes, as before.
    assert.equal((await visit(paths.doc[1])).headers['cache-control'], 'public, max-age=300')

    for (const id of [s.doc.id, s.folder.id]) {
      const r = await member(s.owner, 'PATCH', `/pages/${id}/share`, { password: 'correct horse' })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().hasPassword, true)
      assert.doesNotMatch(r.body, /argon2|correct horse/)
    }
    for (const p of [...paths.doc, ...paths.folder]) {
      const r = await visit(p)
      assert.equal(r.statusCode, 401, p)
      assert.equal(r.json().error.code, 'SHARE_PASSWORD_REQUIRED')
      assert.doesNotMatch(r.body, /Quarterly|Board folder|Child minutes|nobody/)
      assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow')
      assert.equal(r.headers['cache-control'], 'no-store')
    }
    for (const p of paths.html) {
      const r = await visit(p)
      assert.equal(r.statusCode, 200)
      assert.doesNotMatch(r.body, /og:|twitter:|Quarterly|Board folder|Child minutes|nobody/, p)
      assert.match(r.body, /<meta name="robots" content="noindex, nofollow" \/>/)
      assert.match(r.body, /<title>Inkling<\/title>/)
      assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow')
    }
    // Even a visitor who unlocked gets no meta: the cookie never reaches /s/.
    const ok = await unlock(d.token, 'correct horse', newIp())
    const { pair } = unlockCookie(ok)
    assert.doesNotMatch((await visit(paths.html[0], { cookie: pair })).body, /og:title/)
  })

  it('the unlock cookie opens its own link only, is scoped and short-lived, and dies with a password change', async () => {
    const s = await setup()
    const d = await publish(s.owner, s.doc.id, { password: 'first secret' })
    assert.equal(d.hasPassword, true)
    const f = await publish(s.owner, s.folder.id, { password: 'first secret' })
    const ip = newIp()

    const res = await unlock(d.token, 'first secret', ip)
    assert.equal(res.statusCode, 204)
    const { pair, c } = unlockCookie(res)
    assert.equal(c.path, `/api/public/${d.token}`)
    assert.equal(c.httpOnly, true)
    assert.equal(c.sameSite, 'Lax')
    const life = new Date(c.expires!).getTime() - Date.now()
    assert.ok(life > 11 * 3_600_000 && life <= 12 * 3_600_000 + 1000, `cookie lifetime ${life}`)
    assert.equal(res.headers['cache-control'], 'no-store')

    // Doc link: JSON and file open with the cookie; files stay out of shared caches.
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: pair })).statusCode, 200)
    const file = await visit(`/api/public/${d.token}/f/${s.docFile.id}`, { cookie: pair })
    assert.equal(file.statusCode, 200)
    assert.equal(file.headers['cache-control'], 'private, max-age=300')
    // The same password on another link does not carry over: its cookie is for its own token.
    assert.equal((await visit(`/api/public/${f.token}`, { cookie: pair })).statusCode, 401)
    // A tampered or foreign-format value is refused.
    const [name, value] = pair.split('=')
    const tampered = `${name}=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: tampered })).statusCode, 401)
    const longer = value.replace(/^v1\.(\d+)\./, (_m, e) => `v1.${Number(e) + 86400}.`)
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: `${name}=${longer}` })).statusCode, 401)

    // Folder link: one cookie opens the tree, child pages and child files.
    const fu = unlockCookie(await unlock(f.token, 'first secret', ip)).pair
    const paths = await allPaths(s, d.token, f.token, fu)
    for (const p of paths.folder) assert.equal((await visit(p, { cookie: fu })).statusCode, 200, p)

    // Changing the password (even to the same text) ends every unlock; so does removing it and setting it again.
    assert.equal((await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: 'first secret' })).statusCode, 200)
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: pair })).statusCode, 401)
    const again = unlockCookie(await unlock(d.token, 'first secret', ip)).pair
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: again })).statusCode, 200)
    assert.equal((await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: null })).json().hasPassword, false)
    assert.equal((await visit(`/api/public/${d.token}`)).statusCode, 200)
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: 'first secret' })
    assert.equal((await visit(`/api/public/${d.token}`, { cookie: again })).statusCode, 401)

    // Unpublish clears the password and expiry: a new link starts open.
    assert.equal((await member(s.owner, 'DELETE', `/pages/${s.doc.id}/share`)).statusCode, 200)
    const [row] = await db.select({ h: schema.pages.sharePasswordHash, e: schema.pages.shareExpiresAt }).from(schema.pages).where(eq(schema.pages.id, s.doc.id))
    assert.deepEqual(row, { h: null, e: null })
    const fresh = await publish(s.owner, s.doc.id)
    assert.equal(fresh.hasPassword, false)
    assert.notEqual(fresh.token, d.token)
    assert.equal((await visit(`/api/public/${fresh.token}`)).statusCode, 200)
  })

  it('wrong passwords: same answer time, per-link backoff, IP ban; never logged in audit', async () => {
    const s = await setup()
    const d = await publish(s.owner, s.doc.id, { password: 'pass-1234' })
    const ip = newIp()

    const times: Record<string, number> = {}
    const timed = async (label: string, fn: () => ReturnType<typeof unlock>) => {
      const t0 = performance.now()
      const r = await fn()
      times[label] = performance.now() - t0
      return r
    }
    const wrong = await timed('wrong', () => unlock(d.token, 'nope', ip))
    assert.equal(wrong.statusCode, 401)
    assert.equal(wrong.json().error.code, 'SHARE_PASSWORD_INVALID')
    assert.equal(wrong.cookies.length, 0)
    const unknown = await timed('unknown', () => unlock('x'.repeat(22), 'nope', newIp()))
    assert.equal(unknown.statusCode, 404)
    const right = await timed('right', () => unlock(d.token, 'pass-1234', ip))
    assert.equal(right.statusCode, 204)
    for (const [k, v] of Object.entries(times)) assert.ok(v >= SHARE_UNLOCK_FLOOR_MS - 5, `${k} answered in ${v.toFixed(1)} ms`)

    // Per link: after 3 wrong answers (AUTH_GUARD_ACCOUNT_FAILURES) the next attempt waits, from any IP.
    await unlock(d.token, 'nope', newIp())
    await unlock(d.token, 'nope', newIp())
    const held = await unlock(d.token, 'pass-1234', newIp())
    assert.equal(held.statusCode, 429)
    assert.equal(held.json().error.code, 'RATE_LIMITED')

    // Per IP: 6 failures across links ban the address from every public route.
    const banned = newIp()
    for (let i = 0; i < 6; i++) {
      const other = await setup()
      const t = (await publish(other.owner, other.doc.id, { password: 'pass-1234' })).token
      assert.equal((await unlock(t, 'nope', banned)).statusCode, 401)
    }
    const after6 = await visit(`/api/public/${d.token}`, { ip: banned })
    assert.equal(after6.statusCode, 429)

    // Audit: set/change/remove recorded, no password or hash anywhere in the rows.
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: 'pass-5678' })
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: null })
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { password: 'pass-9999' })
    const rows = await db
      .select({ action: schema.workspaceAuditEvents.action, before: schema.workspaceAuditEvents.before, after: schema.workspaceAuditEvents.after })
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.workspaceId, s.ws.id), eq(schema.workspaceAuditEvents.targetId, s.doc.id)))
      .orderBy(schema.workspaceAuditEvents.id)
    assert.deepEqual(
      rows.map((r) => r.action),
      ['share.published', 'share.password_changed', 'share.password_removed', 'share.password_set'],
    )
    assert.deepEqual(rows[0].after, { expiresAt: null, password: true })
    const dump = JSON.stringify(rows)
    assert.doesNotMatch(dump, /pass-|argon2/)
    // The owner API never returns the hash either.
    const list = await member(s.owner, 'GET', `/workspaces/${s.ws.id}/shared`)
    assert.doesNotMatch(list.body, /argon2|pass-/)
    assert.equal(list.json().items.find((i: { id: string }) => i.id === s.doc.id).hasPassword, true)
  })

  it('expiry: server clock, 410 on every route and the shell, extend or remove, listed as expired', async () => {
    const s = await setup()
    const d = await publish(s.owner, s.doc.id, { expiresInDays: 7 })
    const f = await publish(s.owner, s.folder.id, { expiresInDays: 1 })
    const in7 = new Date(d.expiresAt!).getTime() - Date.now()
    assert.ok(Math.abs(in7 - 7 * 86_400_000) < 60_000, `expires in ${in7} ms`)
    assert.equal(d.expired, false)
    const paths = await allPaths(s, d.token, f.token)
    // Files of an expiring link are never cached past the expiry (five minutes at most).
    assert.equal((await visit(paths.doc[1])).headers['cache-control'], 'public, max-age=300')

    // Past times are refused; the server's now decides.
    const past = await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    assert.equal(past.statusCode, 400)
    // Expire both links (as if time had passed).
    await db.update(schema.pages).set({ shareExpiresAt: new Date(Date.now() - 1000) }).where(sql`${schema.pages.id} IN (${s.doc.id}, ${s.folder.id})`)
    for (const p of [...paths.doc, ...paths.folder]) {
      const r = await visit(p, { ip: newIp() })
      assert.equal(r.statusCode, 410, p)
      assert.equal(r.json().error.code, 'SHARE_EXPIRED')
      assert.doesNotMatch(r.body, /Quarterly|Board folder|Child minutes|nobody|expiresAt/)
    }
    for (const p of paths.html) {
      const r = await visit(p)
      assert.doesNotMatch(r.body, /og:|Quarterly|Board folder|Child minutes/, p)
      assert.match(r.body, /noindex/)
    }
    // Expired links do not count as token guesses: 10 hits from one IP do not get it banned.
    const ip = newIp()
    for (let i = 0; i < 8; i++) assert.equal((await visit(paths.doc[0], { ip })).statusCode, 410)
    // Unlocking an expired link answers 410 too.
    assert.equal((await unlock(d.token, 'x', newIp())).statusCode, 410)

    // The owner still sees it, marked expired, and can extend it or make it permanent.
    const list = (await member(s.owner, 'GET', `/workspaces/${s.ws.id}/shared`)).json() as { items: { id: string; expired: boolean; expiresAt: string | null }[] }
    assert.equal(list.items.find((i) => i.id === s.doc.id)?.expired, true)
    const status = (await member(s.owner, 'GET', `/pages/${s.doc.id}/share`)).json()
    assert.equal(status.shared, true)
    assert.equal(status.expired, true)
    const ext = await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { expiresInDays: 30 })
    assert.equal(ext.json().expired, false)
    assert.equal((await visit(paths.doc[0])).statusCode, 200)
    const forever = await member(s.owner, 'PATCH', `/pages/${s.folder.id}/share`, { expiresAt: null })
    assert.equal(forever.json().expiresAt, null)
    assert.equal((await visit(paths.folder[1])).statusCode, 200)
    const audit = await db
      .select({ action: schema.workspaceAuditEvents.action, before: schema.workspaceAuditEvents.before, after: schema.workspaceAuditEvents.after })
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.targetId, s.folder.id), eq(schema.workspaceAuditEvents.action, 'share.expiry_changed')))
    assert.equal(audit.length, 1)
    assert.deepEqual(audit[0].after, { expiresAt: null })

    // An expiry close to now caps the file cache lifetime.
    await member(s.owner, 'PATCH', `/pages/${s.doc.id}/share`, { expiresAt: new Date(Date.now() + 120_000).toISOString() })
    const cc = (await visit(paths.doc[1])).headers['cache-control'] as string
    const age = Number(/max-age=(\d+)/.exec(cc)?.[1])
    assert.ok(age <= 120 && age > 100, cc)
    // Members cannot change links; a page without a link answers 409.
    const plain = await h.makeUser('member')
    await db.insert(schema.workspaceMembers).values({ workspaceId: s.ws.id, userId: plain.id, role: 'member' })
    assert.equal((await member(plain, 'PATCH', `/pages/${s.doc.id}/share`, { expiresAt: null })).statusCode, 403)
    assert.equal((await member(s.owner, 'PATCH', `/pages/${s.child.id}/share`, { expiresAt: null })).statusCode, 409)
  })

  it('workspace rules: default expiry for new links, password required', async () => {
    const s = await setup()
    const old = await publish(s.owner, s.doc.id)
    const set = await member(s.owner, 'PATCH', `/workspaces/${s.ws.id}/settings`, { shareDefaultExpiryDays: 7, sharePasswordRequired: true })
    assert.equal(set.statusCode, 200, set.body)
    assert.equal(set.json().settings.shareDefaultExpiryDays, 7)
    // Existing links are not changed retroactively.
    assert.equal((await visit(`/api/public/${old.token}`)).statusCode, 200)
    const status = (await member(s.owner, 'GET', `/pages/${s.folder.id}/share`)).json()
    assert.deepEqual(status.policy, { defaultExpiryDays: 7, passwordRequired: true })

    const refused = await member(s.owner, 'POST', `/pages/${s.folder.id}/share`)
    assert.equal(refused.statusCode, 403)
    assert.equal(refused.json().error.code, 'SHARE_PASSWORD_POLICY')
    const made = await publish(s.owner, s.folder.id, { password: 'policy-pass' })
    assert.equal(made.hasPassword, true)
    const days = (new Date(made.expiresAt!).getTime() - Date.now()) / 86_400_000
    assert.ok(days > 6.99 && days <= 7, String(days))
    // The publisher may still pick another expiry, or none.
    await member(s.owner, 'DELETE', `/pages/${s.folder.id}/share`)
    const none = await publish(s.owner, s.folder.id, { password: 'policy-pass', expiresAt: null })
    assert.equal(none.expiresAt, null)
    // The password cannot be removed while the rule is on.
    const rm = await member(s.owner, 'PATCH', `/pages/${s.folder.id}/share`, { password: null })
    assert.equal(rm.statusCode, 403)
    const audit = await db
      .select({ after: schema.workspaceAuditEvents.after })
      .from(schema.workspaceAuditEvents)
      .where(and(eq(schema.workspaceAuditEvents.workspaceId, s.ws.id), eq(schema.workspaceAuditEvents.action, 'settings.updated')))
    assert.deepEqual(audit[0].after, { shareDefaultExpiryDays: 7, sharePasswordRequired: true })
  })
})
