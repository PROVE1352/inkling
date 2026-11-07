import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { FEED_MAX_BUDGET, FeedError, readChangeFeed } from '../context/changeFeed'
import { AppError } from '../errors'
import { requireMembership } from '../helpers'

/**
 * Change feed (docs/adr/0932-*): what changed in the caller's visible pages since a cursor.
 * GET so read-only MCP tokens may call it (MCP tool changes_since).
 *
 *   GET /changes?cursor&workspaceId&budget&detail
 *     → { status: 'start'|'ok'|'resync_required', cursor, text, changes, detailed, listedOnly, rows, more }
 */
const changesQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.uuid().optional(),
  budget: z.coerce.number().int().min(1).max(FEED_MAX_BUDGET).optional(),
  detail: z.enum(['none', 'diff', 'full']).optional(),
})

export async function registerChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/changes', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = changesQuerySchema.parse(req.query)
    if (q.workspaceId) await requireMembership(q.workspaceId, user.id)
    try {
      return await readChangeFeed(user.id, q)
    } catch (err) {
      if (err instanceof FeedError) throw new AppError(400, err.code, err.message)
      throw err
    }
  })
}
