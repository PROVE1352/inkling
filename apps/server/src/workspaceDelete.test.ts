// Workspace soft delete / restore / purge (docs/adr/0910-*) and ownership transfer (0911-*).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
// [db] tests need a migrated scratch database and are skipped without DATABASE_URL.

// Env read at module load — set before any app module is imported.
process.env.PUBLIC_URL = 'https://notes.example.com/'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-wsdelete-${process.pid}`

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] workspace deletion and ownership transfer', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { createSession, SESSION_COOKIE } = await import('./auth')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const { eq, and } = await import('drizzle-orm')
  const { env } = await import('./env')
  const { hashIcalToken } = await import('./routes/ical')
  const { hashShareToken } = await import('./secretsAtRest')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION' } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/admin')).registerAdminRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
      await (await import('./routes/notifications')).registerNotificationRoutes(api)
      await (await import('./routes/ical')).registerIcalApiRoutes(api)
    },
    { prefix: '/api' },
  )
  await (await import('./routes/files')).registerFileDownloadRoute(app)
  await (await import('./routes/ical')).registerIcalFeedRoute(app)
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  const tag = () => randomUUID().slice(0, 8)
  async function user(name = 'u', isAdmin = false) {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `${name}-${tag()}@t.t`, name, passwordHash: 'x', isAdmin })
      .returning()
    const { token } = await createSession(u.id)
    return { ...u, cookie: `${SESSION_COOKIE}=${token}` }
  }
  async function workspace(owner: { id: string }, members: { id: string; role?: 'owner' | 'member' }[] = [], name = `Team ${tag()}`) {
    const [ws] = await db.insert(schema.workspaces).values({ name, inviteCode: `I${tag()}` }).returning()
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: ws.id, userId: owner.id, role: 'owner' },
      ...members.map((m) => ({ workspaceId: ws.id, userId: m.id, role: m.role ?? ('member' as const) })),
    ])
    return ws
  }
  async function page(wsId: string, by: string, v: Partial<typeof schema.pages.$inferInsert> = {}) {
    const [p] = await db
      .insert(schema.pages)
      .values({ workspaceId: wsId, title: v.title ?? 'p', createdBy: by, ...v })
      .returning()
    return p
  }
  async function file(wsId: string, pageId: string, by: string) {
    const [f] = await db
      .insert(schema.files)
      .values({ workspaceId: wsId, pageId, name: 'a.png', mime: 'image/png', size: 3, createdBy: by })
      .returning()
    const dir = path.join(env.dataDir, 'uploads')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, f.id), 'png')
    return f
  }
  const req = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object })
  const wsIds = async (cookie: string) =>
    ((await req(cookie, 'GET', '/api/workspaces')).json().workspaces as { id: string }[]).map((w) => w.id)
  const blob = (id: string) => path.join(env.dataDir, 'uploads', id)

  let owner: Awaited<ReturnType<typeof user>>
  let member: Awaited<ReturnType<typeof user>>
  before(async () => {
    owner = await user('owner')
    member = await user('member')
  })

  it('only an owner can delete (403), and the name must match exactly (400)', async () => {
    const ws = await workspace(owner, [member])
    const asMember = await req(member.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name })
    assert.equal(asMember.statusCode, 403, asMember.body)
    const wrong = await req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name.toUpperCase() })
    assert.equal(wrong.statusCode, 400, wrong.body)
    const missing = await req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, {})
    assert.equal(missing.statusCode, 400)
    const outsider = await user('outsider')
    assert.equal((await req(outsider.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name })).statusCode, 404)
    const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
    assert.equal(row.deletedAt, null)
  })

  it('after delete: hidden from list, members, pages, public share, files, iCal; restore brings it all back', async () => {
    const ws = await workspace(owner, [member])
    // pages.share_token holds the token's SHA-256 (docs/adr/1110-*)
    const shareRaw = `tok${tag()}${tag()}`
    const p = await page(ws.id, member.id, { title: 'Roadmap', shareToken: hashShareToken(shareRaw) })
    const f = await file(ws.id, p.id, member.id)
    const ical = randomUUID().replace(/-/g, '').padEnd(43, 'x').slice(0, 43)
    await db.insert(schema.icalTokens).values({ userId: member.id, tokenHash: hashIcalToken(ical) })
    // a dated row so the iCal feed has something from this workspace
    await db
      .update(schema.pages)
      .set({ properties: [{ id: 'd', name: 'date', type: 'date', value: new Date().toISOString().slice(0, 10) }] })
      .where(eq(schema.pages.id, p.id))

    const check = async (live: boolean) => {
      const code = live ? 200 : 404
      assert.equal((await wsIds(member.cookie)).includes(ws.id), live)
      assert.equal((await req(member.cookie, 'GET', `/api/workspaces/${ws.id}/members`)).statusCode, code)
      assert.equal((await req(member.cookie, 'GET', `/api/workspaces/${ws.id}/pages`)).statusCode, code)
      assert.equal((await req(member.cookie, 'GET', `/api/workspaces/${ws.id}/search?q=Road`)).statusCode, code)
      assert.equal((await req(member.cookie, 'GET', `/api/pages/${p.id}/share`)).statusCode, code)
      assert.equal((await app.inject({ method: 'GET', url: `/api/public/${shareRaw}` })).statusCode, code)
      assert.equal((await req(member.cookie, 'GET', `/files/${f.id}`)).statusCode, code)
      const feed = await app.inject({ method: 'GET', url: `/ical/${ical}.ics` })
      assert.equal(feed.statusCode, 200)
      assert.equal(feed.body.includes('Roadmap'), live, 'iCal feed includes the workspace only while live')
    }
    await check(true)

    const del = await req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name })
    assert.equal(del.statusCode, 204, del.body)
    await check(false)
    assert.ok(existsSync(blob(f.id)), 'blob kept while restorable')

    // the other member is told, with the workspace name; the owner gets no notice
    const notes = (await req(member.cookie, 'GET', '/api/notifications')).json().notifications as {
      type: string
      workspaceName: string | null
    }[]
    assert.ok(notes.some((n) => n.type === 'workspace_deleted' && n.workspaceName === ws.name))
    const mine = (await req(owner.cookie, 'GET', '/api/notifications')).json().notifications as { type: string }[]
    assert.ok(!mine.some((n) => n.type === 'workspace_deleted'))

    // the invite code no longer joins it
    const stranger = await user('stranger')
    assert.equal((await req(stranger.cookie, 'POST', '/api/workspaces/join', { inviteCode: ws.inviteCode })).statusCode, 404)

    // restore list: owner only
    const listed = (await req(owner.cookie, 'GET', '/api/workspaces/deleted')).json().workspaces as {
      id: string
      purgeAt: string
    }[]
    const entry = listed.find((w) => w.id === ws.id)
    assert.ok(entry)
    assert.ok(Date.parse(entry.purgeAt) - Date.now() > 29 * 86_400_000)
    assert.ok(!((await req(member.cookie, 'GET', '/api/workspaces/deleted')).json().workspaces as { id: string }[]).some((w) => w.id === ws.id))
    assert.equal((await req(member.cookie, 'POST', `/api/workspaces/${ws.id}/restore`)).statusCode, 403)

    const res = await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/restore`)
    assert.equal(res.statusCode, 200, res.body)
    await check(true)
    const after = (await req(member.cookie, 'GET', '/api/notifications')).json().notifications as { type: string }[]
    assert.ok(!after.some((n) => n.type === 'workspace_deleted'), 'stale notice removed on restore')
    assert.equal((await req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/restore`)).statusCode, 404, 'not deleted any more')
  })

  it('purge after 30 days removes rows and blobs; inside the window nothing is touched', async () => {
    const { runHousekeeping } = await import('./housekeeping')
    const old = await workspace(owner, [member])
    const oldPage = await page(old.id, owner.id)
    const oldFile = await file(old.id, oldPage.id, owner.id)
    const recent = await workspace(owner)
    const recentPage = await page(recent.id, owner.id)
    const recentFile = await file(recent.id, recentPage.id, owner.id)
    await db
      .update(schema.workspaces)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(schema.workspaces.id, old.id))
    await db
      .update(schema.workspaces)
      .set({ deletedAt: new Date(Date.now() - 29 * 86_400_000) })
      .where(eq(schema.workspaces.id, recent.id))
    // past the window it can no longer be restored
    assert.equal((await req(owner.cookie, 'POST', `/api/workspaces/${old.id}/restore`)).statusCode, 404)

    await runHousekeeping(() => {})
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, old.id))).length, 0)
    assert.equal((await db.select().from(schema.pages).where(eq(schema.pages.id, oldPage.id))).length, 0)
    assert.equal((await db.select().from(schema.files).where(eq(schema.files.id, oldFile.id))).length, 0)
    assert.equal(
      (await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, old.id))).length,
      0,
    )
    assert.ok(!existsSync(blob(oldFile.id)), 'blob unlinked')
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, recent.id))).length, 1)
    assert.ok(existsSync(blob(recentFile.id)))
  })

  it('concurrent delete/restore rounds always end in a consistent state', async () => {
    for (let i = 0; i < 6; i++) {
      const ws = await workspace(owner, [member])
      const dels = await Promise.all([
        req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name }),
        req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name }),
      ])
      assert.deepEqual(dels.map((r) => r.statusCode).sort(), [204, 404], `round ${i}`)
      const notes = await db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.workspaceId, ws.id), eq(schema.notifications.type, 'workspace_deleted')))
      assert.equal(notes.length, 1, 'one notice per member, not per request')
      const [restore, del] = await Promise.all([
        req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/restore`),
        req(owner.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name }),
      ])
      assert.equal(restore.statusCode, 200, restore.body)
      const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
      // either the delete ran first (404: already deleted) and the restore undid it, or the
      // restore ran first and the delete applied again — the row matches the last writer
      if (del.statusCode === 204) assert.ok(row.deletedAt)
      else {
        assert.equal(del.statusCode, 404)
        assert.equal(row.deletedAt, null)
      }
    }
  })

  it('restore racing the purge: the row is either fully restored or fully gone', async () => {
    const { purgeExpiredWorkspaces } = await import('./workspaceDeletion')
    for (let i = 0; i < 4; i++) {
      const ws = await workspace(owner)
      await page(ws.id, owner.id)
      // deleted 30 days minus a moment ago: restorable now, purgeable by a run "later"
      await db
        .update(schema.workspaces)
        .set({ deletedAt: new Date(Date.now() - 30 * 86_400_000 + 60_000) })
        .where(eq(schema.workspaces.id, ws.id))
      const [restore] = await Promise.all([
        req(owner.cookie, 'POST', `/api/workspaces/${ws.id}/restore`),
        purgeExpiredWorkspaces(new Date(Date.now() + 120_000), () => {}),
      ])
      const rows = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id))
      if (restore.statusCode === 200) {
        assert.equal(rows.length, 1)
        assert.equal(rows[0].deletedAt, null)
      }
      else {
        assert.equal(restore.statusCode, 404)
        assert.equal(rows.length, 0)
      }
    }
  })

  it('forced deletion uses the shared purge: a soft-deleted workspace the user solely owns goes too', async () => {
    const admin = await user('admin', true)
    const victim = await user('victim')
    const mate = await user('mate')
    const team = await workspace(victim, [mate])
    const p = await page(team.id, victim.id)
    const f = await file(team.id, p.id, victim.id)
    assert.equal((await req(victim.cookie, 'DELETE', `/api/workspaces/${team.id}`, { name: team.name })).statusCode, 204)
    const preview = (await req(admin.cookie, 'GET', `/api/admin/users/${victim.id}/delete-preview`)).json()
    assert.deepEqual(preview.soleOwnedShared, [])
    assert.ok(preview.personal.some((w: { id: string }) => w.id === team.id))
    const res = await req(admin.cookie, 'DELETE', `/api/admin/users/${victim.id}`)
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, team.id))).length, 0)
    assert.ok(!existsSync(blob(f.id)))
  })

  // -------------------------------------------------------------------------
  // ownership transfer (ADR 0911)
  // -------------------------------------------------------------------------

  it('transfer: owner only, target must be a member (400), then the old owner can leave', async () => {
    const a = await user('a')
    const b = await user('b')
    const outsider = await user('out')
    const ws = await workspace(a, [b])
    assert.equal((await req(b.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: b.id })).statusCode, 403)
    assert.equal((await req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: outsider.id })).statusCode, 400)
    assert.equal((await req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: a.id })).statusCode, 400)
    // the sole owner cannot leave (server keeps refusing; the web blocks it first)
    const leave = await req(a.cookie, 'DELETE', `/api/workspaces/${ws.id}/members/${a.id}`)
    assert.equal(leave.statusCode, 400, leave.body)
    const ok = await req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: b.id })
    assert.equal(ok.statusCode, 200, ok.body)
    const roles = Object.fromEntries((ok.json().members as { id: string; role: string }[]).map((m) => [m.id, m.role]))
    assert.deepEqual(roles, { [a.id]: 'member', [b.id]: 'owner' })
    assert.equal((await req(a.cookie, 'DELETE', `/api/workspaces/${ws.id}/members/${a.id}`)).statusCode, 204)
    assert.ok(!(await wsIds(a.cookie)).includes(ws.id))
  })

  it('transfer to a delegated account works like any member', async () => {
    const a = await user('a')
    const [d] = await db
      .insert(schema.users)
      .values({ email: `d-${tag()}@t.t`, name: 'd', passwordHash: 'x', origin: 'delegated' })
      .returning()
    const ws = await workspace(a, [d])
    assert.equal((await req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: d.id })).statusCode, 200)
  })

  it('two concurrent transfers keep exactly one owner', async () => {
    for (let i = 0; i < 6; i++) {
      const a = await user('a')
      const b = await user('b')
      const c = await user('c')
      const ws = await workspace(a, [b, c])
      const res = await Promise.all([
        req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: b.id }),
        req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: c.id }),
      ])
      assert.deepEqual(res.map((r) => r.statusCode).sort(), [200, 403], `round ${i}`)
      const owners = await db
        .select()
        .from(schema.workspaceMembers)
        .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.role, 'owner')))
      assert.equal(owners.length, 1, `round ${i}`)
      assert.notEqual(owners[0].userId, a.id)
    }
  })

  it('a deleted workspace cannot be transferred or left', async () => {
    const a = await user('a')
    const b = await user('b')
    const ws = await workspace(a, [b])
    await req(a.cookie, 'DELETE', `/api/workspaces/${ws.id}`, { name: ws.name })
    assert.equal((await req(a.cookie, 'POST', `/api/workspaces/${ws.id}/transfer`, { userId: b.id })).statusCode, 404)
    assert.equal((await req(b.cookie, 'DELETE', `/api/workspaces/${ws.id}/members/${b.id}`)).statusCode, 404)
  })
})
