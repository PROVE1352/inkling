// OpenID Connect sign-in (docs/adr/1160-*, 1161-*, 1162-*) against a fake provider started in this
// process (node:http: discovery, JWKS, token endpoint; id_tokens signed here with node:crypto).
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { after, before, describe, it } from 'node:test'

const HAS_DB = !!process.env.DATABASE_URL

// ---------------------------------------------------------------------------
// Fake provider. Started before env.ts is imported: the issuer URL carries the port.
// ---------------------------------------------------------------------------

const CLIENT_ID = 'inkling-test'
const CLIENT_SECRET = `cs-${randomBytes(12).toString('hex')}`

const mkRsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const good = mkRsa()
const attacker = mkRsa()
const rotated = mkRsa()

interface IdpCode {
  challenge: string
  redirectUri: string
  idToken: string
}
const idp = {
  codes: new Map<string, IdpCode>(),
  keys: [{ ...(good.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', use: 'sig', alg: 'RS256' }] as object[],
  jwksHits: 0,
  tokenCalls: 0,
  issued: [] as string[],
  lastTokenRequest: '' as string,
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const url = new URL(req.url ?? '/', ISSUER)
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      id_token_signing_alg_values_supported: ['RS256'],
    })
  }
  if (url.pathname === '/jwks') {
    idp.jwksHits++
    return json(200, { keys: idp.keys })
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      idp.tokenCalls++
      idp.lastTokenRequest = raw
      const form = new URLSearchParams(raw)
      const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
      if (req.headers.authorization !== `Basic ${basic}`) return json(401, { error: 'invalid_client' })
      const code = form.get('code') ?? ''
      const entry = idp.codes.get(code)
      idp.codes.delete(code)
      if (!entry) return json(400, { error: 'invalid_grant' })
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' })
      if (form.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant' })
      return json(200, { access_token: 'at-unused', token_type: 'Bearer', id_token: entry.idToken })
    })
    return
  }
  json(404, { error: 'not_found' })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const ISSUER = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

process.env.PUBLIC_URL = 'https://notes.example.com'
process.env.APP_SECRET_KEY ||= 'test-app-secret-key-0123456789-abcdefghij'
process.env.DATA_DIR ||= `${process.env.TMPDIR || '/tmp'}/inkling-oidc-${process.pid}`
process.env.AUTH_GUARD_MAX_FAILURES ||= '1000'
process.env.AUTH_GUARD_ACCOUNT_FAILURES ||= '1000'
process.env.OIDC_ISSUER = ISSUER
process.env.OIDC_CLIENT_ID = CLIENT_ID
process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET
process.env.OIDC_NAME = 'Acme SSO'
process.env.OIDC_AUTO_CREATE = '1'

after(() => server.close())

function signJwt(payload: Record<string, unknown>, opts: { key?: KeyObject; header?: Record<string, unknown> } = {}): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'k1', ...opts.header }
  const h = Buffer.from(JSON.stringify(header)).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), opts.key ?? good.privateKey).toString('base64url')
  return `${h}.${p}.${sig}`
}

const now = () => Math.floor(Date.now() / 1000)
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const sub = randomUUID()
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub,
    email: `p-${sub.slice(0, 8)}@acme.test`,
    email_verified: true,
    name: 'Pat',
    iat: now(),
    exp: now() + 300,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('oidc helpers', async () => {
  const o = await import('./oidc')
  const { env } = await import('./env')

  it('returnTo keeps same-origin paths only (open redirect)', () => {
    assert.equal(o.safeReturnTo('/w/1/p/2?x=1#h'), '/w/1/p/2?x=1#h')
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', 'evil', '', null, 5, '/api/auth/logout']) {
      assert.equal(o.safeReturnTo(bad), '/', String(bad))
    }
  })

  it('second factor from amr / acr', () => {
    const c = (x: Record<string, unknown>) => x as never
    assert.equal(o.showsSecondFactor(c({ amr: ['pwd'] })), false)
    assert.equal(o.showsSecondFactor(c({ amr: ['pwd', 'mfa'] })), true)
    assert.equal(o.showsSecondFactor(c({ amr: ['hwk'] })), true)
    assert.equal(o.showsSecondFactor(c({})), false)
    const saved = env.oidc.acrValues
    env.oidc.acrValues = ['urn:acme:mfa']
    assert.equal(o.showsSecondFactor(c({ acr: 'urn:acme:mfa' })), true)
    assert.equal(o.showsSecondFactor(c({ acr: '1' })), false)
    env.oidc.acrValues = saved
  })

  it('boot check: a half-filled configuration refuses to start', () => {
    assert.throws(() => o.assertOidcConfig({ ...env.oidc, clientSecret: null }), /all of OIDC_ISSUER/)
    assert.throws(() => o.assertOidcConfig({ ...env.oidc, alg: 'HS256' as never }), /OIDC_ID_TOKEN_ALG/)
    assert.throws(() => o.assertOidcConfig({ ...env.oidc, issuer: 'http://idp.example.com' }), /https/)
    assert.deepEqual(o.assertOidcConfig({ ...env.oidc, issuer: null, clientId: null, clientSecret: null }), [])
    assert.equal(o.assertOidcConfig({ ...env.oidc, allowedDomains: [], autoCreate: true }).length, 1)
  })
})

