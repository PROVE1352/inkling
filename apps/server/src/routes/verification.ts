import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PageVerificationStatusDTO, VerifiedListDTO, WorkspaceRole } from '@inkling/shared'
import { VERIFY_MAX_DAYS, verifiedListQuerySchema, verifyPageSchema } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pageVerifications, pages } from '../db/schema'
import { assertPageEditable } from '../editLock'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage } from '../pageDto'
import { computeReviewScores } from '../review'
import { listVerified, pageChangeHighWater, verificationsFor } from '../verification'
import { isManagerRole, recordAudit } from '../workspaceAdmin'

/**
 * Page verification routes (docs/adr/1840-*).
 *
 *   GET    /pages/:id/verification          → PageVerificationStatusDTO (members; tokens too, read-only)
 *   POST   /pages/:id/verification          { expiresInDays | expiresAt, note? } → verify (or re-verify)
 *   DELETE /pages/:id/verification          → remove it
 *   GET    /workspaces/:id/verified?days&mine → VerifiedListDTO (pages the caller can see)
 *
 * Verifying is a person's statement: browser sessions only (an agent cannot vouch for a page). Who:
 * a member who may edit the page; when the page has a document owner (docs/adr/0951-*), only that
 * owner or a workspace owner/admin. Guests never. `pages.updated_at` is not touched (the content did
 * not change; public render caches stay valid). Verifying also counts as a review (reviewed_at).
 */

const DAY_MS = 86_400_000

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Pages are verified in the web app')
}

/** Why `userId` may not verify (null = may). Edit rights come from the lock and people rows. */
async function verifyRefusal(
  page: { id: string; kind: string },
  ownerId: string | null,
  userId: string,
  role: WorkspaceRole,
): Promise<AppError | null> {
  if (page.kind === 'folder') return badRequest('Folders are not verified')
  try {
    await assertPageEditable(page.id, userId, { role })
  } catch (err) {
    if (err instanceof AppError) return err
    throw err
  }
  if (ownerId && ownerId !== userId && !isManagerRole(role)) {
    return forbidden("Only the page's owner or a workspace admin can verify this page")
  }
  return null
}

async function loadTarget(req: FastifyRequest) {
  const user = getUser(req)
  const pageId = idParam(req.params)
  const page = await findVisiblePage(pageId, user.id)
  if (!page) throw notFound()
  // members only: a guest's requireMembership is a 403 (docs/adr/1252-*)
  const role = await requireMembership(page.workspaceId, user.id)
  const [row] = await db.select({ ownerId: pages.ownerId }).from(pages).where(eq(pages.id, page.id)).limit(1)
  return { user, page, role, ownerId: row?.ownerId ?? null }
}

async function statusDTO(pageId: string, canVerify: boolean): Promise<PageVerificationStatusDTO> {
  return { verification: (await verificationsFor([pageId])).get(pageId) ?? null, canVerify }
}

export async function registerVerificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/verification', { preHandler: requireUser }, async (req) => {
    const { user, page, role, ownerId } = await loadTarget(req)
    const canVerify = req.authVia === 'cookie' && (await verifyRefusal(page, ownerId, user.id, role)) === null
    return statusDTO(page.id, canVerify)
  })

  app.post('/pages/:id/verification', { preHandler: requireSessionUser }, async (req) => {
    const { user, page, role, ownerId } = await loadTarget(req)
    const body = verifyPageSchema.parse(req.body ?? {})
    const refusal = await verifyRefusal(page, ownerId, user.id, role)
    if (refusal) throw refusal
    const now = Date.now()
    let expiresAt: Date
    if (body.expiresInDays !== undefined) expiresAt = new Date(now + body.expiresInDays * DAY_MS)
    else {
      expiresAt = new Date(body.expiresAt!)
      if (Number.isNaN(expiresAt.getTime())) throw badRequest('expiresAt is not a valid date')
      if (expiresAt.getTime() <= now + 60_000) throw badRequest('Pick an expiry in the future')
      if (expiresAt.getTime() > now + VERIFY_MAX_DAYS * DAY_MS) throw badRequest('Pick an expiry within a year')
    }
    const note = body.note?.trim() ? body.note.trim() : null
    const baseSeq = await pageChangeHighWater(page.id)
    await db.transaction(async (tx) => {
      const values = { workspaceId: page.workspaceId, verifiedBy: user.id, verifiedAt: new Date(now), expiresAt, baseSeq, note }
      await tx
        .insert(pageVerifications)
        .values({ pageId: page.id, ...values })
        .onConflictDoUpdate({ target: pageVerifications.pageId, set: values })
      // a verification is also a review (docs/adr/0951-*): the page leaves the review list
      await tx.update(pages).set({ reviewedAt: new Date(now), reviewedBy: user.id }).where(eq(pages.id, page.id))
      await recordAudit(tx, {
        workspaceId: page.workspaceId,
        actor: user,
        action: 'page.verified',
        target: { type: 'page', id: page.id, label: page.scope === 'private' ? null : page.title },
        after: { expiresAt: expiresAt.toISOString() },
      })
    })
    // the page's review priority follows at once, as after "Mark reviewed"
    await computeReviewScores(page.workspaceId, new Date(), [page.id])
    return statusDTO(page.id, true)
  })

  app.delete('/pages/:id/verification', { preHandler: requireSessionUser }, async (req) => {
    const { user, page, role, ownerId } = await loadTarget(req)
    const refusal = await verifyRefusal(page, ownerId, user.id, role)
    if (refusal) throw refusal
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(pageVerifications)
        .where(eq(pageVerifications.pageId, page.id))
        .returning({ pageId: pageVerifications.pageId })
      if (removed.length) {
        await recordAudit(tx, {
          workspaceId: page.workspaceId,
          actor: user,
          action: 'page.unverified',
          target: { type: 'page', id: page.id, label: page.scope === 'private' ? null : page.title },
        })
      }
    })
    return statusDTO(page.id, true)
  })

  app.get('/workspaces/:id/verified', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const wsId = idParam(req.params)
    await requireMembership(wsId, user.id)
    const q = verifiedListQuerySchema.parse(req.query ?? {})
    const res: VerifiedListDTO = await listVerified(wsId, user.id, { expiringDays: q.days, mine: q.mine === '1' })
    return res
  })
}
