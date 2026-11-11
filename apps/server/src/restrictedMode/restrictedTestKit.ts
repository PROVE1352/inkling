/**
 * Test-only kit for the restricted-mode integration suites (0.22 glue, docs/adr/2525-*..2529-*): a
 * scratch database of their own (the cases need "no admin yet", account caps and a global trash purge,
 * which other files moving the shared database would disturb) and an app with the routes that sign-up,
 * consent, pages, limits and leaving go through, registered as index.ts does.
 *
 * Never imported by production code. Call `scratchDatabase` before anything imports `../db/index`.
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

/** Makes and migrates a database of this file's own, points DATABASE_URL at it; returns its dropper. */
export async function scratchDatabase(tag: string): Promise<() => Promise<void>> {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('scratchDatabase needs DATABASE_URL')
  const postgres = (await import('postgres')).default
  const admin = postgres(base, { max: 1, onnotice: () => {} })
  const name = `inkling_${tag}_${process.pid}_${randomBytes(4).toString('hex')}`
  await admin.unsafe(`CREATE DATABASE ${name}`)
  const url = new URL(base)
  url.pathname = `/${name}`
  process.env.DATABASE_URL = url.toString()
  const { runMigrations } = await import('../db/index')
  await runMigrations()
  return async () => {
    const { closeDb } = await import('../db/index')
    await closeDb()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
  }
}

/** An app with sign-up, workspaces, settings, pages, files and the restricted-mode pieces. */
export async function buildRestrictedApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default
  const { ZodError } = await import('zod')
  const { AppError } = await import('../errors')
  const app = Fastify()
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 25 * 1024 * 1024, files: 300 } })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter))
      return reply.code(err.status).send({ error: { ...(err.details ?? {}), code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } })
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: { code: 'VALIDATION', message: String(err) } })
    console.error(err)
    return reply.code(500).send({ error: { code: 'INTERNAL', message: String(err) } })
  })
  await app.register(
    async (api) => {
      await (await import('../routes/auth')).registerAuthRoutes(api)
      // as index.ts: the restricted-mode pieces right after the auth routes
      await (await import('../restricted')).registerRestrictedMode(api)
      await (await import('../routes/workspaces')).registerWorkspaceRoutes(api)
      await (await import('../routes/workspaceAdmin')).registerWorkspaceAdminRoutes(api)
      await (await import('../routes/pages')).registerPageRoutes(api)
      await (await import('../routes/files')).registerFileRoutes(api)
      await (await import('../routes/admin')).registerAdminRoutes(api)
    },
    { prefix: '/api' },
  )
  await app.ready()
  return app
}

/** `inkling_session=…` from a response's Set-Cookie. */
export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : String(raw ?? '')
  return first.split(';')[0]
}