// ---------------------------------------------------------------------------
// id_token verification against the fake provider
// ---------------------------------------------------------------------------

describe('id_token verification', async () => {
  const o = await import('./oidc')
  const nonce = 'n-123'
  const reason = async (token: string) => {
    try {
      await o.verifyIdToken(token, { nonce })
      return 'ok'
    } catch (err) {
      assert.ok(err instanceof o.OidcError)
      assert.equal(err.code, 'OIDC_TOKEN_INVALID')
      return err.detail
    }
  }

  it('accepts a token signed by the provider key', async () => {
    const c = await o.verifyIdToken(signJwt(claims({ nonce })), { nonce })
    assert.equal(c.iss, ISSUER)
  })
  it('nonce mismatch', async () => assert.equal(await reason(signJwt(claims({ nonce: 'other' }))), 'nonce mismatch'))
  it('forged signature (other key, same kid)', async () =>
    assert.equal(await reason(signJwt(claims({ nonce }), { key: attacker.privateKey })), 'bad signature'))
  it('tampered payload', async () => {
    const [h, , s] = signJwt(claims({ nonce })).split('.')
    const p = Buffer.from(JSON.stringify(claims({ nonce, sub: 'admin' }))).toString('base64url')
    assert.equal(await reason(`${h}.${p}.${s}`), 'bad signature')
  })
  it('alg none and HS256 are refused before any key lookup', async () => {
    const p = Buffer.from(JSON.stringify(claims({ nonce }))).toString('base64url')
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`
    assert.equal(await reason(none), 'alg none not accepted')
    assert.equal(await reason(signJwt(claims({ nonce }), { header: { alg: 'HS256' } })), 'alg HS256 not accepted')
  })
  it('aud mismatch', async () => assert.equal(await reason(signJwt(claims({ nonce, aud: 'someone-else' }))), 'aud mismatch'))
  it('azp must be the client when aud has several values', async () =>
    assert.equal(await reason(signJwt(claims({ nonce, aud: [CLIENT_ID, 'x'], azp: 'x' }))), 'azp mismatch'))
  it('iss mismatch', async () => assert.equal(await reason(signJwt(claims({ nonce, iss: 'https://evil' }))), 'iss mismatch'))
  it('expired (beyond 60 s of skew)', async () =>
    assert.equal(await reason(signJwt(claims({ nonce, exp: now() - 120, iat: now() - 600 }))), 'expired'))
  it('iat in the future', async () => assert.equal(await reason(signJwt(claims({ nonce, iat: now() + 600 }))), 'iat in the future'))
  it('key rotation: an unknown kid refetches the JWKS (at most once a minute)', async () => {
    o._resetOidcCaches()
    await o.verifyIdToken(signJwt(claims({ nonce })), { nonce }) // caches k1
    idp.keys.push({ ...(rotated.publicKey.export({ format: 'jwk' }) as object), kid: 'k2', use: 'sig' })
    const token = signJwt(claims({ nonce }), { key: rotated.privateKey, header: { kid: 'k2' } })
    // Within the minute: no refetch, so the new kid is unknown.
    assert.equal(await reason(token), 'no matching signing key')
    o._resetOidcCaches()
    assert.equal(await reason(token), 'ok')
    idp.keys.pop()
    o._resetOidcCaches()
  })
})

// ---------------------------------------------------------------------------
// Full flow through the routes
// ---------------------------------------------------------------------------

describe('[db] OpenID Connect sign-in', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const { db, closeDb } = await import('./db/index')
  const schema = await import('./db/schema')
  const { eq } = await import('drizzle-orm')
  const auth = await import('./auth')
  const { env } = await import('./env')
  const { AppError } = await import('./errors')
  const { ZodError } = await import('zod')
  const { OIDC_COOKIE } = await import('./routes/oidc')
  const { userSatisfiesTwoFactor } = await import('./twoFactorPolicy')
  const totp = await import('./totp')
  const Fastify = (await import('fastify')).default

  let logs = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString()
      cb()
    },
  })
  // Same request serializer as index.ts (C-L8): query secrets such as code= and state= are masked.
  const { maskUrlSecrets } = await import('./util')
  const app = Fastify({
    logger: {
      level: 'info',
      stream,
      serializers: { req: (req) => ({ method: req.method, url: maskUrlSecrets(req.url) }) },
    },
  })
  await app.register(import('@fastify/cookie'))
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION' } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      ;(await import('./csrf')).registerOriginCheck(api)
      await (await import('./routes/auth')).registerAuthRoutes(api)
      await (await import('./routes/twoFactor')).registerTwoFactorRoutes(api)
      await (await import('./routes/oidc')).registerOidcRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const defaults = { ...env.oidc }
  before(() => Object.assign(env.oidc, defaults))
  const withOidc = async <T>(over: Partial<typeof env.oidc>, fn: () => Promise<T>): Promise<T> => {
    const prev = { ...env.oidc }
    Object.assign(env.oidc, over)
    try {
      return await fn()
    } finally {
      Object.assign(env.oidc, prev)
    }
  }

  let ipSeq = 0
  const freshIp = () => `10.88.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
  const cookieOf = (r: { cookies: { name: string; value: string }[] }, name: string) =>
    r.cookies.find((c) => c.name === name)?.value

  interface FlowOpts {
    claims?: Record<string, unknown>
    nonce?: string
    key?: KeyObject
    returnTo?: string
    /** Present a different browser cookie at the callback. */
    otherBrowser?: boolean
    /** Signed-in session cookie for the callback (link mode) */
    session?: string
    /** Start through POST /auth/oidc/link with this session cookie */
    linkSession?: string
  }

  async function flow(o: FlowOpts = {}) {
    let authorizeUrl: URL
    let browser: string | undefined
    if (o.linkSession) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/link',
        payload: { returnTo: o.returnTo ?? '/settings#account' },
        headers: { cookie: `${auth.SESSION_COOKIE}=${o.linkSession}`, origin: 'https://notes.example.com' },
        remoteAddress: freshIp(),
      })
      assert.equal(r.statusCode, 200, r.body)
      authorizeUrl = new URL(r.json().url)
      browser = cookieOf(r, OIDC_COOKIE)
    } else {
      const r = await app.inject({
        method: 'GET',
        url: `/api/auth/oidc/start?returnTo=${encodeURIComponent(o.returnTo ?? '/w/x')}`,
        remoteAddress: freshIp(),
      })
      assert.equal(r.statusCode, 302, r.body)
      authorizeUrl = new URL(r.headers.location as string)
      browser = cookieOf(r, OIDC_COOKIE)
    }
    assert.ok(browser)
    const p = authorizeUrl.searchParams
    assert.equal(p.get('code_challenge_method'), 'S256')
    assert.equal(p.get('redirect_uri'), 'https://notes.example.com/api/auth/oidc/callback')
    assert.equal(p.get('client_id'), CLIENT_ID)
    const state = p.get('state')!
    const code = randomBytes(16).toString('base64url')
    idp.issued.push(code)
    idp.codes.set(code, {
      challenge: p.get('code_challenge')!,
      redirectUri: p.get('redirect_uri')!,
      idToken: signJwt(claims({ nonce: o.nonce ?? p.get('nonce'), ...o.claims }), { key: o.key }),
    })
    const cookies = [`${OIDC_COOKIE}=${o.otherBrowser ? 'someone-else' : browser}`]
    if (o.session) cookies.push(`${auth.SESSION_COOKIE}=${o.session}`)
    const r = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${code}&state=${state}`,
      headers: { cookie: cookies.join('; ') },
      remoteAddress: freshIp(),
    })
    const location = String(r.headers.location ?? '')
    return { r, location, session: cookieOf(r, auth.SESSION_COOKIE), state, code, browser: browser! }
  }
  const errorOf = (location: string) => new URL(location, 'https://x').searchParams.get('oidc_error')

  async function localUser(email: string, isAdmin = false) {
    const [u] = await db
      .insert(schema.users)
      .values({ email, name: 'Local', passwordHash: await auth.hashPassword('pw-local-123'), isAdmin })
      .returning()
    return u
  }
  const identityOf = async (sub: string) =>
    (await db.select().from(schema.userIdentities).where(eq(schema.userIdentities.subject, sub)))[0]

  it('success: first sign-in creates an account, the second finds it by (iss, sub)', async () => {
    const c = claims()
    const a = await flow({ claims: c, returnTo: '/w/abc?x=1' })
    assert.equal(a.r.statusCode, 302)
    assert.equal(a.location, '/w/abc?x=1')
    assert.ok(a.session)
    const me = await auth.getSessionUser(a.session!)
    assert.equal(me?.email, c.email)
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me!.id))
    assert.equal(u.origin, 'oidc')
    assert.ok(u.emailVerifiedAt)
    const ws = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u.id))
    assert.equal(ws.length, 1)
    assert.equal((await identityOf(c.sub as string))?.userId, u.id)
    // The state cookie is cleared, the state row is gone (single use).
    assert.equal(a.r.cookies.find((x) => x.name === OIDC_COOKIE)?.value, '')
    // Same subject with a changed email: same account, users.email unchanged.
    const b = await flow({ claims: { ...c, email: 'changed@acme.test', iat: now(), exp: now() + 300 } })
    assert.equal((await auth.getSessionUser(b.session!))?.id, u.id)
    const [u2] = await db.select().from(schema.users).where(eq(schema.users.id, u.id))
    assert.equal(u2.email, c.email)
    assert.equal((await identityOf(c.sub as string))?.email, 'changed@acme.test')
    // The token endpoint got PKCE, never the secret in the body.
    assert.ok(!idp.lastTokenRequest.includes(CLIENT_SECRET))
  })

  it('/auth/mode shows the button name only; /auth/me lists the linked login', async () => {
    const mode = await app.inject({ method: 'GET', url: '/api/auth/mode' })
    assert.deepEqual(mode.json().oidc, { name: 'Acme SSO' })
    assert.ok(!mode.body.includes(CLIENT_SECRET) && !mode.body.includes(ISSUER))
    const a = await flow()
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `${auth.SESSION_COOKIE}=${a.session}` } })
    const user = me.json().user
    assert.equal(user.origin, 'oidc')
    assert.equal(user.logins.length, 1)
    assert.equal(user.logins[0].name, 'Acme SSO')
    assert.ok(!me.body.includes(CLIENT_SECRET))
  })

  it('nonce mismatch: refused, no session', async () => {
    const a = await flow({ nonce: 'not-the-stored-one' })
    assert.equal(errorOf(a.location), 'OIDC_TOKEN_INVALID')
    assert.equal(a.session, undefined)
  })

  it('forged signature: refused, no session', async () => {
    const a = await flow({ key: attacker.privateKey })
    assert.equal(errorOf(a.location), 'OIDC_TOKEN_INVALID')
    assert.equal(a.session, undefined)
  })

  it('aud mismatch: refused', async () => {
    const a = await flow({ claims: { aud: 'other-client' } })
    assert.equal(errorOf(a.location), 'OIDC_TOKEN_INVALID')
    assert.equal(a.session, undefined)
  })

  it('expired id_token: refused', async () => {
    const a = await flow({ claims: { exp: now() - 3600, iat: now() - 7200 } })
    assert.equal(errorOf(a.location), 'OIDC_TOKEN_INVALID')
    assert.equal(a.session, undefined)
  })

  it('state from another browser (login CSRF) or replayed: refused, code never exchanged', async () => {
    const calls = idp.tokenCalls
    const a = await flow({ otherBrowser: true })
    assert.equal(errorOf(a.location), 'OIDC_STATE_INVALID')
    assert.equal(a.session, undefined)
    assert.equal(idp.tokenCalls, calls)
    // The state was consumed by that attempt: the right browser cannot reuse it either.
    const again = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${a.code}&state=${a.state}`,
      headers: { cookie: `${OIDC_COOKIE}=${a.browser}` },
      remoteAddress: freshIp(),
    })
    assert.equal(errorOf(String(again.headers.location)), 'OIDC_STATE_INVALID')
    const none = await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=x', remoteAddress: freshIp() })
    assert.equal(errorOf(String(none.headers.location)), 'OIDC_STATE_INVALID')
  })

  it('provider error (cancel) maps to a fixed code, nothing from the provider is echoed', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/oidc/start', remoteAddress: freshIp() })
    const state = new URL(r.headers.location as string).searchParams.get('state')!
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?state=${state}&error=access_denied&error_description=%3Cscript%3E`,
      headers: { cookie: `${OIDC_COOKIE}=${cookieOf(r, OIDC_COOKIE)}` },
      remoteAddress: freshIp(),
    })
    assert.equal(cb.headers.location, '/login?oidc_error=OIDC_CANCELLED')
  })

  it('open redirect: returnTo outside the site falls back to /', async () => {
    const a = await flow({ returnTo: '//evil.example/x' })
    assert.equal(a.location, '/')
    const b = await flow({ returnTo: 'https://evil.example/' })
    assert.equal(b.location, '/')
  })

  it('domain not allowed: refused; allowed domain with unverified email: refused', async () => {
    await withOidc({ allowedDomains: ['acme.test'] }, async () => {
      const a = await flow({ claims: { email: 'x@other.test' } })
      assert.equal(errorOf(a.location), 'OIDC_DOMAIN_NOT_ALLOWED')
      assert.equal(a.session, undefined)
      const b = await flow({ claims: { email_verified: false } })
      assert.equal(errorOf(b.location), 'OIDC_EMAIL_UNVERIFIED')
      const ok = await flow()
      assert.ok(ok.session)
    })
  })

  it('unknown identity without OIDC_AUTO_CREATE: refused', async () => {
    await withOidc({ autoCreate: false }, async () => {
      const a = await flow()
      assert.equal(errorOf(a.location), 'OIDC_NO_ACCOUNT')
    })
  })

  it('existing local account, same email: linked only with OIDC_LINK_EXISTING and email_verified=true', async () => {
    const email = `local-${randomUUID().slice(0, 8)}@acme.test`
    const u = await localUser(email)
    // Not allowed by the operator
    const a = await flow({ claims: { email } })
    assert.equal(errorOf(a.location), 'OIDC_EMAIL_TAKEN')
    assert.equal(a.session, undefined)
    await withOidc({ linkExisting: true }, async () => {
      // Allowed, but the provider did not verify the address: refused (account takeover)
      const sub = randomUUID()
      const b = await flow({ claims: { email, sub, email_verified: false } })
      assert.equal(errorOf(b.location), 'OIDC_EMAIL_TAKEN')
      assert.equal(await identityOf(sub), undefined)
      // OIDC_TRUST_EMAIL does not open linking either
      await withOidc({ linkExisting: true, trustEmail: true }, async () => {
        const t = await flow({ claims: { email, sub, email_verified: undefined } })
        assert.equal(errorOf(t.location), 'OIDC_EMAIL_TAKEN')
      })
      // Verified: linked to the local account, which keeps its origin and password
      const c = await flow({ claims: { email, sub } })
      assert.equal((await auth.getSessionUser(c.session!))?.id, u.id)
      const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id))
      assert.equal(after.origin, 'local')
      assert.equal(after.passwordHash, u.passwordHash)
      assert.equal((await identityOf(sub))?.userId, u.id)
    })
  })

  it('an instance admin is never linked by email', async () => {
    const email = `admin-${randomUUID().slice(0, 8)}@acme.test`
    await localUser(email, true)
    await withOidc({ linkExisting: true }, async () => {
      const a = await flow({ claims: { email } })
      assert.equal(errorOf(a.location), 'OIDC_EMAIL_TAKEN')
    })
  })

  it('OIDC_REQUIRE_MFA: no amr → refused; amr with mfa → signed in', async () => {
    await withOidc({ requireMfa: true }, async () => {
      const a = await flow({ claims: { amr: ['pwd'] } })
      assert.equal(errorOf(a.location), 'OIDC_MFA_REQUIRED')
      const b = await flow({ claims: { amr: ['pwd', 'mfa'] } })
      assert.ok(b.session)
    })
  })

  it('a linked local account with Inkling 2FA on still gets the code step', async () => {
    const email = `totp-${randomUUID().slice(0, 8)}@acme.test`
    const u = await localUser(email)
    const secret = totp.newTotpSecret()
    const { sealSecret } = await import('./secretBox')
    await db.insert(schema.userTotp).values({ userId: u.id, secretEnc: sealSecret('totp-secret', secret, u.id), enabledAt: new Date() })
    await withOidc({ linkExisting: true }, async () => {
      const a = await flow({ claims: { email }, returnTo: '/w/z' })
      assert.equal(a.session, undefined)
      assert.match(a.location, /^\/login\?next=%2Fw%2Fz#totp=[A-Za-z0-9_-]+$/)
      const challenge = decodeURIComponent(a.location.split('#totp=')[1])
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        payload: { challenge, code: totp.hotp(secret, Math.floor(Date.now() / 30_000)) },
        remoteAddress: freshIp(),
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().user.id, u.id)
    })
  })

  it('connect from Settings: links to the signed-in account; a different session is refused', async () => {
    const email = `set-${randomUUID().slice(0, 8)}@acme.test`
    const u = await localUser(email)
    const { token } = await auth.createSession(u.id)
    const sub = randomUUID()
    // The provider email differs and is unverified: explicit linking does not depend on it.
    const a = await flow({ linkSession: token, session: token, claims: { sub, email: 'other@else.test', email_verified: false } })
    assert.equal(a.location, '/settings#account')
    assert.equal((await identityOf(sub))?.userId, u.id)
    // Started by u, finished in another person's session
    const v = await localUser(`set2-${randomUUID().slice(0, 8)}@acme.test`)
    const { token: vt } = await auth.createSession(v.id)
    const b = await flow({ linkSession: token, session: vt })
    assert.equal(errorOf(b.location), 'OIDC_LINK_SESSION')
    // An identity already linked to someone else
    const c = await flow({ linkSession: vt, session: vt, claims: { sub } })
    assert.equal(errorOf(c.location), 'OIDC_ALREADY_LINKED')
    // Cross-site start is refused by the Origin check (docs/adr/1062-*)
    const x = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/link',
      payload: {},
      headers: { cookie: `${auth.SESSION_COOKIE}=${token}`, origin: 'https://evil.example' },
    })
    assert.equal(x.statusCode, 403)
    // A delegated mirror account cannot connect a provider
    const [d] = await db
      .insert(schema.users)
      .values({ email: `d-${randomUUID().slice(0, 8)}@delegated.local`, name: 'd', passwordHash: 'x', origin: 'delegated' })
      .returning()
    const { token: dt } = await auth.createSession(d.id)
    const y = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/link',
      payload: {},
      headers: { cookie: `${auth.SESSION_COOKIE}=${dt}`, origin: 'https://notes.example.com' },
    })
    assert.equal(y.statusCode, 400)
    assert.equal(y.json().error.code, 'DELEGATED_ACCOUNT')
  })

  it('an OIDC-created account has no password sign-in and satisfies a workspace 2FA requirement', async () => {
    const c = claims()
    const a = await flow({ claims: c })
    const me = await auth.getSessionUser(a.session!)
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: c.email, password: 'anything-at-all' },
      remoteAddress: freshIp(),
    })
    assert.equal(r.statusCode, 401)
    assert.equal(await userSatisfiesTwoFactor(me!.id), true)
  })

  it('no client secret, code or id_token in the server log', () => {
    assert.ok(logs.length > 0)
    assert.ok(!logs.includes(CLIENT_SECRET))
    assert.ok(!logs.includes('eyJ')) // no JWT
    assert.ok(idp.issued.length > 10)
    for (const code of idp.issued) assert.ok(!logs.includes(code))
  })
})
