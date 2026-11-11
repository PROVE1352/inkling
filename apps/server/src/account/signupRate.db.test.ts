// Sign-up limits after the security review (0.22 security fixes F6 and F10, contract §14,
// docs/adr/2537-*):
//   - SIGNUP_PER_IP_PER_DAY counts an IPv6 /56 (was a /64: the next /64 of one /48 was a fresh address)
//   - SIGNUP_PER_HOUR caps the accounts the whole server makes in an hour (429 SIGNUP_RATE_LIMIT)
//   - an answer "this ID is taken" counts too: after 10 of them in 24 hours from one address, that
//     address gets 429 SIGNUP_IP_LIMIT instead (no unbounded probing of IDs)
// Ported from the review's R4, R5 and R6 (w22-reports/sec/sec.db.test.ts). Without the settings
// nothing of this happens (last test).
//
// This file makes its own scratch database (restricted sign-up needs exactly one admin).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.SIGNUP_REQUIRE_KEY = '0'
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'inkling-signuprate-'))
for (const k of ['DELEGATED_AUTH_URL', 'SMTP_HOST', 'MAIL_FROM', 'REQUIRE_EMAIL_VERIFICATION', 'OIDC_ISSUER']) delete process.env[k]

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

const BASE_URL = process.env.DATABASE_URL

