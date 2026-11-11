import { assertWorkspaceWritable } from '../quota/room'
import { eq, sql } from 'drizzle-orm'
import { assertPageEditable } from '../editLock'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { saveInkSchema } from '@inkling/shared'
import type { InkDTO, InkStroke } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pageInk } from '../db/schema'
import { AppError, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage } from '../pageDto'
import { currentAgent } from '../agentAccess'
import { agentInkAllowed, agentInkOff } from '../agentInk'

// Ink layer (pen annotations): one stroke array per page, read and written as a whole,
// separately from the body. Visibility is decided exactly like the page's (ink on a private page
// is owner-only). Saving replaces everything. Optimistic concurrency (docs/adr/0815-*): the client sends the
// `updatedAt` its strokes are based on as `expectedUpdatedAt` (null = "no ink yet"). On a
// mismatch the PUT answers 412 INK_CONFLICT with the current ink, and the client merges its
// unsaved strokes into it and retries. Without the field (old clients) the last write wins,
// except that an unversioned empty list never replaces existing strokes (412, docs/adr/1340-*).

// Stroke JSON is around 200KB even for a fully written page, but allow well over the default 1MB
// for pages that fill the margins too. saveInkSchema caps the stroke count separately.
const INK_BODY_LIMIT = 8 * 1024 * 1024

// Extra body key read here only — the shared saveInkSchema is unchanged (it strips unknown keys).
const expectedSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
})

type InkRow = { strokes: unknown; updatedAt: Date }
const toDto = (pageId: string, row: InkRow | undefined): InkDTO => ({
  pageId,
  strokes: (row?.strokes as InkStroke[] | undefined) ?? [],
  updatedAt: row?.updatedAt?.toISOString() ?? null,
})

export async function registerInkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/ink', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    // MCP connections read ink only where the workspace allows it (docs/adr/1510-*).
    if (currentAgent() && !(await agentInkAllowed(page.workspaceId))) throw agentInkOff()

    const row = (
      await db
        .select({ strokes: pageInk.strokes, updatedAt: pageInk.updatedAt })
        .from(pageInk)
        .where(eq(pageInk.pageId, id))
        .limit(1)
    )[0]

    return { ink: toDto(id, row) }
  })

  app.put(
    '/pages/:id/ink',
    { preHandler: requireUser, bodyLimit: INK_BODY_LIMIT },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      await assertPageEditable(id, user.id)

      const body = saveInkSchema.parse(req.body)
      const { expectedUpdatedAt } = expectedSchema.parse(req.body)
      // full workspace (docs/adr/2506-*): clearing the handwriting is still allowed
      if (body.strokes.length) await assertWorkspaceWritable(db, page.workspaceId)

      const dto = await db.transaction(async (tx) => {
        // One writer per page at a time: the read of the current version and the write are one step.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'page-ink:' + id}))`)
        const [cur] = await tx
          .select({ strokes: pageInk.strokes, updatedAt: pageInk.updatedAt })
          .from(pageInk)
          .where(eq(pageInk.pageId, id))
          .limit(1)
        // A save that does not say which version it is based on may not wipe existing ink
        // (docs/adr/1340-*): such a request came from a layer that never saw the server's strokes
        // (still loading, load failed, or a leftover layer of another page), not from "Clear".
        const blindWipe =
          expectedUpdatedAt === undefined &&
          body.strokes.length === 0 &&
          Array.isArray(cur?.strokes) &&
          (cur.strokes as unknown[]).length > 0
        if (expectedUpdatedAt !== undefined || blindWipe) {
          const want = expectedUpdatedAt == null ? null : new Date(expectedUpdatedAt).getTime()
          const have = cur ? cur.updatedAt.getTime() : null
          if (blindWipe || want !== have) {
            throw new AppError(
              412,
              'INK_CONFLICT',
              'Ink was saved from another device first',
              undefined,
              { ink: toDto(id, cur) },
            )
          }
        }
        // Strictly increasing, so two saves in the same millisecond still differ as versions.
        const now = new Date(Math.max(Date.now(), (cur?.updatedAt.getTime() ?? 0) + 1))
        if (cur) {
          await tx
            .update(pageInk)
            .set({ strokes: body.strokes, updatedAt: now, updatedBy: user.id })
            .where(eq(pageInk.pageId, id))
        } else {
          await tx.insert(pageInk).values({ pageId: id, strokes: body.strokes, updatedAt: now, updatedBy: user.id })
        }
        return toDto(id, { strokes: body.strokes, updatedAt: now })
      })
      return { ink: dto }
    },
  )
}
