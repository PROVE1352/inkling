import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { CATCH_UP_MAX_BUDGET, CatchUpError, readCatchUp } from '../catchUp'
import { AppError } from '../errors'
import { requireMembership } from '../helpers'

/**
 * catch_up (docs/adr/1520-*): ranked material for "what happened while I was away".
 * GET so read-only tokens may call it; the one thing it writes is the caller's own "last catch_up"
 * marker (bookkeeping like oauth_grants.last_used_at, never notes, never the inbox ack).
 *
 *   GET /catch-up?since&workspaceId&budget&advance=0
 *     → { text, cursor, since: { at, source }, counts, tokens }
 */
const catchUpQuerySchema = z.object({
  since: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.uuid().optional(),
  budget: z.coerce.number().int().min(1).max(CATCH_UP_MAX_BUDGET).optional(),
  advance: z.enum(['0', '1']).optional(),
  /** 1 = add the team agents group (docs/adr/1865-*). */
  team: z.enum(['0', '1']).optional(),
})

export async function registerCatchUpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catch-up', { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = getUser(req)
    const q = catchUpQuerySchema.parse(req.query)
    if (q.workspaceId) await requireMembership(q.workspaceId, user.id)
    const connection = user.grantId ? `grant:${user.grantId}` : user.tokenId ? `token:${user.tokenId}` : null
    try {
      return await readCatchUp(
        { userId: user.id, connection, workspaceId: q.workspaceId ?? null },
        { since: q.since, workspaceId: q.workspaceId, budget: q.budget, advance: q.advance !== '0', team: q.team === '1' },
      )
    } catch (err) {
      if (err instanceof CatchUpError) throw new AppError(400, err.code, err.message)
      throw err
    }
  })
}
