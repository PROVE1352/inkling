// Secrets at rest (docs/adr/1110-*, 1111-*) and the workspace policy "require two-step
// verification" (docs/adr/1112-*): legacy plaintext share tokens, invite codes, signup keys and
// webhook/sheet URLs keep working after the boot pass, the database holds no raw value afterwards,
// the key-less mode, and the 2FA requirement (grace, block, admin precondition, agents, audit).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
// Same test key as authSecurity.test.ts: suites share one database.
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-secrets-${process.pid}`
process.env.SIGNUP_REQUIRE_KEY = '1'
process.env.AUTH_GUARD_MAX_FAILURES ||= '1000'
process.env.AUTH_GUARD_ACCOUNT_FAILURES ||= '1000'
process.env.WEBHOOK_TEST_ALLOW_LOOPBACK = '1'

import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('[db] secrets at rest and required two-step verification', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const h = await import('./mcpTools/testHarness')
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, and, sql } = await import('drizzle-orm')
  const { env } = await import('./env')
  const { _resetSecretBoxCache } = await import('./secretBox')
  const { migrateSecretsAtRest } = await import('./secretsAtRest')
  const { newInviteCode, newSignupKey } = await import('./util')
  const { hashPassword } = await import('./auth')
  const { isTwoFactorBlocked } = await import('./twoFactorPolicy')
  const { invalidateWebhookCache } = await import('./webhooks')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const Fastify = (await import('fastify')).default

  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('./routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('./routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
      await (await import('./routes/pages')).registerPageRoutes(api)
      await (await import('./routes/pageContent')).registerPageContentRoutes(api)
      await (await import('./routes/public')).registerPublicRoutes(api)
      await (await import('./routes/auth')).registerAuthRoutes(api)
      await (await import('./routes/admin')).registerAdminRoutes(api)
      await (await import('./routes/webhooks')).registerWebhookRoutes(api)
      await (await import('./routes/notifications')).registerNotificationRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  // The MCP tools reach the full REST surface of the shared harness app.
  const mcpApp = await h.buildTestApp()

  // Loopback "Slack" that records deliveries.
  const bodies: string[] = []
  const hookServer = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      bodies.push(b)
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()))
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`

  const KEY = env.appSecretKey
  const withKey = (on: boolean) => {
    env.appSecretKey = on ? KEY : null
    _resetSecretBoxCache()
  }
  before(() => withKey(true))
  after(async () => {
    withKey(true)
    await new Promise<void>((r) => hookServer.close(() => r()))
    await app.close()
    await mcpApp.close()
    await closeDb()
  })

  type U = Awaited<ReturnType<typeof h.makeUser>>
  const req = (u: U | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api${url}`,
      headers: u ? { cookie: u.cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0]
  const wsOf = async (u: U, wsId: string) =>
    ((await req(u, 'GET', '/workspaces')).json() as { workspaces: { id: string; inviteCode: string; twoFactor?: { state: string; deadline: string | null } }[] }).workspaces.find((w) => w.id === wsId)

  /** A workspace whose secrets look like an install from before 1110 (plaintext everywhere). */
  async function legacyInstall() {
    const owner = await h.makeUser('owner')
    const ws = await h.makeWorkspace(owner)
    const invite = newInviteCode()
    await db.update(schema.workspaces).set({ inviteCode: invite, inviteCodeEnc: null }).where(eq(schema.workspaces.id, ws.id))
    const token = randomBytes(16).toString('base64url')
    const page = await h.makeDocPage(ws.id, owner.id, 'Shared doc', [], { shareToken: token })
    const coll = await h.makeDocPage(ws.id, owner.id, 'Sheet', [], { kind: 'collection' })
    await db.insert(schema.collectionSheetSyncs).values({
      pageId: coll.id,
      workspaceId: ws.id,
      url: 'https://docs.google.com/spreadsheets/d/secretsheet/export?format=csv',
      keyColumn: 'id',
    })
    const [hook] = await db
      .insert(schema.workspaceWebhooks)
      .values({ workspaceId: ws.id, kind: 'slack', url: hookUrl, events: ['comment'], createdBy: owner.id })
      .returning()
    // a used single-use key (= that person's recovery code) and an unused multi-use key
    const usedKey = newSignupKey()
    const freeKey = newSignupKey()
    await db.insert(schema.signupKeys).values([
      { key: usedKey, maxUses: 1, usedCount: 1 },
      { key: freeKey, maxUses: 5 },
    ])
    const [keyUser] = await db
      .insert(schema.users)
      .values({ email: `legacy-${randomUUID().slice(0, 8)}@test.dev`, name: 'Legacy', passwordHash: await hashPassword('old password 1'), signupKey: usedKey })
      .returning()
    return { owner, ws, invite, token, page, coll, hook, usedKey, freeKey, keyUser }
  }

  /** The lookup columns hold no raw value; with the key, neither do the copies. */
  async function assertNoRawValues(l: Awaited<ReturnType<typeof legacyInstall>>, keyed = true) {
    const [p] = await db.select().from(schema.pages).where(eq(schema.pages.id, l.page.id))
    assert.equal(p.shareToken, sha(l.token))
    if (keyed) assert.ok(!p.shareTokenEnc?.includes(l.token))
    const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, l.ws.id))
    assert.equal(w.inviteCode, sha(l.invite))
    for (const k of [l.usedKey, l.freeKey]) {
      assert.equal((await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, k))).length, 0)
    }
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, l.keyUser.id))
    assert.equal(u.signupKey, sha(l.usedKey))
    const raw = await one<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM pages WHERE share_token = ${l.token})
           + (SELECT count(*) FROM workspaces WHERE invite_code = ${l.invite})
           + (SELECT count(*) FROM signup_keys WHERE key IN (${l.usedKey}, ${l.freeKey}))
           + (SELECT count(*) FROM users WHERE signup_key IN (${l.usedKey}, ${l.freeKey})) AS n`)
    assert.equal(Number(raw.n), 0)
  }

  // ------------------------------------------------------------------ 1110 / 1111 with the key
  it('legacy plaintext link secrets and URLs keep working after the boot pass; the DB holds no raw value', async () => {
    const l = await legacyInstall()
    const admin = await h.makeUser('admin')
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin.id))

    const r1 = await migrateSecretsAtRest({ workspaceIds: [l.ws.id] })
    // hashed: share token, invite code, two signup keys (their accounts move in the same step);
    // sealed here: webhook + sheet URL (the copies were sealed while hashing)
    assert.ok(r1.hashed >= 4, JSON.stringify(r1))
    assert.ok(r1.sealed >= 2, JSON.stringify(r1))
    await assertNoRawValues(l)
    // copies and URLs are sealed, bound to their row
    const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, l.ws.id))
    assert.match(w.inviteCodeEnc!, /^v1\./)
    const [hk] = await db.select().from(schema.workspaceWebhooks).where(eq(schema.workspaceWebhooks.id, l.hook.id))
    assert.match(hk.url, /^v1\./)
    assert.ok(!hk.url.includes('127.0.0.1'))
    const [ss] = await db.select().from(schema.collectionSheetSyncs).where(eq(schema.collectionSheetSyncs.pageId, l.coll.id))
    assert.match(ss.url, /^v1\./)
    assert.ok(!ss.url.includes('secretsheet'))
    const [used] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, sha(l.usedKey)))
    assert.equal(used.keyEnc, null, 'a used single-use key keeps no copy')
    assert.equal(used.keyHint, l.usedKey.slice(-4))
    const [free] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, sha(l.freeKey)))
    assert.match(free.keyEnc!, /^v1\./)

    // idempotent
    const r2 = await migrateSecretsAtRest({ workspaceIds: [l.ws.id] })
    assert.equal(r2.hashed, 0)
    assert.equal(r2.sealed, 0)

    // public link: the old URL works, the stored hash is not a usable token
    assert.equal((await req(null, 'GET', `/public/${l.token}`)).statusCode, 200)
    assert.equal((await req(null, 'GET', `/public/${sha(l.token)}`)).statusCode, 404)
    // "copy link" shows the same token, publishing again keeps it
    assert.equal((await req(l.owner, 'GET', `/pages/${l.page.id}/share`)).json().token, l.token)
    assert.equal((await req(l.owner, 'POST', `/pages/${l.page.id}/share`)).json().token, l.token)
    const shared = (await req(l.owner, 'GET', `/workspaces/${l.ws.id}/shared`)).json() as { items: { id: string; token: string }[] }
    assert.equal(shared.items.find((i) => i.id === l.page.id)?.token, l.token)

    // invite link: shown again to the owner, works (any case), the hash does not
    assert.equal((await wsOf(l.owner, l.ws.id))?.inviteCode, l.invite)
    const joiner = await h.makeUser('joiner')
    assert.equal((await req(joiner, 'GET', `/workspaces/invite-preview?code=${l.invite.toLowerCase()}`)).statusCode, 200)
    assert.equal((await req(joiner, 'POST', '/workspaces/join', { inviteCode: ` ${l.invite.toLowerCase()} ` })).statusCode, 200)
    assert.equal((await req(joiner, 'POST', '/workspaces/join', { inviteCode: sha(l.invite).slice(0, 20) })).statusCode, 404)

    // signup keys: the free key signs up (any case), the used one does not; the used key still
    // works as its person's recovery code
    const email = `new-${randomUUID().slice(0, 8)}@test.dev`
    const reg = await req(null, 'POST', '/auth/register', { email, name: 'New', password: 'new password 1', signupKey: l.freeKey.toLowerCase() })
    assert.equal(reg.statusCode, 200, reg.body)
    const [newUser] = await db.select().from(schema.users).where(eq(schema.users.email, email))
    assert.equal(newUser.signupKey, sha(l.freeKey))
    const reg2 = await req(null, 'POST', '/auth/register', { email: `x-${email}`, name: 'X', password: 'new password 1', signupKey: l.usedKey })
    assert.equal(reg2.statusCode, 403)
    const reset = await req(null, 'POST', '/auth/reset-password', { email: l.keyUser.email, code: l.usedKey, newPassword: 'brand new password 2' })
    assert.equal(reset.statusCode, 200, reset.body)

    // admin screen: the free key is shown again, the used one only as a hint; ids revoke
    const keys = (await req(admin, 'GET', '/admin/signup-keys')).json().keys as { id: string; key: string | null; keyHint: string; usedBy: { email: string }[] }[]
    const kFree = keys.find((k) => k.id === sha(l.freeKey))!
    assert.equal(kFree.key, l.freeKey)
    assert.deepEqual(kFree.usedBy.map((u) => u.email), [email])
    const kUsed = keys.find((k) => k.id === sha(l.usedKey))!
    assert.equal(kUsed.key, null)
    assert.equal(kUsed.keyHint, l.usedKey.slice(-4))
    const users = (await req(admin, 'GET', '/admin/users')).json().users as { id: string; signupKey: string | null; signupKeyRecovery: boolean }[]
    const lu = users.find((u) => u.id === l.keyUser.id)!
    assert.equal(lu.signupKey, `••••-${l.usedKey.slice(-4)}`)
    assert.equal(lu.signupKeyRecovery, true)
    const mail = await req(admin, 'POST', `/admin/signup-keys/${kUsed.id}/send-invite`, { to: 'a@b.c' })
    assert.ok([409, 501].includes(mail.statusCode), mail.body) // 501 when mail is off in tests
    assert.equal((await req(admin, 'DELETE', `/admin/signup-keys/${kFree.id}`)).statusCode, 200)

    // webhook: the sealed URL is delivered to; the list shows only the masked form
    bodies.length = 0
    invalidateWebhookCache(l.ws.id)
    const test = await req(l.owner, 'POST', `/webhooks/${l.hook.id}/test`)
    assert.equal(test.json().ok, true, test.body)
    assert.equal(bodies.length, 1)
    const list = (await req(l.owner, 'GET', `/workspaces/${l.ws.id}/webhooks`)).json().webhooks as { urlMasked: string }[]
    assert.ok(list[0].urlMasked.endsWith('/••••'))
  })

  it('new link secrets are stored hashed and URLs sealed by the routes', async () => {
    const owner = await h.makeUser('owner2')
    const admin = await h.makeUser('admin2')
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin.id))
    const created = (await req(owner, 'POST', '/workspaces', { name: 'Fresh' })).json().workspace as { id: string; inviteCode: string }
    assert.match(created.inviteCode, /^[A-Z2-9]{10}$/)
    const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, created.id))
    assert.equal(w.inviteCode, sha(created.inviteCode))
    assert.match(w.inviteCodeEnc!, /^v1\./)

    const page = await h.makeDocPage(created.id, owner.id, 'Pub', [])
    const tok = (await req(owner, 'POST', `/pages/${page.id}/share`)).json().token as string
    const [p] = await db.select().from(schema.pages).where(eq(schema.pages.id, page.id))
    assert.equal(p.shareToken, sha(tok))
    assert.equal((await req(null, 'GET', `/public/${tok}`)).statusCode, 200)
    assert.equal((await req(owner, 'DELETE', `/pages/${page.id}/share`)).statusCode, 200)
    const [p2] = await db.select().from(schema.pages).where(eq(schema.pages.id, page.id))
    assert.equal(p2.shareToken, null)
    assert.equal(p2.shareTokenEnc, null)
    assert.equal((await req(null, 'GET', `/public/${tok}`)).statusCode, 404)

    const hook = await req(owner, 'POST', `/workspaces/${created.id}/webhooks`, { url: hookUrl, events: ['comment'], kind: 'slack' })
    assert.equal(hook.statusCode, 200, hook.body)
    const [hk] = await db.select().from(schema.workspaceWebhooks).where(eq(schema.workspaceWebhooks.workspaceId, created.id))
    assert.match(hk.url, /^v1\./)
    bodies.length = 0
    assert.equal((await req(owner, 'POST', `/webhooks/${hk.id}/test`)).json().ok, true)
    assert.equal(bodies.length, 1)

    const k = (await req(admin, 'POST', '/admin/signup-keys', { maxUses: 1 })).json().key as { id: string; key: string }
    assert.equal(k.id, sha(k.key))
    const [row] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, k.id))
    assert.match(row.keyEnc!, /^v1\./)
    const email = `fresh-${randomUUID().slice(0, 8)}@test.dev`
    const reg = await req(null, 'POST', '/auth/register', { email, name: 'F', password: 'fresh password 1', signupKey: k.key })
    assert.equal(reg.statusCode, 200, reg.body)
    const [row2] = await db.select().from(schema.signupKeys).where(eq(schema.signupKeys.key, k.id))
    assert.equal(row2.usedCount, 1)
    assert.equal(row2.keyEnc, null, 'used up → no copy left')
  })

  // ------------------------------------------------------------------ without APP_SECRET_KEY
  it('without APP_SECRET_KEY: lookups are hashed, copies and URLs stay plaintext, everything works; sealed rows are reported', async () => {
    const sealedInstall = await legacyInstall()
    await migrateSecretsAtRest({ workspaceIds: [sealedInstall.ws.id] }) // sealed with the key
    withKey(false)
    try {
      const l = await legacyInstall()
      const r = await migrateSecretsAtRest({ workspaceIds: [l.ws.id, sealedInstall.ws.id] })
      assert.ok(r.hashed >= 4, JSON.stringify(r))
      assert.equal(r.sealed, 0)
      assert.ok(r.plaintext >= 4, JSON.stringify(r)) // share copy, invite copy, webhook URL, sheet URL (+ free key)
      assert.ok(r.unreadable >= 4, JSON.stringify(r)) // the other install's sealed values
      await assertNoRawValues(l, false)
      const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, l.ws.id))
      assert.equal(w.inviteCodeEnc, l.invite, 'key-less copy is plaintext')

      assert.equal((await req(null, 'GET', `/public/${l.token}`)).statusCode, 200)
      assert.equal((await req(l.owner, 'GET', `/pages/${l.page.id}/share`)).json().token, l.token)
      assert.equal((await wsOf(l.owner, l.ws.id))?.inviteCode, l.invite)
      bodies.length = 0
      assert.equal((await req(l.owner, 'POST', `/webhooks/${l.hook.id}/test`)).json().ok, true)
      assert.equal(bodies.length, 1)
      const hook = await req(l.owner, 'POST', `/workspaces/${l.ws.id}/webhooks`, { url: `${hookUrl}2`, events: ['comment'], kind: 'slack' })
      assert.equal(hook.json().webhook.urlMasked.endsWith('/••••'), true)
      const plainNew = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM workspace_webhooks WHERE workspace_id = ${l.ws.id} AND url = ${`${hookUrl}2`}`)
      assert.equal(plainNew.n, 1)

      // values sealed under the (now missing) key: links cannot be shown, the old link still opens,
      // "publish" issues a replacement; the webhook fails with a clear error instead of a URL error
      const s = sealedInstall
      assert.equal((await req(null, 'GET', `/public/${s.token}`)).statusCode, 200)
      assert.equal((await req(s.owner, 'GET', `/pages/${s.page.id}/share`)).json().shared, false)
      const again = (await req(s.owner, 'POST', `/pages/${s.page.id}/share`)).json().token as string
      assert.notEqual(again, s.token)
      assert.equal((await req(null, 'GET', `/public/${again}`)).statusCode, 200)
      assert.equal((await wsOf(s.owner, s.ws.id))?.inviteCode, '')
      const t = (await req(s.owner, 'POST', `/webhooks/${s.hook.id}/test`)).json()
      assert.equal(t.ok, false)
      assert.match(t.error, /cannot be decrypted/)

      // 2FA requirement cannot be turned on without the key
      const off = await req(l.owner, 'PUT', `/workspaces/${l.ws.id}/settings/two-factor`, { required: true })
      assert.equal(off.statusCode, 501)
      assert.equal(off.json().error.code, 'TWO_FACTOR_UNAVAILABLE')
    } finally {
      withKey(true)
    }
  })

  it('setting APP_SECRET_KEY later seals the key-less plaintext copies at the next boot', async () => {
    withKey(false)
    const l = await legacyInstall()
    await migrateSecretsAtRest({ workspaceIds: [l.ws.id] })
    withKey(true)
    const r = await migrateSecretsAtRest({ workspaceIds: [l.ws.id] })
    assert.ok(r.sealed >= 4, JSON.stringify(r))
    const left = await one<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM workspaces WHERE id = ${l.ws.id} AND invite_code_enc NOT LIKE 'v1.%')
           + (SELECT count(*) FROM pages WHERE workspace_id = ${l.ws.id} AND share_token_enc NOT LIKE 'v1.%')
           + (SELECT count(*) FROM workspace_webhooks WHERE workspace_id = ${l.ws.id} AND url NOT LIKE 'v1.%') AS n`)
    assert.equal(Number(left.n), 0)
    assert.equal((await wsOf(l.owner, l.ws.id))?.inviteCode, l.invite)
    assert.equal((await req(l.owner, 'GET', `/pages/${l.page.id}/share`)).json().token, l.token)
    bodies.length = 0
    assert.equal((await req(l.owner, 'POST', `/webhooks/${l.hook.id}/test`)).json().ok, true)
  })

  // ------------------------------------------------------------------ 1112 require 2FA
  describe('require two-step verification', () => {
    const enable2fa = async (u: { id: string }) =>
      db.insert(schema.userTotp).values({ userId: u.id, secretEnc: 'x', enabledAt: new Date() }).onConflictDoNothing()

    it('switch: managers only, own 2FA first, grace then 403, agents follow their owner, delegated accounts pass, audited', async () => {
      const owner = await h.makeUser('tf-owner')
      const admin = await h.makeUser('tf-admin')
      const member = await h.makeUser('tf-member')
      const deleg = await h.makeUser('tf-delegated')
      await db.update(schema.users).set({ origin: 'delegated' }).where(eq(schema.users.id, deleg.id))
      const ws = await h.makeWorkspace(owner, [admin, member, deleg])
      await db
        .update(schema.workspaceMembers)
        .set({ role: 'admin' })
        .where(and(eq(schema.workspaceMembers.workspaceId, ws.id), eq(schema.workspaceMembers.userId, admin.id)))
      const page = await h.makeDocPage(ws.id, owner.id, 'Secret plans', [])
      const put = (u: U, body: unknown) => req(u, 'PUT', `/workspaces/${ws.id}/settings/two-factor`, body)

      // a member cannot, an admin without 2FA cannot, an admin with 2FA can
      assert.equal((await put(member, { required: true })).statusCode, 403)
      const self = await put(admin, { required: true })
      assert.equal(self.statusCode, 403)
      assert.equal(self.json().error.code, 'TWO_FACTOR_SELF_REQUIRED')
      await enable2fa(admin)
      const on = await put(admin, { required: true, graceDays: 7 })
      assert.equal(on.statusCode, 200, on.body)
      assert.equal(on.json().twoFactor.required, true)
      assert.equal(on.json().twoFactor.membersWithout.count, 2) // owner and member; the delegated account passes

      // in grace: banner state, access allowed
      assert.equal((await wsOf(member, ws.id))?.twoFactor?.state, 'grace')
      assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 200)
      assert.equal(await isTwoFactorBlocked(ws.id, member.id), false)

      // grace over: workspace API, page routes and collaboration refuse; the list still shows it
      await db.execute(sql`UPDATE workspaces SET two_factor_required_at = now() - interval '8 days' WHERE id = ${ws.id}`)
      const blocked = await req(member, 'GET', `/workspaces/${ws.id}/members`)
      assert.equal(blocked.statusCode, 403)
      assert.equal(blocked.json().error.code, 'TWO_FACTOR_REQUIRED')
      assert.equal(blocked.json().error.workspaceId, ws.id)
      assert.equal((await req(member, 'GET', `/pages/${page.id}/backlinks`)).statusCode, 403)
      assert.equal((await wsOf(member, ws.id))?.twoFactor?.state, 'blocked')
      assert.equal(await isTwoFactorBlocked(ws.id, member.id), true)
      assert.equal((await req(owner, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 403, 'the owner without 2FA too')
      assert.equal((await req(deleg, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 200)
      assert.equal((await wsOf(deleg, ws.id))?.twoFactor?.state, 'ok')
      assert.equal((await req(admin, 'GET', `/pages/${page.id}/backlinks`)).statusCode, 200)

      // agents act as their token's owner
      const mBlocked = await h.connectMcp(mcpApp, { ...member, via: 'Test Agent' }, await h.mintToken(member))
      const mOk = await h.connectMcp(mcpApp, { ...admin, via: 'Test Agent' }, await h.mintToken(admin))
      try {
        const r = await mBlocked.tool('read_page', { pageId: page.id })
        assert.equal(r.isError, true)
        assert.match(r.text, /two-step verification/i)
        assert.equal((await mOk.tool('read_page', { pageId: page.id })).isError, false)
      } finally {
        await mBlocked.close()
        await mOk.close()
      }

      // turning 2FA on lifts the block at once
      await enable2fa(member)
      assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 200)
      assert.equal((await wsOf(member, ws.id))?.twoFactor?.state, 'ok')

      // shortening the grace keeps the start; turning off clears it; both audited
      assert.equal((await put(admin, { required: true, graceDays: 0 })).statusCode, 200)
      assert.equal((await put(admin, { required: false })).statusCode, 200)
      assert.equal((await req(owner, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 200)
      const ev = await db
        .select()
        .from(schema.workspaceAuditEvents)
        .where(and(eq(schema.workspaceAuditEvents.workspaceId, ws.id), eq(schema.workspaceAuditEvents.action, 'settings.updated')))
        .orderBy(schema.workspaceAuditEvents.id)
      assert.deepEqual(
        ev.map((e) => [e.actorId, e.before, e.after]),
        [
          [admin.id, { twoFactorRequired: false }, { twoFactorRequired: true }],
          [admin.id, { twoFactorGraceDays: 7 }, { twoFactorGraceDays: 0 }],
          [admin.id, { twoFactorRequired: true }, { twoFactorRequired: false }],
        ],
      )
    })

    it('grace 0 blocks at once; notifications of the blocked workspace are held back', async () => {
      const owner = await h.makeUser('g0-owner')
      const member = await h.makeUser('g0-member')
      await enable2fa(owner)
      const ws = await h.makeWorkspace(owner, [member])
      const page = await h.makeDocPage(ws.id, owner.id, 'Held back title', [])
      await db.insert(schema.notifications).values({ userId: member.id, type: 'comment', pageId: page.id, workspaceId: ws.id, actorId: owner.id } as never)
      const titles = async () =>
        ((await req(member, 'GET', '/notifications')).json() as { notifications: { pageTitle: string | null }[] }).notifications.map((n) => n.pageTitle)
      assert.ok((await titles()).includes('Held back title'))
      assert.equal((await req(owner, 'PUT', `/workspaces/${ws.id}/settings/two-factor`, { required: true, graceDays: 0 })).statusCode, 200)
      assert.equal((await req(member, 'GET', `/workspaces/${ws.id}/members`)).statusCode, 403)
      assert.ok(!(await titles()).includes('Held back title'))
      const settings = await req(owner, 'GET', `/workspaces/${ws.id}/settings`)
      assert.equal(settings.json().twoFactor.graceDays, 0)
      assert.deepEqual(settings.json().twoFactor.membersWithout.members.map((m: { id: string }) => m.id), [member.id])
    })
  })
})
