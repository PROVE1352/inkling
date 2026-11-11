// Never-used self-registered OAuth clients (0.22 security fix F3, contract §14, docs/adr/2536-*).
// POST /oauth/register needs no account; with OAUTH_UNUSED_CLIENT_HOURS the hourly housekeeping
// deletes the registrations nothing ever used, and with OAUTH_UNUSED_CLIENT_MAX a registration
// pushes out the oldest never-used one (never one younger than PROTECT_MINUTES). A client with a
// code, a grant, an agent block or an agent access record is never deleted, and neither are agent
// connection tokens' and metadata-document clients. Without the settings nothing is deleted.
// Ported from the review's R1 (w22-reports/sec/sec.db.test.ts): 40 registrations, none ever deleted.
//
// This file makes its own scratch database: it ages and deletes client rows of the whole table.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-oauthclients-'))

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, beforeEach, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] never-used OAuth clients', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_oauthcl_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('./db/index')
  await runMigrations()
  const schema = await import('./db/schema')
  const { sql } = await import('drizzle-orm')
  const { setLimitsForTests } = await import('./limits')
  const { runRegisteredHousekeepingTasks } = await import('./restrictedExtras')
  const { OAUTH_CLIENT_REFERENCES, PROTECT_MINUTES, purgeUnusedOAuthClients, countUnusedClients } = await import('./oauthClientCleanup')
  const { purgeExpiredOAuth } = await import('./oauth')
  const { generateInviteCodeColumns } = await import('./helpers')

  const Fastify = (await import('fastify')).default
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(async (api) => {
    await (await import('./restricted')).registerRestrictedMode(api)
  }, { prefix: '/api' })
  await app.register(async (root) => {
    await (await import('./routes/oauth')).registerOAuthRoutes(root)
  })
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  })

  const tag = () => randomBytes(4).toString('hex')
  const register = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/oauth/register', remoteAddress: `198.51.100.${1 + Math.floor(Math.random() * 200)}`, payload: { client_name: `c${tag()}`, redirect_uris: ['https://app.example.com/cb'], ...payload } })
  const ids = async () => new Set(((await db.execute(sql`SELECT id FROM oauth_clients`)) as unknown as { id: string }[]).map((r) => r.id))
  /** A client row registered `ageMin` minutes ago. */
  const client = async (ageMin: number, id = `ink_c_${tag()}${tag()}`) => {
    await db.insert(schema.oauthClients).values({ id, name: `n${tag()}`, redirectUris: ['https://app.example.com/cb'], createdAt: new Date(Date.now() - ageMin * 60_000) })
    return id
  }
  const user = async () => (await db.insert(schema.users).values({ email: `u-${tag()}@t.t`, name: 'U', passwordHash: 'x' }).returning())[0]
  const grant = async (clientId: string, userId: string, refreshExpiresAt = new Date(Date.now() + 86_400_000)) => {
    const [g] = await db
      .insert(schema.oauthGrants)
      .values({ clientId, userId, accessHash: `a${tag()}${tag()}`, accessExpiresAt: refreshExpiresAt, refreshHash: `r${tag()}${tag()}`, refreshExpiresAt })
      .returning()
    return g
  }

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM oauth_clients`)
  })

  it('the reference list is every foreign key to oauth_clients in the database (a new one fails here)', async () => {
    const rows = (await db.execute(sql`
      SELECT c.conrelid::regclass::text AS t, a.attname AS col, c.confdeltype AS del
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'oauth_clients'::regclass
    `)) as unknown as { t: string; col: string; del: string }[]
    assert.deepEqual(rows.map((r) => r.t).sort(), [...OAUTH_CLIENT_REFERENCES].sort())
    assert.ok(rows.every((r) => r.col === 'client_id'))
  })

  it('R1 (ported): with OAUTH_UNUSED_CLIENT_HOURS, anonymous registrations nothing used are gone after that many hours; younger ones stay', async () => {
    const restore = setLimitsForTests({ oauthUnusedClientHours: 24 })
    try {
      const longUri = (i: number) => `https://e${i}.example.com/` + randomBytes(1500).toString('base64url').slice(0, 1970)
      for (let i = 0; i < 40; i++) {
        const r = await register({ redirect_uris: Array.from({ length: 10 }, (_, j) => longUri(j)) })
        assert.equal(r.statusCode, 201, r.body)
      }
      const fresh = await client(60) // registered an hour ago
      assert.equal((await ids()).size, 41)
      // a day and an hour later, through the registered housekeeping job (the hourly run)
      await db.execute(sql`UPDATE oauth_clients SET created_at = created_at - interval '25 hours' WHERE id <> ${fresh}`)
      await runRegisteredHousekeepingTasks()
      assert.deepEqual([...(await ids())], [fresh])
    } finally {
      restore()
    }
  })

  it('a client anything points at is never deleted: code, grant (an expired one too), agent block, agent access; nor ink_tc_ or metadata-document clients', async () => {
    const u = await user()
    const wid = randomUUID()
    await db.insert(schema.workspaces).values({ id: wid, name: 'W', ...(await generateInviteCodeColumns(db, wid)) })
    const old = 48 * 60
    const withCode = await client(old)
    await db.insert(schema.oauthCodes).values({ codeHash: `h${tag()}`, clientId: withCode, userId: u.id, redirectUri: 'https://app.example.com/cb', codeChallenge: 'x'.repeat(43), expiresAt: new Date(Date.now() + 5 * 60_000) })
    const withGrant = await client(old)
    await grant(withGrant, u.id)
    const withExpiredGrant = await client(old)
    await grant(withExpiredGrant, u.id, new Date(Date.now() - 60_000))
    const withBlock = await client(old)
    await db.insert(schema.workspaceAgentBlocks).values({ workspaceId: wid, userId: u.id, clientId: withBlock })
    const withAccess = await client(old)
    const g = await grant(await client(old), u.id)
    await db.insert(schema.workspaceAgentAccess).values({ workspaceId: wid, grantId: g.id, userId: u.id, clientId: withAccess })
    const tokenClient = await client(old, `ink_tc_${tag()}`)
    const cimd = await client(old, `https://client.example.com/${tag()}.json`)
    const unused = await client(old)
    const keep = [withCode, withGrant, withExpiredGrant, withBlock, withAccess, g.clientId, tokenClient, cimd]
    const restore = setLimitsForTests({ oauthUnusedClientHours: 1, oauthUnusedClientMax: 1 })
    try {
      assert.equal(await purgeUnusedOAuthClients(), 1)
      const left = await ids()
      for (const id of keep) assert.ok(left.has(id), id)
      assert.ok(!left.has(unused))
      // the cap pushes out never-used ones only: a full cap of used clients takes a new registration
      const r = await register()
      assert.equal(r.statusCode, 201, r.body)
      for (const id of keep) assert.ok((await ids()).has(id), id)
      // the grant expired: kept until the hourly OAuth purge removes it, then it is a never-used client
      await purgeExpiredOAuth(new Date())
      assert.equal(await purgeUnusedOAuthClients(), 1)
      assert.ok(!(await ids()).has(withExpiredGrant))
      assert.ok((await ids()).has(withCode)) // its code is still waiting to be exchanged
    } finally {
      restore()
    }
  })

  it('OAUTH_UNUSED_CLIENT_MAX: a new registration deletes the oldest never-used one, never one younger than the protection window', async () => {
    const restore = setLimitsForTests({ oauthUnusedClientMax: 3 })
    try {
      const a = await client(PROTECT_MINUTES + 30)
      const b = await client(PROTECT_MINUTES + 20)
      const c = await client(1) // someone is on the consent screen with this one
      const r1 = await register()
      assert.equal(r1.statusCode, 201, r1.body)
      const id1 = (r1.json() as { client_id: string }).client_id
      assert.deepEqual([...(await ids())].sort(), [b, c, id1].sort())
      const r2 = await register()
      assert.equal(r2.statusCode, 201)
      assert.ok(!(await ids()).has(b))
      assert.ok((await ids()).has(c))
      // only young never-used ones left: refused for now instead of pushing someone out
      const r3 = await register()
      assert.equal(r3.statusCode, 503, r3.body)
      assert.equal((r3.json() as { error: string }).error, 'temporarily_unavailable')
      assert.ok(Number(r3.headers['retry-after']) > 0)
      assert.equal(await countUnusedClients(), 3)
      assert.ok((await ids()).has(c))
      void a
    } finally {
      restore()
    }
  })

  it('OAUTH_UNUSED_CLIENT_MAX under concurrent registrations: never more never-used clients than the cap', async () => {
    const restore = setLimitsForTests({ oauthUnusedClientMax: 5 })
    try {
      for (let i = 0; i < 5; i++) await client(PROTECT_MINUTES + 60 + i)
      const rs = await Promise.all(Array.from({ length: 12 }, () => register()))
      const codes = rs.map((r) => r.statusCode)
      assert.equal(codes.filter((s) => s === 201).length, 5, JSON.stringify(codes))
      assert.ok(codes.every((s) => s === 201 || s === 503))
      assert.equal(await countUnusedClients(), 5)
    } finally {
      restore()
    }
  })

  it('without the settings nothing is deleted and registration has no cap (as in 0.21.1)', async () => {
    const old = [await client(24 * 60 * 400), await client(24 * 60 * 2)]
    assert.equal(await purgeUnusedOAuthClients(new Date(Date.now() + 365 * 86_400_000)), 0)
    await runRegisteredHousekeepingTasks()
    for (let i = 0; i < 5; i++) assert.equal((await register()).statusCode, 201)
    const left = await ids()
    for (const id of old) assert.ok(left.has(id))
    assert.equal(left.size, 7)
  })

  it('the code exchange (one transaction now): a refused exchange still spends the code; a good one leaves a grant, so the client is in use', async () => {
    const { createHash } = await import('node:crypto')
    const u = await user()
    const id = await client(48 * 60)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = async () => {
      const c = `ink_code_${tag()}${tag()}`
      const { sha256 } = await import('./oauth')
      await db.insert(schema.oauthCodes).values({ codeHash: sha256(c), clientId: id, userId: u.id, redirectUri: 'https://app.example.com/cb', codeChallenge: challenge, expiresAt: new Date(Date.now() + 5 * 60_000) })
      return c
    }
    const exchange = (c: string, v: string) =>
      app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code: c, code_verifier: v, redirect_uri: 'https://app.example.com/cb', client_id: id } })
    const first = await code()
    const bad = await exchange(first, 'wrong-verifier-' + 'x'.repeat(30))
    assert.equal(bad.statusCode, 400)
    assert.equal((bad.json() as { error: string }).error, 'invalid_grant')
    const again = await exchange(first, verifier)
    assert.equal(again.statusCode, 400)
    assert.match((again.json() as { error_description: string }).error_description, /invalid or expired/)
    const good = await exchange(await code(), verifier)
    assert.equal(good.statusCode, 200, good.body)
    assert.ok((good.json() as { access_token: string }).access_token)
    const restore = setLimitsForTests({ oauthUnusedClientHours: 1 })
    try {
      assert.equal(await purgeUnusedOAuthClients(), 0)
      assert.ok((await ids()).has(id))
    } finally {
      restore()
    }
  })

  it('registration size caps as before: at most 10 redirect URIs of at most 2000 characters, the name cut at 100', async () => {
    assert.equal((await register({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://e${i}.example.com/cb`) })).statusCode, 400)
    assert.equal((await register({ redirect_uris: [`https://e.example.com/${'a'.repeat(2000)}`] })).statusCode, 400)
    const r = await register({ client_name: 'n'.repeat(500) })
    assert.equal(r.statusCode, 201)
    assert.equal((r.json() as { client_name: string }).client_name.length, 100)
  })
})
