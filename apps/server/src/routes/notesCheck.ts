import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { NOTES_CHECK_MAX_LIMIT, notesCheck } from '../notesCheck'
import { findVisiblePage } from '../pageDto'

/**
 * Memory check (docs/adr/2003-*).
 *
 *   GET /workspaces/:id/notes-check?parentId=&limit=  → NotesCheckDTO (members; tokens too, read-only)
 *
 * Membership, agent blocks, the two-step requirement and the connection range are requireMembership's
 * and visibleTo's, as for every read route; `parentId` must be a page the caller can see in this
 * workspace (else 404, the same answer as for an id that does not exist).
 */

const querySchema = z.object({
  parentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(NOTES_CHECK_MAX_LIMIT).optional(),
})

export async function registerNotesCheckRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workspaces/:id/notes-check', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const wsId = idParam(req.params)
    await requireMembership(wsId, user.id)
    const q = querySchema.parse(req.query)
    if (q.parentId) {
      const root = await findVisiblePage(q.parentId, user.id)
      if (!root || root.workspaceId !== wsId) throw notFound('PAGE_NOT_FOUND', 'Page not found')
    }
    return notesCheck(wsId, user.id, q.parentId ?? null, { limit: q.limit })
  })
}
