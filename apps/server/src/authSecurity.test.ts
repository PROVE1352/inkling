// Authentication hardening (docs/adr/1060-*, 1046-*, 1047-*): hashed session tokens (C-L7),
// the cross-site Origin check (C-L4) and two-step verification (TOTP, RFC 6238).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
process.env.PUBLIC_URL = 'https://notes.example.com/'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-authsec-${process.pid}`
// Wrong codes are deliberate here; keep the brute-force guard from banning the test client.
process.env.AUTH_GUARD_MAX_FAILURES ||= '1000'
process.env.AUTH_GUARD_ACCOUNT_FAILURES ||= '1000'

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

// ---------------------------------------------------------------------------
// TOTP / HOTP (pure)
// ---------------------------------------------------------------------------

describe('HOTP / TOTP test vectors', async () => {
  const t = await import('./totp')
  const ascii = (s: string) => Buffer.from(s, 'ascii')

  it('RFC 4226 Appendix D (HOTP, SHA-1, 6 digits)', () => {
    const secret = ascii('12345678901234567890')
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
    expected.forEach((code, counter) => assert.equal(t.hotp(secret, counter), code))
  })

  it('RFC 6238 Appendix B (TOTP, 8 digits, SHA-1 / SHA-256 / SHA-512)', () => {
    const seeds = {
      sha1: ascii('12345678901234567890'),
      sha256: ascii('12345678901234567890123456789012'),
      sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
    } as const
    const rows: [number, string, string, string][] = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ]
    for (const [time, s1, s256, s512] of rows) {
      assert.equal(t.totpAt(seeds.sha1, time, { digits: 8, algorithm: 'sha1' }), s1, `sha1 @${time}`)
      assert.equal(t.totpAt(seeds.sha256, time, { digits: 8, algorithm: 'sha256' }), s256, `sha256 @${time}`)
      assert.equal(t.totpAt(seeds.sha512, time, { digits: 8, algorithm: 'sha512' }), s512, `sha512 @${time}`)
    }
  })

  it('verifyTotp accepts ±1 step and returns the matched step', () => {
    const secret = randomBytes(20)
    const now = 1_700_000_000_000
    const step = t.totpStep(now / 1000)
    assert.equal(t.verifyTotp(secret, t.hotp(secret, step), { now }), step)
    assert.equal(t.verifyTotp(secret, t.hotp(secret, step - 1), { now }), step - 1)
    assert.equal(t.verifyTotp(secret, t.hotp(secret, step + 1), { now }), step + 1)
    assert.equal(t.verifyTotp(secret, t.hotp(secret, step + 2), { now }), null)
    assert.equal(t.verifyTotp(secret, t.hotp(secret, step - 2), { now }), null)
    assert.equal(t.verifyTotp(secret, 'abcdef', { now }), null)
    assert.equal(t.verifyTotp(secret, '12345', { now }), null)
  })

  it('base32 round-trips and matches RFC 4648 vectors', () => {
    assert.equal(t.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
    assert.equal(t.base32Decode('MZXW6YTBOI').toString(), 'foobar')
    assert.equal(t.base32Decode('mzxw 6ytb-oi======').toString(), 'foobar')
    const b = randomBytes(20)
    assert.deepEqual(t.base32Decode(t.base32Encode(b)), b)
    assert.throws(() => t.base32Decode('MZ1!'))
  })

  it('otpauth URI and recovery codes', () => {
    const uri = t.otpauthUri('JBSWY3DPEHPK3PXP', 'a@b.c')
    assert.equal(
      uri,
      'otpauth://totp/Inkling:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=Inkling&algorithm=SHA1&digits=6&period=30',
    )
    const codes = t.newRecoveryCodes()
    assert.equal(codes.length, 10)
    assert.equal(new Set(codes).size, 10)
    for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    assert.equal(t.normalizeRecoveryCode(' abcde-fghij '), 'ABCDEFGHIJ')
  })
})

describe('secretBox (AES-256-GCM under APP_SECRET_KEY)', async () => {
  const box = await import('./secretBox')
  const { env } = await import('./env')
  it('round-trips, binds to aad and fails on another key', () => {
    const plain = randomBytes(20)
    const sealed = box.sealSecret('totp-secret', plain, 'user-1')
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    assert.ok(!sealed.includes(plain.toString('base64url')))
    assert.deepEqual(box.openSecret('totp-secret', sealed, 'user-1'), plain)
    assert.throws(() => box.openSecret('totp-secret', sealed, 'user-2'))
    assert.throws(() => box.openSecret('other-purpose', sealed, 'user-1'))
    const saved = env.appSecretKey
    try {
      env.appSecretKey = 'another-app-secret-key-0123456789-abcdefgh'
      box._resetSecretBoxCache()
      assert.throws(() => box.openSecret('totp-secret', sealed, 'user-1'))
    } finally {
      env.appSecretKey = saved
      box._resetSecretBoxCache()
    }
  })
})

// ---------------------------------------------------------------------------
// Origin check (pure)
// ---------------------------------------------------------------------------

describe('checkRequestOrigin (C-L4)', async () => {
  const { checkRequestOrigin, upgradeOriginAllowed } = await import('./csrf')
  const allowed = ['https://notes.example.com']
  const ok = (h: Record<string, string>, a = allowed, host?: string) => checkRequestOrigin(h, a, host).ok

  it('configured origin: exact match only', () => {
    assert.equal(ok({ origin: 'https://notes.example.com' }), true)
    assert.equal(ok({ origin: 'https://evil.example' }), false)
    assert.equal(ok({ origin: 'http://notes.example.com' }), false) // scheme differs
    assert.equal(ok({ origin: 'https://a.notes.example.com' }), false) // sibling subdomain
    assert.equal(ok({ origin: 'null' }), false)
    assert.equal(ok({ origin: 'garbage' }), false)
  })
  it('falls back to Referer, then allows header-less (non-browser) clients', () => {
    assert.equal(ok({ referer: 'https://notes.example.com/w/1' }), true)
    assert.equal(ok({ referer: 'https://evil.example/x' }), false)
    assert.equal(ok({}), true)
    assert.equal(ok({ 'sec-fetch-site': 'cross-site' }), false)
    assert.equal(ok({ origin: 'https://notes.example.com', 'sec-fetch-site': 'same-origin' }), true)
  })
  it('unconfigured: same Host, or loopback to loopback (Vite dev proxy)', () => {
    assert.equal(ok({ origin: 'https://n.example' }, [], 'n.example'), true)
    assert.equal(ok({ origin: 'https://evil.example' }, [], 'n.example'), false)
    assert.equal(ok({ origin: 'http://localhost:5173' }, [], 'localhost:3001'), true)
    assert.equal(ok({ origin: 'http://localhost:5173' }, [], 'n.example'), false)
    assert.equal(ok({ origin: 'http://localhost:5173' }, ['http://localhost:3001']), true)
  })
  it('WebSocket upgrade uses the same rule', () => {
    assert.equal(upgradeOriginAllowed({ origin: 'https://notes.example.com', host: 'x' }).ok, true)
    assert.equal(upgradeOriginAllowed({ origin: 'https://evil.example', host: 'notes.example.com' }).ok, false)
    assert.equal(upgradeOriginAllowed({ host: 'notes.example.com' }).ok, true)
  })
})

// ---------------------------------------------------------------------------
// [db] sessions, Origin hook, two-step verification
// ---------------------------------------------------------------------------

describe('[db] auth security', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq, sql } = await import('drizzle-orm')
  const auth = await import('./auth')
  const { hashSessionToken, hashLegacySessionTokens } = await import('./sessionTokens')
  const { setPassword } = await import('./accounts')
  const { sha256, MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } = await import('./oauth')
  const totp = await import('./totp')
  const { env } = await import('./env')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
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
      ;(await import('./csrf')).registerOriginCheck(api)
      await (await import('./routes/auth')).registerAuthRoutes(api)
      await (await import('./routes/twoFactor')).registerTwoFactorRoutes(api)
      await (await import('./routes/admin')).registerAdminRoutes(api)
      api.post('/probe', { preHandler: auth.requireUser }, async (req) => ({ via: req.authVia }))
      api.get('/probe', { preHandler: auth.requireUser }, async (req) => ({ via: req.authVia }))
    },
    { prefix: '/api' },
  )
  await app.ready()

  after(async () => {
    await app.close()
    await closeDb()
  })

  const PASSWORD = 'correct horse battery'
  const tag = () => randomUUID().slice(0, 8)
  async function user(name = 'u', isAdmin = false) {
    const [u] = await db
      .insert(schema.users)
      .values({ email: `${name}-${tag()}@t.t`, name, passwordHash: await auth.hashPassword(PASSWORD), isAdmin })
      .returning()
    const { token } = await auth.createSession(u.id)
    return { ...u, token, cookie: `${auth.SESSION_COOKIE}=${token}` }
  }
  let ipSeq = 0
  const freshIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: freshIp() })
  const cookieOf = (r: { cookies: { name: string; value: string }[] }) =>
    r.cookies.find((c) => c.name === auth.SESSION_COOKIE)?.value
  const sessionRow = async (hash: string) =>
    (await db.select().from(schema.sessions).where(eq(schema.sessions.token, hash)))[0]

  // ------------------------------------------------------------------ sessions
  describe('session tokens are stored hashed (C-L7)', () => {
    it('createSession stores sha256(token), never the token', async () => {
      const u = await user('hash')
      assert.equal(await sessionRow(u.token), undefined)
      const row = await sessionRow(hashSessionToken(u.token))
      assert.equal(row?.userId, u.id)
      assert.match(row!.token, /^[0-9a-f]{64}$/)
      assert.equal((await auth.getSessionUser(u.token))?.id, u.id)
    })

    it('the stored hash itself is not a usable cookie', async () => {
      const u = await user('leak')
      assert.equal(await auth.getSessionUser(hashSessionToken(u.token)), null)
      const r = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie: `${auth.SESSION_COOKIE}=${hashSessionToken(u.token)}` } })
      assert.equal(r.statusCode, 401)
    })

    it('boot pass hashes plaintext rows in place, idempotently, and nobody is signed out', async () => {
      const u = await user('legacy')
      const raw = randomBytes(32).toString('base64url')
      await db.insert(schema.sessions).values({ token: raw, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) })
      const n = await hashLegacySessionTokens()
      assert.ok(n >= 1)
      assert.equal(await sessionRow(raw), undefined)
      assert.ok(await sessionRow(hashSessionToken(raw)))
      assert.equal(await hashLegacySessionTokens(), 0, 'second run changes nothing')
      assert.equal((await auth.getSessionUser(raw))?.id, u.id)
      const bad = await db.execute(sql`select count(*)::int as n from sessions where token !~ '^[0-9a-f]{64}$'`)
      assert.equal((bad as unknown as { n: number }[])[0].n, 0)
    })

    it('a plaintext row inserted after boot (old cli-token.sh) still works and is hashed on first use', async () => {
      const u = await user('cli')
      const raw = randomBytes(32).toString('base64url')
      await db.insert(schema.sessions).values({ token: raw, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) })
      assert.equal((await auth.getSessionUser(raw))?.id, u.id)
      assert.equal(await sessionRow(raw), undefined)
      assert.ok(await sessionRow(hashSessionToken(raw)))
    })

    it('logout deletes the hashed row; a password change keeps only the current session', async () => {
      const u = await user('logout')
      const other = await auth.createSession(u.id)
      const out = await post('/api/auth/logout', undefined, { cookie: `${auth.SESSION_COOKIE}=${other.token}` })
      assert.equal(out.statusCode, 204)
      assert.equal(await sessionRow(hashSessionToken(other.token)), undefined)

      const third = await auth.createSession(u.id)
      await setPassword(u.id, 'another password 1', { keepSessionToken: u.token })
      assert.ok(await sessionRow(hashSessionToken(u.token)), 'current session kept')
      assert.equal(await sessionRow(hashSessionToken(third.token)), undefined, 'others signed out')
    })

    it('password login sets a cookie whose hash is what the database holds', async () => {
      const u = await user('login')
      const r = await post('/api/auth/login', { email: u.email, password: PASSWORD })
      assert.equal(r.statusCode, 200)
      const raw = cookieOf(r)!
      assert.ok(raw)
      assert.ok(await sessionRow(hashSessionToken(raw)))
      assert.equal(await sessionRow(raw), undefined)
    })
  })

  // ------------------------------------------------------------------ Origin
  describe('cross-site requests are refused (C-L4)', () => {
    it('cookie POST: foreign Origin / Referer / null → 403, own origin and no header → allowed', async () => {
      const u = await user('csrf')
      const send = (headers: Record<string, string>) => post('/api/probe', {}, { cookie: u.cookie, ...headers })
      const evil = await send({ origin: 'https://evil.example' })
      assert.equal(evil.statusCode, 403)
      assert.equal(evil.json().error.code, 'CROSS_SITE_REQUEST')
      assert.equal((await send({ referer: 'https://evil.example/page' })).statusCode, 403)
      assert.equal((await send({ origin: 'null' })).statusCode, 403)
      assert.equal((await send({ origin: 'https://notes.example.com' })).statusCode, 200)
      assert.equal((await send({ referer: 'https://notes.example.com/w/x' })).statusCode, 200)
      assert.equal((await send({})).statusCode, 200, 'inklingctl / curl send no Origin')
    })

    it('GET is never refused; login from another site is', async () => {
      const u = await user('csrf-get')
      const g = await app.inject({ method: 'GET', url: '/api/probe', headers: { cookie: u.cookie, origin: 'https://evil.example' } })
      assert.equal(g.statusCode, 200)
      const l = await post('/api/auth/login', { email: u.email, password: PASSWORD }, { origin: 'https://evil.example' })
      assert.equal(l.statusCode, 403)
      assert.equal(cookieOf(l), undefined)
    })

    it('Bearer (MCP) requests are not subject to the Origin check', async () => {
      const u = await user('bearer')
      const clientId = `ink_c_${tag()}`
      await db.insert(schema.oauthClients).values({ id: clientId, name: 'Test agent', redirectUris: [] })
      const access = `ink_at_${randomBytes(16).toString('base64url')}`
      await db.insert(schema.oauthGrants).values({
        clientId,
        userId: u.id,
        scope: 'read write',
        accessHash: sha256(access),
        accessExpiresAt: new Date(Date.now() + 3_600_000),
        refreshHash: sha256(`r-${access}`),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      })
      const r = await post('/api/probe', {}, {
        authorization: `Bearer ${access}`,
        [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET,
        origin: 'https://evil.example',
      })
      assert.equal(r.statusCode, 200)
      assert.equal(r.json().via, 'bearer')
    })
  })

  // ------------------------------------------------------------------ TOTP
  describe('two-step verification (TOTP)', () => {
    const nowStep = () => totp.totpStep(Date.now() / 1000)

    /** Turn 2FA on for a fresh user; returns the secret and recovery codes. */
    async function enrolled(name: string) {
      const u = await user(name)
      const s = await post('/api/auth/2fa/setup', { password: PASSWORD }, { cookie: u.cookie })
      assert.equal(s.statusCode, 200, s.body)
      const { secret, uri } = s.json() as { secret: string; uri: string }
      assert.match(uri, /^otpauth:\/\/totp\/Inkling:/)
      const key = totp.base32Decode(secret)
      const enableStep = nowStep()
      const e = await post('/api/auth/2fa/enable', { code: totp.hotp(key, enableStep) }, { cookie: u.cookie })
      assert.equal(e.statusCode, 200, e.body)
      const { recoveryCodes } = e.json() as { recoveryCodes: string[] }
      return { u, key, secret, recoveryCodes, enableStep }
    }
    async function challengeFor(email: string) {
      const r = await post('/api/auth/login', { email, password: PASSWORD })
      assert.equal(r.statusCode, 200, r.body)
      const body = r.json() as { totpRequired?: boolean; challenge?: string }
      assert.equal(body.totpRequired, true)
      assert.equal(cookieOf(r), undefined, 'no session before the second step')
      return body.challenge!
    }

    it('setup needs the password, a correct code, and stores the secret encrypted', async () => {
      const u = await user('setup')
      const wrongPw = await post('/api/auth/2fa/setup', { password: 'nope' }, { cookie: u.cookie })
      assert.equal(wrongPw.statusCode, 400)
      assert.equal(wrongPw.json().error.code, 'INVALID_PASSWORD')

      const s = await post('/api/auth/2fa/setup', { password: PASSWORD }, { cookie: u.cookie })
      const { secret } = s.json() as { secret: string }
      const key = totp.base32Decode(secret)
      const [row] = await db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, u.id))
      assert.equal(row.enabledAt, null)
      assert.ok(!row.secretEnc.includes(secret) && !row.secretEnc.includes(key.toString('base64url')))

      // Not on yet: password login still signs in directly.
      const direct = await post('/api/auth/login', { email: u.email, password: PASSWORD })
      assert.ok(cookieOf(direct))

      const bad = await post('/api/auth/2fa/enable', { code: '000000' === totp.hotp(key, nowStep()) ? '111111' : '000000' }, { cookie: u.cookie })
      assert.equal(bad.statusCode, 400)
      assert.equal(bad.json().error.code, 'INVALID_TOTP_CODE')

      const ok = await post('/api/auth/2fa/enable', { code: totp.hotp(key, nowStep()) }, { cookie: u.cookie })
      assert.equal(ok.statusCode, 200)
      const codes = (ok.json() as { recoveryCodes: string[] }).recoveryCodes
      assert.equal(codes.length, 10)
      const stored = await db.select().from(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id))
      assert.equal(stored.length, 10)
      for (const c of codes) assert.ok(!stored.some((r) => r.codeHash.includes(c.replace('-', ''))))

      const state = await app.inject({ method: 'GET', url: '/api/auth/2fa', headers: { cookie: u.cookie } })
      assert.deepEqual(state.json(), { enabled: true, pending: false, recoveryCodesLeft: 10, available: true })
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })
      assert.equal(me.json().user.twoFactor, true)

      const again = await post('/api/auth/2fa/setup', { password: PASSWORD }, { cookie: u.cookie })
      assert.equal(again.statusCode, 409)
    })

    it('sign-in asks for a code; each code works once', async () => {
      const { u, key, enableStep } = await enrolled('login2fa')
      // The code used to confirm setup was recorded: it cannot sign in.
      let ch = await challengeFor(u.email)
      const reused = await post('/api/auth/login/totp', { challenge: ch, code: totp.hotp(key, enableStep) })
      assert.equal(reused.statusCode, 401)
      assert.equal(reused.json().error.code, 'TOTP_CODE_REUSED')

      const next = totp.hotp(key, nowStep() + 1)
      const ok = await post('/api/auth/login/totp', { challenge: ch, code: next })
      assert.equal(ok.statusCode, 200, ok.body)
      assert.equal(ok.json().user.id, u.id)
      const raw = cookieOf(ok)!
      assert.equal((await auth.getSessionUser(raw))?.id, u.id)

      // The challenge is gone after success, and the same code is refused on a new one.
      const replayChallenge = await post('/api/auth/login/totp', { challenge: ch, code: next })
      assert.equal(replayChallenge.json().error.code, 'TOTP_CHALLENGE_EXPIRED')
      ch = await challengeFor(u.email)
      const replay = await post('/api/auth/login/totp', { challenge: ch, code: next })
      assert.equal(replay.json().error.code, 'TOTP_CODE_REUSED')
      const older = await post('/api/auth/login/totp', { challenge: ch, code: totp.hotp(key, nowStep() - 1) })
      assert.equal(older.json().error.code, 'TOTP_CODE_REUSED', 'an older step than the last one used is refused too')
    })

    it('recovery codes sign in once each', async () => {
      const { u, recoveryCodes } = await enrolled('recovery')
      const ch = await challengeFor(u.email)
      const r = await post('/api/auth/login/totp', { challenge: ch, code: recoveryCodes[3].toLowerCase() })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().recoveryCodeUsed, true)
      const ch2 = await challengeFor(u.email)
      const again = await post('/api/auth/login/totp', { challenge: ch2, code: recoveryCodes[3] })
      assert.equal(again.statusCode, 401)
      assert.equal(again.json().error.code, 'INVALID_TOTP_CODE')
      const state = await app.inject({ method: 'GET', url: '/api/auth/2fa', headers: { cookie: u.cookie } })
      assert.equal(state.json().recoveryCodesLeft, 9)
    })

    it('five wrong codes void the challenge', async () => {
      const { u, key } = await enrolled('attempts')
      const ch = await challengeFor(u.email)
      const good = totp.hotp(key, nowStep() + 1)
      const wrong = good === '123456' ? '654321' : '123456'
      for (let i = 1; i <= 4; i++) {
        const r = await post('/api/auth/login/totp', { challenge: ch, code: wrong })
        assert.equal(r.json().error.code, 'INVALID_TOTP_CODE', `attempt ${i}`)
      }
      const fifth = await post('/api/auth/login/totp', { challenge: ch, code: wrong })
      assert.equal(fifth.json().error.code, 'TOTP_CHALLENGE_EXPIRED')
      const late = await post('/api/auth/login/totp', { challenge: ch, code: good })
      assert.equal(late.statusCode, 401)
      assert.equal(late.json().error.code, 'TOTP_CHALLENGE_EXPIRED', 'even the right code needs a new password step')
      const rows = await db.select().from(schema.totpLoginChallenges).where(eq(schema.totpLoginChallenges.tokenHash, sha256(ch)))
      assert.equal(rows.length, 0)
    })

    it('expired challenges and a password reset in between are refused', async () => {
      const { u, key } = await enrolled('expiry')
      const ch = await challengeFor(u.email)
      await db.update(schema.totpLoginChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.totpLoginChallenges.tokenHash, sha256(ch)))
      const r = await post('/api/auth/login/totp', { challenge: ch, code: totp.hotp(key, nowStep() + 1) })
      assert.equal(r.json().error.code, 'TOTP_CHALLENGE_EXPIRED')

      const ch2 = await challengeFor(u.email)
      await setPassword(u.id, 'reset by admin 123')
      const r2 = await post('/api/auth/login/totp', { challenge: ch2, code: totp.hotp(key, nowStep() + 1) })
      assert.equal(r2.statusCode, 401)
      assert.equal(cookieOf(r2), undefined)
    })

    it('turning off needs password + code; afterwards the password alone signs in', async () => {
      const { u, key, recoveryCodes } = await enrolled('disable')
      const noCode = await post('/api/auth/2fa/disable', { password: PASSWORD, code: '000001' }, { cookie: u.cookie })
      assert.equal(noCode.statusCode, 400)
      const noPw = await post('/api/auth/2fa/disable', { password: 'x', code: totp.hotp(key, nowStep() + 1) }, { cookie: u.cookie })
      assert.equal(noPw.statusCode, 400)
      assert.equal(noPw.json().error.code, 'INVALID_PASSWORD')

      const regen = await post('/api/auth/2fa/recovery-codes', { password: PASSWORD, code: recoveryCodes[0] }, { cookie: u.cookie })
      assert.equal(regen.statusCode, 200)
      const fresh = (regen.json() as { recoveryCodes: string[] }).recoveryCodes
      assert.equal(fresh.length, 10)

      const off = await post('/api/auth/2fa/disable', { password: PASSWORD, code: fresh[0] }, { cookie: u.cookie })
      assert.equal(off.statusCode, 200, off.body)
      assert.equal((await db.select().from(schema.userTotp).where(eq(schema.userTotp.userId, u.id))).length, 0)
      assert.equal((await db.select().from(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, u.id))).length, 0)
      const direct = await post('/api/auth/login', { email: u.email, password: PASSWORD })
      assert.ok(cookieOf(direct))
    })

    it('an admin can turn a member\'s 2FA off (lost phone); their sessions end', async () => {
      const admin = await user('admin', true)
      const { u } = await enrolled('lostphone')
      const r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${u.id}/2fa`, headers: { cookie: admin.cookie } })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().wasOn, true)
      assert.equal(await auth.getSessionUser(u.token), null)
      const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin.cookie } })
      assert.equal(list.json().users.find((x: { id: string }) => x.id === u.id).twoFactor, false)
      const direct = await post('/api/auth/login', { email: u.email, password: PASSWORD })
      assert.ok(cookieOf(direct))
    })

    it('without APP_SECRET_KEY setup answers 501', async () => {
      const u = await user('nokey')
      const saved = env.appSecretKey
      env.appSecretKey = null
      try {
        const r = await post('/api/auth/2fa/setup', { password: PASSWORD }, { cookie: u.cookie })
        assert.equal(r.statusCode, 501)
        assert.equal(r.json().error.code, 'TWO_FACTOR_UNAVAILABLE')
      } finally {
        env.appSecretKey = saved
      }
    })
  })
})
