import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createApiTokenSchema, updateApiTokenSchema, API_TOKEN_MAX_PER_USER } from '@inkling/shared'
import type { CreatedApiTokenDTO } from '@inkling/shared'
import { getUser, requireAdmin, requireUser } from '../auth'
import { db } from '../db/index'
import { apiTokens, users } from '../db/schema'
import { AppError, forbidden, notFound } from '../errors'
import { idParam } from '../helpers'
import {
  adminListApiTokens,
  countApiTokens,
  createApiToken,
  getApiToken,
  listApiTokens,
  revokeAllApiTokens,
} from '../apiTokens'
import { rangeToColumns, validateRange } from '../tokenRange'

/**
 * Personal API tokens (docs/adr/1201-*). Browser sessions only: a token never makes, lists or
 * revokes tokens (an API token or MCP token gets 403), so a leaked token cannot mint a longer-lived
 * one or hide itself.
 *
 *   GET    /api/tokens                         my tokens (no secrets)
 *   POST   /api/tokens                         make one → { token, secret } (secret shown once)
 *   PATCH  /api/tokens/:id                     rename or change the range
 *   DELETE /api/tokens/:id                     revoke
 *   GET    /api/admin/users/:id/api-tokens     instance admin: a user's tokens
 *   DELETE /api/admin/users/:id/api-tokens     instance admin: revoke all of them
 *   DELETE /api/admin/api-tokens/:id           instance admin: revoke one
 */

async function requireCookieUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('API tokens are managed in the web app only')
}

export async function registerApiTokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tokens', { preHandler: requireCookieUser }, async (req) => {
    const user = getUser(req)
    return { tokens: await listApiTokens(user.id) }
  })

  app.post(
    '/tokens',
    { preHandler: requireCookieUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const body = createApiTokenSchema.parse(req.body)
      if ((await countApiTokens(user.id)) >= API_TOKEN_MAX_PER_USER) {
        throw new AppError(409, 'TOO_MANY_TOKENS', `You can hold at most ${API_TOKEN_MAX_PER_USER} API tokens. Revoke one first`)
      }
      await validateRange(user.id, body.range)
      const { id, secret } = await createApiToken(user.id, body)
      const token = await getApiToken(user.id, id)
      const out: CreatedApiTokenDTO = { token: token!, secret }
      return reply.code(201).header('Cache-Control', 'no-store').send(out)
    },
  )

  app.patch('/tokens/:id', { preHandler: requireCookieUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = updateApiTokenSchema.parse(req.body)
    if (body.range) await validateRange(user.id, body.range)
    const updated = await db
      .update(apiTokens)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.range ? rangeToColumns(body.range) : {}),
      })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id)))
      .returning({ id: apiTokens.id })
    if (updated.length === 0) throw notFound()
    return { token: await getApiToken(user.id, id) }
  })

  app.delete('/tokens/:id', { preHandler: requireCookieUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const deleted = await db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id)))
      .returning({ id: apiTokens.id })
    if (deleted.length === 0) throw notFound()
    return reply.code(204).send()
  })

  // ── Instance admin (browser sessions only, requireAdmin) ───────────────
  app.get('/admin/users/:id/api-tokens', { preHandler: requireAdmin }, async (req) => {
    const id = idParam(req.params)
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1)
    if (!u) throw notFound()
    return { tokens: await adminListApiTokens(id) }
  })

  app.delete('/admin/users/:id/api-tokens', { preHandler: requireAdmin }, async (req) => {
    const id = idParam(req.params)
    return { revoked: await revokeAllApiTokens(id) }
  })

  app.delete('/admin/api-tokens/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam(req.params)
    const deleted = await db.delete(apiTokens).where(eq(apiTokens.id, id)).returning({ id: apiTokens.id })
    if (deleted.length === 0) throw notFound()
    return reply.code(204).send()
  })
}