describe('[db] sign-up limits: /56, per hour, taken IDs', { skip: !BASE_URL }, async () => {
  if (!BASE_URL) return
  const postgres = (await import('postgres')).default
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  const dbName = `inkling_signuprate_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  const scratch = new URL(BASE_URL)
  scratch.pathname = `/${dbName}`
  process.env.DATABASE_URL = scratch.toString()

  const { db, closeDb, runMigrations } = await import('../db/index')
  await runMigrations()
  const schema = await import('../db/schema')
  const { sql } = await import('drizzle-orm')
  const { AppError } = await import('../errors')
  const { ZodError } = await import('zod')
  const { hashPassword } = await import('../auth')
  const { setLimitsForTests } = await import('../limits')
  // (?? 10: the same file ran against the code before the fix, to see it fail)
  const TAKEN_PER_IP_PER_DAY: number = (await import('./signupGuards')).TAKEN_PER_IP_PER_DAY ?? 10

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

  before(async () => {
    await db.insert(schema.users).values({ email: `root-${randomBytes(4).toString('hex')}@t.t`, name: 'Root', passwordHash: await hashPassword('password123'), isAdmin: true })
  })

  const tag = () => randomBytes(4).toString('hex')
  const codeOf = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
  const regEmail = (ip: string, formMs = 2500) =>
    app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { email: `s-${tag()}@example.com`, name: 'X', password: 'password123', formMs } })
  const regId = (ip: string, loginId: string) =>
    app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: ip, payload: { loginId, name: 'P', password: 'password123', formMs: 2500 } })
  const events = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM signup_events`)) as unknown as { n: number }[])[0].n)
  const lastHour = async () =>
    Number(((await db.execute(sql`SELECT count(*)::int AS n FROM signup_events WHERE created_at > now() - interval '1 hour' AND ip NOT LIKE 'taken:%'`)) as unknown as { n: number }[])[0].n)
  // a fresh /56 per call (the third group changes)
  let net = 0x100
  const fresh56 = () => `2001:db8:${(net++).toString(16)}:1::1`

  it('R4 (ported): SIGNUP_PER_IP_PER_DAY counts an IPv6 /56: the next /64 of the same /56 is refused, another /56 is not', async () => {
    const restore = setLimitsForTests({ signupPerIpPerDay: 2, signupMaxUsers: 100_000 })
    try {
      const same = [await regEmail('2001:db8:1:1::1'), await regEmail('2001:db8:1:1::2'), await regEmail('2001:db8:1:1::3')]
      assert.deepEqual(same.map((r) => r.statusCode), [200, 200, 429])
      const next64 = await regEmail('2001:db8:1:2::1')
      assert.equal(next64.statusCode, 429, next64.body)
      assert.equal(codeOf(next64), 'SIGNUP_IP_LIMIT')
      const lastOf56 = await regEmail('2001:db8:1:ff::1')
      assert.equal(lastOf56.statusCode, 429)
      const other56 = await regEmail('2001:db8:1:100::1')
      assert.equal(other56.statusCode, 200, other56.body)
    } finally {
      restore()
    }
  })

  it('IPv4-mapped IPv6 and IPv4 are one address for the per-IP count', async () => {
    const restore = setLimitsForTests({ signupPerIpPerDay: 2, signupMaxUsers: 100_000 })
    try {
      assert.equal((await regEmail('198.51.100.40')).statusCode, 200)
      assert.equal((await regEmail('::ffff:198.51.100.40')).statusCode, 200)
      const third = await regEmail('198.51.100.40')
      assert.equal(third.statusCode, 429)
      assert.equal((await regEmail('::ffff:198.51.100.40')).statusCode, 429)
    } finally {
      restore()
    }
  })

  it('R5 (ported): taken-ID answers are limited per address; a person fixing a taken ID a few times still signs up', async () => {
    const restore = setLimitsForTests({ loginIdMode: 'username', disabledFeatures: ['password-reset'], signupPerIpPerDay: 2, signupMaxUsers: 100_000 })
    try {
      const id = `victim${tag()}`
      assert.equal((await regId('198.51.100.10', id)).statusCode, 200)
      // a person who tries three taken IDs and then a free one: not refused, their two a day intact
      const person = '198.51.100.11'
      for (let i = 0; i < 3; i++) assert.equal(codeOf(await regId(person, id)), 'LOGIN_ID_TAKEN')
      assert.equal((await regId(person, `mine${tag()}`)).statusCode, 200)
      assert.equal((await regId(person, `mine${tag()}`)).statusCode, 200)
      // a prober: TAKEN_PER_IP_PER_DAY answers, then the address gets the per-IP refusal for every ID
      const prober = '198.51.100.77'
      const probes = []
      for (let i = 0; i < TAKEN_PER_IP_PER_DAY + 2; i++) probes.push(await regId(prober, id))
      assert.deepEqual(
        probes.map((p) => `${p.statusCode}/${codeOf(p)}`),
        [...Array(TAKEN_PER_IP_PER_DAY).fill('409/LOGIN_ID_TAKEN'), '429/SIGNUP_IP_LIMIT', '429/SIGNUP_IP_LIMIT'],
      )
      const freeId = await regId(prober, `free${tag()}`)
      assert.equal(freeId.statusCode, 429, freeId.body)
      assert.equal(codeOf(freeId), 'SIGNUP_IP_LIMIT')
      // the IPv6 neighbours of a prober (same /56) share its count
      const v6 = fresh56()
      for (let i = 0; i < TAKEN_PER_IP_PER_DAY; i++) await regId(v6.replace(/::1$/, `::${i + 1}`), id)
      assert.equal(codeOf(await regId(v6.replace(':1::1', ':2::1'), id)), 'SIGNUP_IP_LIMIT')
    } finally {
      restore()
    }
  })

  it('SIGNUP_PER_HOUR: the whole server makes at most N accounts an hour (429 SIGNUP_RATE_LIMIT), counted under a lock', async () => {
    // works alone (no per-IP limit): its rows are recorded all the same
    const n0 = await lastHour()
    const restore = setLimitsForTests({ signupPerHour: n0 + 2, signupMaxUsers: 100_000 })
    try {
      const rs = await Promise.all(Array.from({ length: 6 }, () => regEmail(fresh56())))
      const codes = rs.map((r) => (r.statusCode === 200 ? 200 : `${r.statusCode}/${codeOf(r)}`))
      assert.equal(codes.filter((c) => c === 200).length, 2, JSON.stringify(codes))
      assert.ok(codes.every((c) => c === 200 || c === '429/SIGNUP_RATE_LIMIT'), JSON.stringify(codes))
      assert.equal(await lastHour(), n0 + 2)
      // rows older than an hour do not count
      await db.execute(sql`UPDATE signup_events SET created_at = now() - interval '61 minutes' WHERE created_at > now() - interval '1 hour'`)
      assert.equal((await regEmail(fresh56())).statusCode, 200)
    } finally {
      restore()
    }
  })

  it('SIGNUP_PER_HOUR: the setup code\'s sign-up is not counted or refused', async () => {
    const { beforeSignup, onSignup } = await import('./signupGuards')
    const restore = setLimitsForTests({ signupPerHour: 1 })
    try {
      await db.execute(sql`INSERT INTO signup_events (ip) VALUES ('203.0.113.1'), ('203.0.113.2')`)
      const ctx = { rawBody: {}, body: {}, ip: '203.0.113.3', locale: 'en', setupCode: true, req: { log: { warn: () => {} } } } as never
      await beforeSignup(ctx)
      const before = await events()
      await db.transaction(async (tx) => {
        await onSignup(tx, { id: crypto.randomUUID(), isAdmin: true } as never, ctx)
      })
      assert.equal(await events(), before)
      // the same request without the setup code is refused
      await assert.rejects(beforeSignup({ ...(ctx as object), setupCode: false, rawBody: { formMs: 2500 } } as never), (e: unknown) => (e as { code?: string }).code === 'SIGNUP_RATE_LIMIT')
    } finally {
      restore()
      await db.execute(sql`UPDATE signup_events SET created_at = now() - interval '2 hours' WHERE ip IN ('203.0.113.1', '203.0.113.2')`)
    }
  })

  it('R6 (ported): the bot check is a number the client sends, so scripted sign-ups pass it; SIGNUP_PER_HOUR caps how many', async () => {
    const n0 = await lastHour()
    const restore = setLimitsForTests({ signupPerHour: n0 + 3, signupMaxUsers: 100_000 })
    try {
      const rs = []
      for (let i = 0; i < 5; i++) rs.push(await regEmail(fresh56(), 2000))
      assert.deepEqual(rs.map((r) => r.statusCode), [200, 200, 200, 429, 429])
    } finally {
      restore()
    }
  })

  it('without the settings: no rows, no refusals, a taken ID answers 409 every time (as in 0.21.1 and 0.22 before the fix)', async () => {
    const before = await events()
    for (let i = 0; i < 3; i++) assert.equal((await regEmail('2001:db8:77:1::1')).statusCode, 200)
    const restore = setLimitsForTests({ loginIdMode: 'username', disabledFeatures: ['password-reset'] })
    try {
      const id = `taken${tag()}`
      assert.equal((await regId('198.51.100.90', id)).statusCode, 200)
      for (let i = 0; i < TAKEN_PER_IP_PER_DAY + 3; i++) assert.equal(codeOf(await regId('198.51.100.91', id)), 'LOGIN_ID_TAKEN')
    } finally {
      restore()
    }
    assert.equal(await events(), before)
  })
})
