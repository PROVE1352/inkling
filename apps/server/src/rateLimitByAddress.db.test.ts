// Routes reached without signing in count their own rate limit by address, so a made-up
// `Bearer ink_pat_…` per request no longer starts a fresh bucket (0.25.4 security fix, A-F1 / F-1).
// The app is built as index.ts builds it (global limiter keyed by rateLimitKey), with every route module
// that registers such a route; each case sends max requests with a new random token each, then one more.
// Run: cd apps/server && DATABASE_URL=postgres://… node ../../scripts/run-tests.mjs --db
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const webDist = mkdtempSync(path.join(tmpdir(), 'inkling-rl-web-'))
writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>')
process.env.WEB_DIST = webDist
process.env.PUBLIC_URL ||= 'https://notes.example.com/'
process.env.APP_URL ||= 'https://notes.example.com'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'

const HAS_DB = !!process.env.DATABASE_URL

describe('[db] unauthenticated routes: a made-up bearer per request does not reset the limit', { skip: !HAS_DB }, async () => {
  if (!HAS_DB) return
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('./errors')
  const { rateLimitKey } = await import('./rateLimitKey')
  const { closeDb } = await import('./db/index')
  const { API_TOKEN_PREFIX } = await import('@inkling/shared')

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const raw = body as string
      if (!raw || raw.trim() === '') return done(null, undefined)
      try {
        done(null, JSON.parse(raw))
      } catch (err) {
        ;(err as { statusCode?: number }).statusCode = 400
        done(err as Error, undefined)
      }
    })
    await app.register(import('@fastify/cookie'))
    // as index.ts
    await app.register(import('@fastify/rate-limit'), {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      allowList: (req) => req.method === 'GET' && !/^\/(api|mcp|oauth|files|collab|\.well-known)(\/|\?|$)/.test(req.url),
      errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Too many requests'),
      keyGenerator: rateLimitKey,
    })
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'x' } })
      const status = (err as { statusCode?: number }).statusCode
      return reply.code(typeof status === 'number' && status >= 400 && status < 500 ? status : 500).send({ error: { code: 'X', message: String(err) } })
    })
    await app.register(
      async (api) => {
        await (await import('./routes/auth')).registerAuthRoutes(api)
        await (await import('./routes/oidc')).registerOidcRoutes(api)
        await (await import('./routes/public')).registerPublicRoutes(api)
        await (await import('./routes/forms')).registerFormRoutes(api)
      },
      { prefix: '/api' },
    )
    await app.register(async (pub) => {
      await (await import('./routes/oauth')).registerOAuthRoutes(pub)
    })
    await (await import('./routes/ical')).registerIcalFeedRoute(app)
    await (await import('./routes/shareMeta')).registerShareMetaRoutes(app)
    return app
  }

  const app = await buildApp()
  after(async () => {
    await app.close()
    await closeDb()
  })

  const fake = () => `Bearer ${API_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`
  const json = { 'content-type': 'application/json' }
  type Case = { method: 'GET' | 'POST'; url: string; max: number; headers?: Record<string, string>; payload?: string }
  const cases: Case[] = [
    { method: 'POST', url: '/oauth/register', max: 20, headers: json, payload: JSON.stringify({ redirect_uris: ['notaurl'] }) },
    { method: 'POST', url: '/oauth/token', max: 20, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=nope' },
    { method: 'POST', url: '/api/auth/verify-email/send', max: 5, headers: json, payload: '{}' },
    { method: 'GET', url: '/api/auth/oidc/start', max: 30 },
    { method: 'GET', url: '/api/auth/oidc/callback?code=x&state=y', max: 30 },
    { method: 'GET', url: '/api/public/forms/nosuchformtoken0000000', max: 60 },
    { method: 'POST', url: '/api/public/forms/nosuchformtoken0000000', max: 10, headers: json, payload: '{}' },
    { method: 'GET', url: '/api/public/nosuchsharetoken000000', max: 60 },
    { method: 'GET', url: '/api/public/nosuchsharetoken000000/export.md', max: 60 },
    { method: 'POST', url: '/api/public/nosuchsharetoken000000/unlock', max: 10, headers: json, payload: JSON.stringify({ password: 'x' }) },
    { method: 'GET', url: '/ical/nosuchicaltoken.ics', max: 30 },
    { method: 'GET', url: '/s/nosuchsharetoken000000', max: 120 },
  ]

  let ip = 1
  for (const c of cases) {
    it(`${c.method} ${c.url}: ${c.max} allowed, number ${c.max + 1} is 429`, async () => {
      const remoteAddress = `198.51.100.${ip++}`
      const send = () =>
        app.inject({ method: c.method, url: c.url, remoteAddress, headers: { ...(c.headers ?? {}), authorization: fake() }, payload: c.payload })
      for (let i = 0; i < c.max; i++) {
        const r = await send()
        assert.notEqual(r.statusCode, 429, `#${i + 1}: ${r.body}`)
      }
      const over = await send()
      assert.equal(over.statusCode, 429, over.body)
    })
  }

  it('IPv6: every address of one /64 shares the bucket', async () => {
    const send = (n: number) =>
      app.inject({ method: 'POST', url: '/oauth/register', remoteAddress: `2001:db8:77:1::${n.toString(16)}`, headers: { ...json, authorization: fake() }, payload: '{}' })
    for (let i = 1; i <= 20; i++) assert.notEqual((await send(i)).statusCode, 429)
    assert.equal((await send(999)).statusCode, 429)
  })
})
