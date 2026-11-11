// Account deletion (0.22, docs/adr/2512-*, 2513-*, 2514-*): leaving (DELETE /api/me) and its preview,
// the trace check (after a deletion by the person or by expiry, the name and sign-in ID are found in
// no text or jsonb column of the database), leaving a workspace as its only member, "delete now" of a
// deleted workspace, and the admin deletion keeping its 0.21.1 answers.
//
// Some cases need a server with exactly one admin, so this file makes its own scratch database.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-accdel-'))
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] account deletion', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_accdel_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { createSession, SESSION_COOKIE, hashPassword } = await import('../auth')
  const { setLimitsForTests } = await import('../limits')
  const { generateInviteCodeColumns } = await import('../helpers')
  const { deleteAccount } = await import('./deletion')
  const { expireAccounts } = await import('./housekeeping')
  const { createApiToken } = await import('../apiTokens')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String(err) } })
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/auth')).registerAuthRoutes(api)
      await (await import('../routes/admin')).registerAdminRoutes(api)
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/comments')).registerCommentRoutes(api)
      await (await import('../routes/notifications')).registerNotificationRoutes(api)
      await (await import('../restricted')).registerRestrictedMode(api)
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  const tag = () => randomBytes(4).toString('hex')
  type U = { id: string; email: string; name: string; cookie: string; password: string }
  const makeUser = async (name: string, opts: { isAdmin?: boolean; origin?: 'local' | 'delegated' | 'oidc'; email?: string } = {}): Promise<U> => {
    const password = 'password123'
    const [u] = await db
      .insert(schema.users)
      .values({ email: opts.email ?? `${name.toLowerCase()}-${tag()}@t.t`, name, passwordHash: await hashPassword(password), isAdmin: !!opts.isAdmin, origin: opts.origin ?? 'local' })
      .returning()
    const { token } = await createSession(u.id)
    return { id: u.id, email: u.email, name: u.name, cookie: `${SESSION_COOKIE}=${token}`, password }
  }
  const makeWs = async (owner: { id: string }, members: { id: string; role?: 'admin' | 'member' }[] = [], name = `WS ${tag()}`) => {
    const id = crypto.randomUUID()
    const [ws] = await db.insert(schema.workspaces).values({ id, name, ...(await generateInviteCodeColumns(db, id)) }).returning()
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: owner.id, role: 'owner' })
    for (const m of members) {
      await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: m.id, role: m.role ?? 'member' })
      await new Promise((r) => setTimeout(r, 5)) // distinct created_at: "oldest member" is well defined
    }
    return ws
  }
  const call = (cookie: string | null, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const newPage = async (u: U, workspaceId: string, title: string, scope: 'shared' | 'private' = 'shared') => {
    const r = await call(u.cookie, 'POST', '/pages', { workspaceId, title, scope })
    assert.equal(r.statusCode, 200, r.body)
    return (r.json() as { page: { id: string } }).page.id
  }
  const uploads = path.join(process.env.DATA_DIR!, 'uploads')
  mkdirSync(uploads, { recursive: true })
  const blob = async (workspaceId: string, pageId: string | null, by: string) => {
    const [f] = await db.insert(schema.files).values({ workspaceId, pageId, name: 'a.txt', mime: 'text/plain', size: 3, createdBy: by }).returning({ id: schema.files.id })
    writeFileSync(path.join(uploads, f.id), 'abc')
    return f.id
  }
  const exists = async (table: string, id: string) =>
    ((await db.execute(sql.raw(`SELECT 1 FROM ${table} WHERE id = '${id}'`))) as unknown as unknown[]).length > 0

  /** Every text, varchar, text[] and jsonb column holding `needle` (as a substring). */
  const traces = async (needle: string): Promise<string[]> => {
    const cols = (await db.execute(sql`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
         AND table_name NOT LIKE '\\_\\_%'
    `)) as unknown as { t: string; c: string }[]
    const hits: string[] = []
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    for (const { t, c } of cols) {
      const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)}::text LIKE ${like}`)) as unknown as { n: number }[]
      if (Number(r.n) > 0) hits.push(`${t}.${c}`)
    }
    return hits
  }
  /** Every uuid column holding `id`. */
  const idTraces = async (id: string): Promise<string[]> => {
    const cols = (await db.execute(sql`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'uuid'
    `)) as unknown as { t: string; c: string }[]
    const hits: string[] = []
    for (const { t, c } of cols) {
      const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE ${sql.identifier(c)} = ${id}::uuid`)) as unknown as { n: number }[]
      if (Number(r.n) > 0) hits.push(`${t}.${c}`)
    }
    return hits
  }

  let root: U
  before(async () => {
    root = await makeUser('Root', { isAdmin: true })
  })

  /**
   * A person with traces everywhere a name or ID gets copied: an own workspace, a shared workspace
   * they own alone (with an admin-role member and an older plain member), a workspace of someone else
   * with shared and private pages, files, comments, the change log, audit rows (joined, transferred,
   * left, a lock's editor list), an invitation to their address, tokens and a session.
   */
  const seedPerson = async () => {
    const unique = `Zq${tag()}${tag()}`
    // a sign-in ID as LOGIN_ID_MODE=username stores it (users.email holds the ID)
    const person = await makeUser(unique, { email: `id-${unique.toLowerCase()}` })
    const bob = await makeUser(`Bob${tag()}`)
    const carol = await makeUser(`Carol${tag()}`)
    const own = await makeWs(person, [], `Own ${tag()}`)
    const ownPage = await newPage(person, own.id, 'own page')
    const ownBlob = await blob(own.id, ownPage, person.id)
    // the workspace made at sign-up keeps the name; carol (plain, joined first) and bob (admin) are in it
    const soleOwned = await makeWs(person, [{ id: carol.id }, { id: bob.id, role: 'admin' }], `${unique}'s workspace`)
    const soleOwnedPage = await newPage(person, soleOwned.id, 'team page')
    const theirs = await makeWs(bob, [{ id: person.id }, { id: carol.id }], `Bob's team ${tag()}`)
    const shared = await newPage(person, theirs.id, 'shared by the person')
    const priv = await newPage(person, theirs.id, 'private of the person', 'private')
    const privBlob = await blob(theirs.id, priv, person.id)
    const bobPage = await newPage(bob, theirs.id, 'bob page')
    const c = await call(person.cookie, 'POST', `/pages/${bobPage}/comments`, { blockId: 'b1', body: 'a comment by the person' })
    assert.equal(c.statusCode, 200, c.body)
    // audit rows that copy the name: a lock's editor list, an earlier ownership transfer of a workspace
    await db.insert(schema.workspaceAuditEvents).values({
      workspaceId: theirs.id, actorId: bob.id, actorName: bob.name, action: 'page.locked',
      targetType: 'page', targetId: bobPage, targetLabel: 'bob page', after: { editors: [unique, bob.name] },
    })
    const left = await makeWs(bob, [{ id: person.id }], `Left ${tag()}`)
    assert.equal((await call(person.cookie, 'DELETE', `/workspaces/${left.id}/members/${person.id}`)).statusCode, 204)
    const handed = await makeWs(person, [{ id: bob.id }], `Handed ${tag()}`)
    assert.equal((await call(person.cookie, 'POST', `/workspaces/${handed.id}/transfer`, { userId: bob.id })).statusCode, 200)
    // the change log (no foreign keys): an edit of a shared page, and the private page's own entries
    await db.execute(sql`
      INSERT INTO page_changes (workspace_id, page_id, kind, after_text, scope, owner_id, actor_id) VALUES
        (${theirs.id}, ${shared}, 'modified', 'shared text', 'shared', NULL, ${person.id}),
        (${theirs.id}, ${priv}, 'modified', 'private text', 'private', ${person.id}, ${person.id})
    `)
    await db.insert(schema.pageInvites).values({ pageId: bobPage, email: person.email, level: 'view', tokenHash: `h-${tag()}`, invitedBy: bob.id, expiresAt: new Date(Date.now() + 86_400_000) })
    await createApiToken(person.id, { name: `token of ${unique}`, expiresInDays: 30, access: 'read', range: { kind: 'all' } })
    return { unique, person, bob, carol, own, ownBlob, soleOwned, soleOwnedPage, theirs, shared, priv, privBlob, bobPage, handed, left }
  }

  const assertGone = async (s: Awaited<ReturnType<typeof seedPerson>>) => {
    // nothing of the person in any text or jsonb column (the name and the sign-in ID)
    assert.deepEqual(await traces(s.unique), [])
    assert.deepEqual(await traces(s.person.email), [])
    assert.deepEqual(await idTraces(s.person.id), [])
    // their own workspace and files are gone, the blobs unlinked
    assert.equal(await exists('workspaces', s.own.id), false)
    assert.equal(existsSync(path.join(uploads, s.ownBlob)), false)
    // the sole-owned workspace stays with the oldest admin-role member, who is told
    const owners = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, s.soleOwned.id))
    assert.deepEqual(owners.map((m) => [m.userId, m.role]).sort(), [[s.bob.id, 'owner'], [s.carol.id, 'member']].sort())
    assert.equal(await exists('pages', s.soleOwnedPage), true)
    const [ws] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, s.soleOwned.id))
    assert.equal(ws.name, 'Workspace')
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, s.bob.id))
    assert.ok(n.some((x) => x.type === 'workspace_owner' && x.workspaceId === s.soleOwned.id))
    // shared content stays without an author; private pages and their files are gone
    const [sharedRow] = await db.select({ createdBy: schema.pages.createdBy, deletedAt: schema.pages.deletedAt }).from(schema.pages).where(eq(schema.pages.id, s.shared))
    assert.equal(sharedRow.createdBy, null)
    assert.equal(sharedRow.deletedAt, null)
    assert.equal(await exists('pages', s.priv), false)
    assert.equal(await exists('files', s.privBlob), false)
    assert.equal(existsSync(path.join(uploads, s.privBlob)), false)
    const log = (await db.execute(sql`SELECT page_id AS "pageId", actor_id AS "actorId" FROM page_changes WHERE page_id IN (${s.shared}, ${s.priv})`)) as unknown as { pageId: string; actorId: string | null }[]
    assert.deepEqual([...log], [{ pageId: s.shared, actorId: null }])
    const comments = await db.select().from(schema.comments).where(eq(schema.comments.pageId, s.bobPage))
    assert.equal(comments.length, 1)
    assert.equal(comments[0].authorId, null)
  }

  it('preview: what goes, what stays, who takes over; GET only, nothing changes', async () => {
    const s = await seedPerson()
    const r = await call(s.person.cookie, 'GET', '/me/delete-preview')
    assert.equal(r.statusCode, 200, r.body)
    const p = r.json() as import('./routes').DeletePreviewDTO
    assert.deepEqual(p.deleted.map((w) => w.id), [s.own.id])
    assert.equal(p.deleted[0].pages, 1)
    assert.equal(p.deleted[0].files, 1)
    assert.deepEqual(p.transferred.map((t) => [t.id, t.to.id]), [[s.soleOwned.id, s.bob.id]])
    assert.deepEqual(p.kept.map((w) => w.id).sort(), [s.theirs.id, s.handed.id].sort())
    assert.equal(p.privatePages, 1)
    assert.deepEqual(p.needs, { password: true, code: false, recentSignIn: false })
    assert.equal(p.confirm, s.person.email)
    assert.equal(p.lastAdmin, false)
    assert.equal(await exists('workspaces', s.own.id), true)
  })

  it('leaving: password and confirmation required, then nothing of the person remains anywhere', async () => {
    const s = await seedPerson()
    // the scan sees the seeded copies before the deletion
    const pre = await traces(s.unique)
    for (const col of ['users.name', 'workspaces.name', 'api_tokens.name', 'workspace_audit_events.actor_name', 'workspace_audit_events.target_label', 'workspace_audit_events.before', 'workspace_audit_events.after']) {
      assert.ok(pre.includes(col), `${col} not in ${pre.join(', ')}`)
    }
    assert.deepEqual((await traces(s.person.email)).sort(), ['page_invites.email', 'users.email'])
    const ids = await idTraces(s.person.id)
    for (const col of ['users.id', 'pages.created_by', 'workspace_members.user_id', 'page_changes.actor_id', 'page_changes.owner_id', 'comments.author_id', 'workspace_audit_events.actor_id']) assert.ok(ids.includes(col), `${col} not in ${ids.join(', ')}`)
    assert.equal((await call(s.person.cookie, 'DELETE', '/me', { confirm: s.person.email })).statusCode, 400)
    assert.equal((await call(s.person.cookie, 'DELETE', '/me', { confirm: 'someone else', password: s.person.password })).json().error.code, 'CONFIRM_MISMATCH')
    const wrong = await call(s.person.cookie, 'DELETE', '/me', { confirm: s.person.email, password: 'wrong-password' })
    assert.equal(wrong.json().error.code, 'INVALID_PASSWORD')
    const r = await call(s.person.cookie, 'DELETE', '/me', { confirm: s.person.email.toUpperCase(), password: s.person.password })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(r.json(), { ok: true, deletedWorkspaces: 1, transferredWorkspaces: 1 })
    assert.match(String(r.headers['set-cookie']), new RegExp(`${SESSION_COOKIE}=;`))
    assert.equal((await call(s.person.cookie, 'GET', '/auth/me')).statusCode, 401)
    await assertGone(s)
  })

  it('expiry deletes the same way: nothing of the person remains, the shared workspace is handed over', async () => {
    const s = await seedPerson()
    await db.update(schema.users).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.users.id, s.person.id))
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      const lines: string[] = []
      assert.equal(await expireAccounts((m) => lines.push(m)), 1)
      assert.deepEqual(lines, [`[inkling] account lifetime: deleted user ${s.person.id}, 1 workspace(s) deleted, 1 handed over`])
    } finally {
      restore()
    }
    await assertGone(s)
  })

  it('leaving and expiry at the same moment delete once', async () => {
    const p = await makeUser(`Race${tag()}`)
    await makeWs(p)
    await db.update(schema.users).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.users.id, p.id))
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      const results = await Promise.allSettled([deleteAccount(p.id, { by: 'self' }), deleteAccount(p.id, { by: 'expiry' })])
      const done = results.filter((r) => r.status === 'fulfilled' && r.value.deleted)
      assert.equal(done.length, 1, JSON.stringify(results))
      for (const r of results) {
        if (r.status === 'fulfilled') continue
        assert.equal((r.reason as { code?: string }).code, 'USER_NOT_FOUND')
      }
      assert.deepEqual(await idTraces(p.id), [])
    } finally {
      restore()
    }
  })

  it('wrong passwords count against the sign-in guard (account backoff after five)', async () => {
    const p = await makeUser(`Guard${tag()}`)
    const codes: number[] = []
    for (let i = 0; i < 7; i++) codes.push((await call(p.cookie, 'DELETE', '/me', { confirm: p.email, password: `nope-${i}` })).statusCode)
    assert.equal(codes[0], 400)
    assert.ok(codes.includes(429), codes.join(','))
  })

  it('delegated and OIDC accounts: only a session made in the last ten minutes', async () => {
    const d = await makeUser(`Deleg${tag()}`, { origin: 'delegated', email: `deleg-${tag()}@delegated.local` })
    const pre = (await call(d.cookie, 'GET', '/me/delete-preview')).json() as import('./routes').DeletePreviewDTO
    assert.deepEqual(pre.needs, { password: false, code: false, recentSignIn: true })
    await db.update(schema.sessions).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(schema.sessions.userId, d.id))
    const old = await call(d.cookie, 'DELETE', '/me', { confirm: d.email })
    assert.equal(old.statusCode, 401)
    assert.equal(old.json().error.code, 'REAUTH_REQUIRED')
    const { token } = await createSession(d.id)
    const ok = await call(`${SESSION_COOKIE}=${token}`, 'DELETE', '/me', { confirm: d.email })
    assert.equal(ok.statusCode, 200, ok.body)
  })

  it('the only admin cannot leave (409 LAST_ADMIN); bearer tokens cannot delete an account', async () => {
    const r = await call(root.cookie, 'DELETE', '/me', { confirm: root.email, password: root.password })
    assert.equal(r.statusCode, 409)
    assert.equal(r.json().error.code, 'LAST_ADMIN')
    assert.equal(((await call(root.cookie, 'GET', '/me/delete-preview')).json() as { lastAdmin: boolean }).lastAdmin, true)
    const p = await makeUser(`Bearer${tag()}`)
    const { secret } = await createApiToken(p.id, { name: 't', expiresInDays: 30, access: 'write', range: { kind: 'all' } })
    const b = await app.inject({ method: 'DELETE', url: '/api/me', headers: { authorization: `Bearer ${secret}` }, payload: { confirm: p.email, password: p.password } })
    assert.equal(b.statusCode, 403, b.body)
    assert.equal(await exists('users', p.id), true)
  })

  it('a failure inside the deletion leaves everything in place', async () => {
    const p = await makeUser(`Fail${tag()}`)
    const ws = await makeWs(p)
    const f = await blob(ws.id, null, p.id)
    // a trigger that refuses the users delete, standing in for any failure after the first writes
    await db.execute(sql.raw(`CREATE FUNCTION w_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${p.id}' THEN RAISE EXCEPTION 'refused'; END IF; RETURN OLD; END $$`))
    await db.execute(sql.raw(`CREATE TRIGGER w_refuse BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION w_refuse()`))
    try {
      await assert.rejects(deleteAccount(p.id, { by: 'self' }))
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER w_refuse ON users; DROP FUNCTION w_refuse()`))
    }
    assert.equal(await exists('users', p.id), true)
    assert.equal(await exists('workspaces', ws.id), true)
    assert.equal(await exists('files', f), true)
    assert.equal(existsSync(path.join(uploads, f)), true)
  })

  it('admin deletion keeps its 0.21.1 answers: 409 SOLE_OWNER, private pages to the trash, personal workspace deleted', async () => {
    const p = await makeUser(`Adm${tag()}`)
    const other = await makeUser(`Other${tag()}`)
    const own = await makeWs(p)
    const shared = await makeWs(p, [{ id: other.id }])
    const refused = await call(root.cookie, 'DELETE', `/admin/users/${p.id}`)
    assert.equal(refused.statusCode, 409)
    assert.equal(refused.json().error.code, 'SOLE_OWNER')
    assert.deepEqual(refused.json().error.workspaces, [{ id: shared.id, name: shared.name }])
    const preview = (await call(root.cookie, 'GET', `/admin/users/${p.id}/delete-preview`)).json()
    assert.deepEqual(preview, { personalWorkspaces: 1, personal: [{ id: own.id, name: own.name }], soleOwnedShared: [{ id: shared.id, name: shared.name }] })
    assert.equal((await call(p.cookie, 'POST', `/workspaces/${shared.id}/transfer`, { userId: other.id })).statusCode, 200)
    const priv = await newPage(p, shared.id, 'private', 'private')
    const ok = await call(root.cookie, 'DELETE', `/admin/users/${p.id}`)
    assert.equal(ok.statusCode, 200, ok.body)
    assert.deepEqual(ok.json(), { ok: true, deletedWorkspaces: 1 })
    const [row] = await db.select({ deletedAt: schema.pages.deletedAt, createdBy: schema.pages.createdBy }).from(schema.pages).where(eq(schema.pages.id, priv))
    assert.ok(row.deletedAt)
    assert.equal(row.createdBy, null)
    assert.equal(await exists('workspaces', own.id), false)
  })

  it('leaving as the only member: refused without the name (as before), deletes the workspace with it', async () => {
    const p = await makeUser(`Alone${tag()}`)
    const ws = await makeWs(p, [], `Alone ws ${tag()}`)
    const page = await newPage(p, ws.id, 'x')
    const f = await blob(ws.id, page, p.id)
    const leave = (body?: unknown) => call(p.cookie, 'DELETE', `/workspaces/${ws.id}/members/${p.id}`, body)
    assert.equal((await leave()).statusCode, 400)
    assert.equal((await leave({ name: 'not the name' })).statusCode, 400)
    assert.equal(await exists('workspaces', ws.id), true)
    assert.equal((await leave({ name: ws.name })).statusCode, 204)
    assert.equal(await exists('workspaces', ws.id), false)
    assert.equal(existsSync(path.join(uploads, f)), false)

    // the only owner with another member still cannot leave, name or not
    const other = await makeUser(`Stay${tag()}`)
    const ws2 = await makeWs(p, [{ id: other.id }])
    const r = await call(p.cookie, 'DELETE', `/workspaces/${ws2.id}/members/${p.id}`, { name: ws2.name })
    assert.equal(r.statusCode, 400)
    assert.equal(await exists('workspaces', ws2.id), true)
  })

  it('delete now: owner only, deleted workspaces only, with the name', async () => {
    const p = await makeUser(`Now${tag()}`)
    const m = await makeUser(`Mem${tag()}`)
    const ws = await makeWs(p, [{ id: m.id }], `Now ws ${tag()}`)
    const f = await blob(ws.id, null, p.id)
    const now = (u: U, name: string) => call(u.cookie, 'DELETE', `/workspaces/${ws.id}/permanent`, { name })
    assert.equal((await now(p, ws.name)).statusCode, 404) // not deleted yet
    assert.equal((await call(p.cookie, 'DELETE', `/workspaces/${ws.id}`, { name: ws.name })).statusCode, 204)
    assert.equal((await now(m, ws.name)).statusCode, 403)
    assert.equal((await now(p, 'wrong')).statusCode, 400)
    assert.equal((await now(p, ws.name)).statusCode, 204)
    assert.equal(await exists('workspaces', ws.id), false)
    assert.equal(existsSync(path.join(uploads, f)), false)
    assert.equal((await now(p, ws.name)).statusCode, 404)
  })
})
