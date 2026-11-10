import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { MemberStatusDTO } from '@inkling/shared'
import { setMemberStatusSchema } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { userStatuses } from '../db/schema'
import { badRequest, forbidden } from '../errors'
import { liveStatusSql, toStatusDTO } from '../memberStatus'

/**
 * The caller's own status (docs/adr/1845-*).
 *
 *   GET    /me/status   → { status: MemberStatusDTO | null }
 *   PUT    /me/status   { emoji?, text, clearAt? } → { status }
 *   DELETE /me/status   → { status: null }
 *
 * Setting it is a person's act: browser sessions only (agents and API tokens can read it through
 * the members list, never set it). Others see it in the members list, the mention menu and
 * presence of every workspace they share with the person.
 */

const YEAR_MS = 366 * 86_400_000

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Your status is set in the web app')
}

async function readOwn(userId: string): Promise<MemberStatusDTO | null> {
  const [row] = await db
    .select({ emoji: userStatuses.emoji, text: userStatuses.text, clearAt: userStatuses.clearAt })
    .from(userStatuses)
    .where(and(eq(userStatuses.userId, userId), liveStatusSql()))
    .limit(1)
  return toStatusDTO(row)
}

export async function registerMemberStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/status', { preHandler: requireUser }, async (req) => {
    return { status: await readOwn(getUser(req).id) }
  })

  app.put('/me/status', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const body = setMemberStatusSchema.parse(req.body ?? {})
    let clearAt: Date | null = null
    if (body.clearAt) {
      clearAt = new Date(body.clearAt)
      const now = Date.now()
      if (Number.isNaN(clearAt.getTime())) throw badRequest('clearAt is not a valid date')
      if (clearAt.getTime() <= now) throw badRequest('Pick a clear time in the future')
      if (clearAt.getTime() > now + YEAR_MS) throw badRequest('Pick a clear time within a year')
    }
    const values = { emoji: body.emoji ?? null, text: body.text, clearAt, updatedAt: new Date() }
    await db
      .insert(userStatuses)
      .values({ userId: user.id, ...values })
      .onConflictDoUpdate({ target: userStatuses.userId, set: values })
    return { status: toStatusDTO(values) }
  })

  app.delete('/me/status', { preHandler: requireSessionUser }, async (req) => {
    await db.delete(userStatuses).where(eq(userStatuses.userId, getUser(req).id))
    return { status: null }
  })
}
