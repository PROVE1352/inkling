// No trace of a deleted account's name or sign-in ID (0.22.1, contract §15, review N6, docs/adr/2547-*).
// The review found page access audit rows ({ person: name }) that kept the name after the account left,
// and the earlier "no trace" test only checked rows written by hand. Here every kind of audit row a
// person's name can land in is made through the real routes (page access granted, changed, removed;
// lock and lock editors; agent block and unblock; joining, role changes, export, invite links, ownership
// transfer, a guest invitation to the account's address, the workspace made at sign-up), the account
// deletes itself (DELETE /api/me), and then every text, varchar, json, jsonb, text[] and bytea column of
// every table is searched for the name and the address. Left on purpose (contract §13): another member's
// comment that mentions the person by name.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR ||= mkdtempSync(path.join(tmpdir(), 'inkling-auditnames-'))
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

describe('[db] account deletion leaves no name or sign-in ID behind (review N6)', { skip: !process.env.DATABASE_URL }, async () => {
  if (!process.env.DATABASE_URL) return
  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { createSession, SESSION_COOKIE, hashPassword } = await import('../auth')

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
      await (await import('../routes/pageContent')).registerPageContentRoutes(api)
      await (await import('../routes/pageAccess')).registerPageAccessRoutes(api)
      await (await import('../routes/editLock')).registerEditLockRoutes(api)
      await (await import('../routes/comments')).registerCommentRoutes(api)
      await (await import('../routes/snapshots')).registerSnapshotRoutes(api)
      await (await import('../routes/exportImport')).registerExportImportRoutes(api)
      await (await import('../restricted')).registerRestrictedMode(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
    setTimeout(() => process.exit(0), 300).unref()
  })

  const tag = randomBytes(4).toString('hex')
  const pw = await hashPassword('password123')
  type U = { id: string; email: string; name: string; cookie: string }
  const makeUser = async (name: string, email = `${name.toLowerCase()}-${tag}@t.t`): Promise<U> => {
    const [u] = await db.insert(schema.users).values({ email, name, passwordHash: pw }).returning()
    const { token } = await createSession(u.id)
    return { id: u.id, email: u.email, name: u.name, cookie: `${SESSION_COOKIE}=${token}` }
  }
  const call = (u: U, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: u.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) })
  const step = async (what: string, u: U, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const r = await call(u, method, url, payload)
    assert.ok(r.statusCode < 300, `${what}: ${r.statusCode} ${r.body.slice(0, 300)}`)
    return r
  }

  /** Columns of every table holding `needle` (case-insensitive for text, bytes for bytea): "table.column" → rows. */
  const sweep = async (needle: string): Promise<Record<string, number>> => {
    const cols = (await db.execute(sql`
      SELECT c.table_name AS t, c.column_name AS c, c.data_type AS d
        FROM information_schema.columns c
        JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
       WHERE c.table_schema = 'public' AND x.table_type = 'BASE TABLE'
         AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'bytea') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
    `)) as unknown as { t: string; c: string; d: string }[]
    const out: Record<string, number> = {}
    for (const { t, c, d } of cols) {
      const cond =
        d === 'bytea'
          ? sql`position(convert_to(${needle}, 'UTF8') in ${sql.identifier(c)}) > 0`
          : sql`lower(${sql.identifier(c)}::text) LIKE ${'%' + needle.toLowerCase() + '%'}`
      const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE ${cond}`)) as unknown as { n: number }[]
      if (Number(r.n) > 0) out[`${t}.${c}`] = Number(r.n)
    }
    return out
  }

  it('every audit row kind made through the routes; after DELETE /api/me nothing names the account but another member\'s mention', async () => {
    const A = await makeUser(`Olga${tag}`)
    const B = await makeUser(`Bo${tag}`)
    const leaverName = `Qz${tag}Leaver`
    const leaverEmail = `lv${tag}@t.t`

    // A's team workspace with a shared page
    const W = (await step('create Team', A, 'POST', '/api/workspaces', { name: `Team ${tag}` })).json().workspace.id as string
    const P = ((await step('page', A, 'POST', '/api/pages', { workspaceId: W, title: 'shared' })).json() as { page: { id: string } }).page.id
    // a guest invitation to the address before the account exists (page.guest_invited keeps the address)
    await step('guest invitation', A, 'PUT', `/api/pages/${P}/access`, { email: leaverEmail, level: 'view' })
    const L = await makeUser(leaverName, leaverEmail)

    const code = (await step('invite link', A, 'POST', `/api/workspaces/${W}/invite/regenerate`)).json().workspace.inviteCode as string
    await step('L joins', L, 'POST', '/api/workspaces/join', { inviteCode: code })
    await step('B joins', B, 'POST', '/api/workspaces/join', { inviteCode: code })
    await step('access granted', A, 'PUT', `/api/pages/${P}/access`, { userId: L.id, level: 'view' })
    await step('access changed', A, 'PUT', `/api/pages/${P}/access`, { userId: L.id, level: 'comment' })
    await step('access removed', A, 'DELETE', `/api/pages/${P}/access/${L.id}`)
    await step('lock', A, 'PUT', `/api/pages/${P}/lock`, { locked: true, editorIds: [L.id] })
    await step('lock editors', A, 'PUT', `/api/pages/${P}/lock`, { locked: true, editorIds: [L.id, B.id] })
    await step('unlock', A, 'PUT', `/api/pages/${P}/lock`, { locked: false })
    const blk = (await step('agent block', A, 'POST', `/api/workspaces/${W}/agents/blocks`, { userId: L.id })).json().block.id as string
    await step('agent unblock', A, 'DELETE', `/api/workspaces/${W}/agents/blocks/${blk}`)
    // the leaver as an admin: role changes, an export and a new invite link by the leaver
    await step('L admin', A, 'PATCH', `/api/workspaces/${W}/members/${L.id}`, { role: 'admin' })
    await step('L export', L, 'GET', `/api/workspaces/${W}/export`)
    await step('L invite link', L, 'POST', `/api/workspaces/${W}/invite/regenerate`)
    await step('L comment', L, 'POST', `/api/pages/${P}/comments`, { blockId: 'b1', body: `hello @${A.name}`, mentionUserIds: [A.id] })
    await step('A mentions L', A, 'POST', `/api/pages/${P}/comments`, { blockId: 'b1', body: `@${leaverName} see this`, mentionUserIds: [L.id] })
    await step('L back to member', A, 'PATCH', `/api/workspaces/${W}/members/${L.id}`, { role: 'member' })
    // the leaver's own team, handed to B (workspace.transferred keeps both owners' names)
    const LT = (await step('L team', L, 'POST', '/api/workspaces', { name: `LTeam ${tag}` })).json().workspace.id as string
    const lcode = (await step('L team invite', L, 'POST', `/api/workspaces/${LT}/invite/regenerate`)).json().workspace.inviteCode as string
    await step('B joins L team', B, 'POST', '/api/workspaces/join', { inviteCode: lcode })
    await step('transfer', L, 'POST', `/api/workspaces/${LT}/transfer`, { userId: B.id })
    // the workspace made at sign-up, named after the leaver, with B in it (taken over and renamed on deletion)
    const personal = (await step('personal', L, 'POST', '/api/workspaces', { name: `${leaverName}'s workspace` })).json().workspace.id as string
    await db.update(schema.workspaces).set({ createdBy: L.id }).where(eq(schema.workspaces.id, personal))
    const pcode = (await step('personal invite', L, 'POST', `/api/workspaces/${personal}/invite/regenerate`)).json().workspace.inviteCode as string
    await step('B joins personal', B, 'POST', '/api/workspaces/join', { inviteCode: pcode })

    // before: the name is in each of these audit row kinds, the address in the invitation's
    const kinds = (await db.execute(sql`
      SELECT DISTINCT action FROM workspace_audit_events
       WHERE workspace_id IN (${W}, ${LT}, ${personal})
         AND (actor_name = ${leaverName} OR target_label LIKE ${'%' + leaverName + '%'} OR before::text LIKE ${'%' + leaverName + '%'} OR after::text LIKE ${'%' + leaverName + '%'})
       ORDER BY 1
    `)) as unknown as { action: string }[]
    const expected = [
      'agent.blocked', 'agent.unblocked', 'export.downloaded', 'invite.regenerated', 'member.joined', 'member.role_changed',
      'page.access_changed', 'page.access_granted', 'page.access_removed', 'page.lock_editors_changed', 'page.locked', 'workspace.transferred',
    ]
    for (const k of expected) assert.ok(kinds.some((r) => r.action === k), `before deletion the name is in ${k} (found ${kinds.map((r) => r.action).join(',')})`)
    assert.ok((await sweep(leaverEmail))['workspace_audit_events.after'] >= 1, 'the invitation row names the address')
    // the audit screen shows no id kept beside a name
    const screen = (await step('audit screen', A, 'GET', `/api/workspaces/${W}/audit`)).body
    assert.doesNotMatch(screen, /personId|editorIds|"userId"/)

    const d = await call(L, 'DELETE', '/api/me', { confirm: leaverEmail, password: 'password123' })
    assert.equal(d.statusCode, 200, d.body)

    const nameLeft = await sweep(leaverName)
    const emailLeft = await sweep(leaverEmail)
    console.log(`[N6] after deletion: name in ${JSON.stringify(nameLeft)}; address in ${JSON.stringify(emailLeft)}`)
    // another member's comment that mentions the leaver by name is that member's writing (contract §13)
    assert.deepEqual(nameLeft, { 'comments.body': 1 })
    assert.deepEqual(emailLeft, {})
    // and the rows about the others are untouched
    const olga = await sweep(A.name)
    assert.ok((olga['workspace_audit_events.actor_name'] ?? 0) >= 8, `A's rows keep A's name: ${JSON.stringify(olga)}`)
  })
})
