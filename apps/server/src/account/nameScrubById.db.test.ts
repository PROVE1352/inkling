// Account deletion scrubs names by id only (0.22 security fix F8, contract §14, docs/adr/2535-*).
// Leaving or expiry must never change a row about another person, even one with the same display
// name: the audit rows of other people keep their labels and JSON values, and only the workspaces the
// account itself made at sign-up ("<name>'s workspace", created_by = the account) are renamed.
// Ported from the review's R3 and R3b (w22-reports/sec/sec.db.test.ts), which showed the opposite.
//
// This file makes its own scratch database (it needs exactly one admin for restricted sign-up).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-scrubid-'))
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] account deletion scrubs names by id only', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_scrubid_${process.pid}_${randomBytes(4).toString('hex')}`
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
  const { recordAudit } = await import('../workspaceAdmin')
  const { expireAccounts } = await import('./housekeeping')

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
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/editLock')).registerEditLockRoutes(api)
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
  type U = { id: string; email: string; name: string; cookie: string }
  const pw = await hashPassword('password123')
  const makeUser = async (name: string): Promise<U> => {
    const [u] = await db.insert(schema.users).values({ email: `${name.toLowerCase().replace(/\W/g, '')}-${tag()}@t.t`, name, passwordHash: pw }).returning()
    const { token } = await createSession(u.id)
    return { id: u.id, email: u.email, name: u.name, cookie: `${SESSION_COOKIE}=${token}` }
  }
  const makeWs = async (name: string, owner: U, members: { u: U; role?: 'admin' | 'member' }[] = [], createdBy: string | null = owner.id) => {
    const id = crypto.randomUUID()
    const [w] = await db.insert(schema.workspaces).values({ id, name, createdBy, ...(await generateInviteCodeColumns(db, id)) }).returning()
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: owner.id, role: 'owner' })
    for (const m of members) {
      await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: m.u.id, role: m.role ?? 'member' })
      await new Promise((r) => setTimeout(r, 5))
    }
    return w
  }
  const call = (cookie: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const ok = async <R extends { statusCode: number; body: string }>(p: Promise<R>): Promise<R> => {
    const r = await p
    assert.ok(r.statusCode < 300, r.body)
    return r
  }
  type AuditRow = { id: string; workspace_id: string; actor_id: string | null; actor_name: string; action: string; target_id: string | null; target_label: string | null; before: unknown; after: unknown }
  const auditOf = async (wsIds: string[]) =>
    (await db.execute(sql`
      SELECT id::text, workspace_id::text, actor_id::text, actor_name, action, target_id, target_label, before, after
        FROM workspace_audit_events WHERE workspace_id = ANY(${`{${wsIds.join(',')}}`}::uuid[]) ORDER BY id
    `)) as unknown as AuditRow[]
  const wsNames = async () =>
    new Map(((await db.execute(sql`SELECT id::text, name FROM workspaces`)) as unknown as { id: string; name: string }[]).map((w) => [w.id, w.name]))

  before(async () => {
    await db.insert(schema.users).values({ email: `root-${tag()}@t.t`, name: 'Root', passwordHash: pw, isAdmin: true })
  })

  it('R3 (ported): a member who takes a victim\'s display name and deletes the account leaves the victim\'s audit row and "<victim>\'s workspace" alone', async () => {
    const alice = await makeUser('Alice')
    const mallory = await makeUser('Alice') // same display name
    const ws = await makeWs("Alice's workspace", alice, [{ u: mallory }])
    await recordAudit(db, { workspaceId: ws.id, actor: alice, action: 'member.role_changed', target: { type: 'user', id: alice.id, label: 'Alice' }, after: { owner: 'Alice', role: 'owner' } })
    const before = await auditOf([ws.id])
    const r = await call(mallory.cookie, 'DELETE', '/me', { confirm: mallory.email, password: 'password123' })
    assert.equal(r.statusCode, 200, r.body)
    const afterRows = await auditOf([ws.id])
    const aliceRow = (rows: AuditRow[]) => rows.find((x) => x.actor_id === alice.id && x.action === 'member.role_changed')
    assert.deepEqual(aliceRow(afterRows), aliceRow(before))
    assert.equal(aliceRow(afterRows)!.target_label, 'Alice')
    assert.deepEqual(aliceRow(afterRows)!.after, { owner: 'Alice', role: 'owner' })
    assert.equal((await wsNames()).get(ws.id), "Alice's workspace")
  })

  it('R3b (ported): through the real routes (ID sign-up, invite links, leaving), the real Alice\'s audit rows and workspace name stay', async () => {
    const restore = setLimitsForTests({ loginIdMode: 'username', disabledFeatures: ['password-reset'], signupMaxUsers: 1000 })
    try {
      let n = 0
      const signUp = async (loginId: string, name: string) => {
        const r = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: `198.51.100.${++n}`, payload: { loginId, name, password: 'password123', formMs: 2500 } })
        assert.equal(r.statusCode, 200, r.body)
        const cookie = String(r.headers['set-cookie']).split(';')[0]
        const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json() as { user: { id: string } }
        return { id: me.user.id, loginId, cookie }
      }
      const wsOf = async (cookie: string) => ((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { cookie } })).json() as { workspaces: { id: string; name: string }[] }).workspaces
      const owner = await signUp(`owner${tag()}`, 'Olga')
      const alice = await signUp(`alice${tag()}`, 'Alice')
      const mallory = await signUp(`mallory${tag()}`, 'Alice')
      const [ow] = await wsOf(owner.cookie)
      const [aw] = await wsOf(alice.cookie)
      const [mw] = await wsOf(mallory.cookie)
      const invite = async (cookie: string, id: string) => ((await call(cookie, 'POST', `/workspaces/${id}/invite/regenerate`)).json() as { workspace: { inviteCode: string } }).workspace.inviteCode
      const oc = await invite(owner.cookie, ow.id)
      await ok(call(alice.cookie, 'POST', '/workspaces/join', { inviteCode: oc }))
      await ok(call(mallory.cookie, 'POST', '/workspaces/join', { inviteCode: oc }))
      await ok(call(mallory.cookie, 'POST', '/workspaces/join', { inviteCode: await invite(alice.cookie, aw.id) }))
      // Mallory's own workspace gets a member, so it stays (handed over) and must lose her name
      await ok(call(owner.cookie, 'POST', '/workspaces/join', { inviteCode: await invite(mallory.cookie, mw.id) }))
      const before = await auditOf([ow.id, aw.id])
      const d = await call(mallory.cookie, 'DELETE', '/me', { confirm: mallory.loginId, password: 'password123' })
      assert.equal(d.statusCode, 200, d.body)
      const afterRows = await auditOf([ow.id, aw.id])
      const aboutAlice = (rows: AuditRow[]) => rows.filter((x) => x.target_id === alice.id || x.actor_id === alice.id)
      assert.ok(aboutAlice(before).length >= 2)
      assert.deepEqual(aboutAlice(afterRows), aboutAlice(before))
      assert.ok(aboutAlice(afterRows).some((x) => x.action === 'member.joined' && x.target_label === 'Alice'))
      // Mallory's own rows lost her name
      for (const x of afterRows.filter((r) => r.target_id === mallory.id)) assert.equal(x.target_label, null)
      const names = await wsNames()
      assert.equal(names.get(aw.id), aw.name)
      assert.equal(names.get(aw.id), "Alice's workspace")
      assert.equal(names.get(mw.id), 'Workspace')
    } finally {
      restore()
    }
  })

  /**
   * Two people called "Alice"; Mallory is deleted. Rows and values about the real Alice, Bob and Olga
   * appear in every shape that copies a name: member rows, an ownership transfer each way, a lock's
   * editor list holding both Alices, agent blocks of both, and one row in the shape written before
   * 0.22's fix (an editor list without ids).
   */
  const seed = async () => {
    const alice = await makeUser('Alice')
    const mallory = await makeUser('Alice')
    const bob = await makeUser('Bob')
    const olga = await makeUser('Olga')
    const aw = await makeWs("Alice's workspace", alice, [{ u: mallory }, { u: bob }])
    const mw = await makeWs("Alice's workspace", mallory, [{ u: bob }]) // Mallory's own, handed to Bob
    const ow = await makeWs(`Olga ${tag()}`, olga, [{ u: alice }, { u: mallory }, { u: bob }])
    const tw = await makeWs(`Transfers ${tag()}`, alice, [{ u: mallory }, { u: bob }])
    // ownership transfers: Alice → Mallory (Alice's name before, Mallory's after) and back again
    await ok(call(alice.cookie, 'POST', `/workspaces/${tw.id}/transfer`, { userId: mallory.id }))
    await ok(call(mallory.cookie, 'POST', `/workspaces/${tw.id}/transfer`, { userId: alice.id }))
    // a lock whose editors are both Alices, then a change of its editor list
    const page = (await ok(call(olga.cookie, 'POST', '/pages', { workspaceId: ow.id, title: 'locked' }))).json() as { page: { id: string } }
    await ok(call(olga.cookie, 'PUT', `/pages/${page.page.id}/lock`, { locked: true, people: 'editors', editorIds: [alice.id, mallory.id] }))
    await ok(call(olga.cookie, 'PUT', `/pages/${page.page.id}/lock`, { locked: true, editorIds: [alice.id, mallory.id, bob.id] }))
    // rows about the real Alice alone, in the shapes that now carry ids: a lock with only her as editor
    const page2 = (await ok(call(olga.cookie, 'POST', '/pages', { workspaceId: ow.id, title: 'locked 2' }))).json() as { page: { id: string } }
    await ok(call(olga.cookie, 'PUT', `/pages/${page2.page.id}/lock`, { locked: true, people: 'editors', editorIds: [alice.id] }))
    // agent blocks of both Alices
    await ok(call(olga.cookie, 'POST', `/workspaces/${ow.id}/agents/blocks`, { userId: alice.id }))
    await ok(call(olga.cookie, 'POST', `/workspaces/${ow.id}/agents/blocks`, { userId: mallory.id }))
    // member rows of both, written as the routes write them
    for (const u of [alice, mallory]) {
      await recordAudit(db, { workspaceId: ow.id, actor: u, action: 'member.joined', target: { type: 'user', id: u.id, label: u.name }, after: { role: 'member', via: 'invite_link' } })
    }
    // the shape written before the fix: names without ids (cannot be told apart, so it stays)
    await db.insert(schema.workspaceAuditEvents).values({
      workspaceId: ow.id, actorId: olga.id, actorName: olga.name, action: 'page.locked',
      targetType: 'page', targetId: page.page.id, targetLabel: 'locked', after: { people: 'editors', agents: 'same', editors: ['Alice', 'Bob'] },
    })
    // rows that copy a sign-up workspace's name: an export (label) and a rename and back (before/after
    // `name`), in Mallory's own workspace and in the real Alice's identically named one
    for (const [w, by] of [[mw, mallory], [aw, alice]] as const) {
      await recordAudit(db, { workspaceId: w.id, actor: by, action: 'export.downloaded', target: { type: 'workspace', id: w.id, label: w.name }, after: { format: 'zip' } })
      await recordAudit(db, { workspaceId: w.id, actor: by, action: 'workspace.updated', target: { type: 'workspace', id: w.id, label: 'Team' }, before: { name: w.name }, after: { name: 'Team' } })
      await recordAudit(db, { workspaceId: w.id, actor: by, action: 'workspace.updated', target: { type: 'workspace', id: w.id, label: w.name }, before: { name: 'Team' }, after: { name: w.name } })
    }
    return { alice, mallory, bob, olga, aw, mw, ow, tw, pageId: page.page.id }
  }

  const check = async (s: Awaited<ReturnType<typeof seed>>, del: () => Promise<void>) => {
    const ws = [s.aw.id, s.ow.id, s.tw.id]
    const rowsBefore = await auditOf(ws)
    const namesBefore = await wsNames()
    const touchesMallory = (r: AuditRow) => JSON.stringify(r).includes(s.mallory.id)
    await del()
    const rowsAfter = await auditOf(ws)
    const byId = new Map(rowsAfter.map((r) => [r.id, r]))
    // 1. a row that does not name Mallory's id anywhere is exactly as it was
    const untouched = rowsBefore.filter((r) => !touchesMallory(r))
    assert.ok(untouched.length >= 4, `${untouched.length} rows without Mallory`)
    for (const r of untouched) assert.deepEqual(byId.get(r.id), r, `${r.action} ${r.id}`)
    // 2. in rows that name her, only her values went
    const lockRows = rowsAfter.filter((r) => (r.action === 'page.locked' || r.action === 'page.lock_editors_changed') && touchesMallory(rowsBefore.find((b) => b.id === r.id)!))
    assert.ok(untouched.some((r) => r.action === 'page.locked' && JSON.stringify(r.after).includes(s.alice.id)))
    assert.equal(lockRows.length, 2)
    // editor lists are kept in id order: compare as sets, with Mallory's entry null in both lists
    const bag = (v: unknown) => [...(v as unknown[])].map(String).sort()
    const locked = lockRows.find((r) => r.action === 'page.locked')!
    assert.deepEqual(bag((locked.after as { editors: unknown }).editors), bag(['Alice', null]))
    assert.deepEqual(bag((locked.after as { editorIds: unknown }).editorIds), bag([s.alice.id, null]))
    const changed = lockRows.find((r) => r.action === 'page.lock_editors_changed')!
    assert.deepEqual(bag((changed.before as { editors: unknown }).editors), bag(['Alice', null]))
    assert.deepEqual(bag((changed.after as { editors: unknown }).editors), bag(['Alice', 'Bob', null]))
    assert.deepEqual(bag((changed.after as { editorIds: unknown }).editorIds), bag([s.alice.id, s.bob.id, null]))
    const blocks = rowsAfter.filter((r) => r.action === 'agent.blocked')
    assert.deepEqual(blocks.map((b) => (b.after as { user: unknown }).user).sort(), ['Alice', null].sort())
    const transfers = rowsAfter.filter((r) => r.action === 'workspace.transferred' && r.workspace_id === s.tw.id)
    const toMallory = transfers.find((t) => t.actor_id === s.alice.id)!
    assert.equal((toMallory.before as { owner: unknown }).owner, 'Alice') // the real Alice, the actor
    assert.equal((toMallory.after as { owner: unknown }).owner, null) // Mallory, the target
    assert.equal(toMallory.target_label, null)
    const fromMallory = transfers.find((t) => t.target_id === s.alice.id && t.actor_id === null)!
    assert.equal((fromMallory.before as { owner: unknown }).owner, null) // Mallory, the actor
    assert.equal((fromMallory.after as { owner: unknown }).owner, 'Alice') // the real Alice, the target
    assert.equal(fromMallory.target_label, 'Alice')
    assert.equal(fromMallory.actor_name, '')
    // the row in the pre-fix shape still holds both names: nothing ties either to an id
    const legacy = rowsAfter.find((r) => r.action === 'page.locked' && !(r.after as { editorIds?: unknown }).editorIds)!
    assert.deepEqual((legacy.after as { editors: unknown }).editors, ['Alice', 'Bob'])
    // 3. workspace names: only the one Mallory made changes
    const namesAfter = await wsNames()
    for (const [id, name] of namesBefore) {
      if (id === s.mw.id) assert.equal(namesAfter.get(id), 'Workspace')
      else if (namesAfter.has(id)) assert.equal(namesAfter.get(id), name, id)
    }
    assert.equal(namesAfter.get(s.aw.id), "Alice's workspace")
    // Mallory's own workspace (handed to Bob): its audit rows no longer carry the name it was made with
    const mine = await auditOf([s.mw.id])
    assert.ok(mine.length >= 3)
    assert.ok(!JSON.stringify(mine).includes("Alice's workspace"), JSON.stringify(mine))
    assert.deepEqual(
      mine.filter((r) => r.action === 'workspace.updated').map((r) => [(r.before as { name: string }).name, (r.after as { name: string }).name]),
      [['Workspace', 'Team'], ['Team', 'Workspace']],
    )
    assert.ok(mine.some((r) => r.action === 'export.downloaded' && r.target_label === 'Workspace'))
  }

  it('leaving: rows and workspace names about other people (same display name included) never change; her own values go', async () => {
    const s = await seed()
    await check(s, async () => {
      const r = await call(s.mallory.cookie, 'DELETE', '/me', { confirm: s.mallory.email, password: 'password123' })
      assert.equal(r.statusCode, 200, r.body)
    })
  })

  it('expiry: the same', async () => {
    const s = await seed()
    await db.update(schema.users).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.users.id, s.mallory.id))
    const restore = setLimitsForTests({ accountLifetimeDays: 14 })
    try {
      await check(s, async () => {
        assert.equal(await expireAccounts(() => {}), 1)
      })
    } finally {
      restore()
    }
  })

  it('the audit screen does not show the ids kept beside names', async () => {
    const olga = await makeUser('Olga')
    const ed = await makeUser('Ed')
    const ws = await makeWs(`Screen ${tag()}`, olga, [{ u: ed }])
    const page = (await ok(call(olga.cookie, 'POST', '/pages', { workspaceId: ws.id, title: 'p' }))).json() as { page: { id: string } }
    await ok(call(olga.cookie, 'PUT', `/pages/${page.page.id}/lock`, { locked: true, people: 'editors', editorIds: [ed.id] }))
    await ok(call(olga.cookie, 'POST', `/workspaces/${ws.id}/agents/blocks`, { userId: ed.id }))
    const r = await ok(call(olga.cookie, 'GET', `/workspaces/${ws.id}/audit`))
    const events = (r.json() as { events: { action: string; after: Record<string, unknown> | null }[] }).events
    const lock = events.find((e) => e.action === 'page.locked')!
    assert.deepEqual(lock.after, { people: 'editors', agents: 'same', editors: ['Ed'] })
    const block = events.find((e) => e.action === 'agent.blocked')!
    assert.deepEqual(block.after, { user: 'Ed', client: 'all' })
    assert.ok(!r.body.includes(`"editorIds"`) && !r.body.includes(`"userId":"${ed.id}"`))
  })
})
