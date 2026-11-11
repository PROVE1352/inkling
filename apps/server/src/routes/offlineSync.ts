import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { getUser, requireUser } from '../auth'
import { DOC_SCHEMA_VERSION, parseSchemaVersion, SCHEMA_PARAM } from '@inkling/shared'
import { hocuspocus, pageSchemaNeeds } from '../collab'
import { db } from '../db/index'
import { pageDocs, pages } from '../db/schema'
import { CAP_EDIT, capsFor } from '../editLock'
import { forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { visibleTo } from '../pageDto'
import { peopleScopeFor, runAsGuest } from '../pageGrants'
import { liveWorkspace } from '../workspaceLive'
import { stateVectorOfStored } from '../yState'

/**
 * What a browser needs before its device copy of a page talks to the collaboration socket
 * (docs/adr/2201-*, 2202-*): the document generation, whether the caller may still edit, whether the
 * page is in the trash, and the server's state vector (to see a document whose history was replaced,
 * e.g. a database restored from a backup). Read-only; same visibility as the collaboration socket,
 * except that a trashed page the caller could see answers `trashed: true` instead of 404, so the
 * browser can keep unsent edits as a recovery item (a page the caller cannot see is 404 either way).
 * `?schema=N` (0.20, docs/adr/2425-*): the document schema of the client that made the copy's unsent
 * edits; when it is below the server's, the answer carries `needs`, the schema the page needs now, so
 * the browser does not send edits an older app made without seeing everything on the page.
 */
export type SyncCheckDTO = { gen: number; canEdit: boolean; trashed: boolean; sv: string; needs?: number }

export async function registerOfflineSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/sync-check', { preHandler: requireUser }, async (req, reply) => {
    // For the browser's device copies only: the checks below mirror the collaboration socket, which
    // takes session cookies, not agent tokens (token ranges and agent blocks are not applied here).
    if (req.authVia === 'bearer') throw forbidden('Only the web app uses this route')
    const user = getUser(req)
    const id = idParam(req.params)
    const scope = await peopleScopeFor(user.id, !!user.hasGrants, false)
    const [page] = await runAsGuest(scope, () =>
      db
        .select({ workspaceId: pages.workspaceId, kind: pages.kind, deletedAt: pages.deletedAt, docGen: pages.docGen })
        .from(pages)
        .where(and(eq(pages.id, id), visibleTo(user.id), liveWorkspace(pages.workspaceId)))
        .limit(1),
    )
    if (!page || page.kind !== 'doc') throw notFound()
    const role = await requireMembership(page.workspaceId, user.id, { guests: true })
    const trashed = page.deletedAt !== null
    let canEdit = false
    if (!trashed) {
      const caps = await runAsGuest(scope, () => capsFor(db, [id], { userId: user.id, role, agent: false }))
      canEdit = !!((caps.get(id) ?? 0) & CAP_EDIT)
    }
    // The live document is ahead of page_docs by the store debounce: prefer it.
    const live = hocuspocus.documents.get(id)
    let sv: Uint8Array
    if (live) sv = Y.encodeStateVector(live)
    else {
      // state_vector is written with every store (V1 encoding); rows written by importers may lack it
      const [row] = await db.select({ sv: pageDocs.stateVector }).from(pageDocs).where(eq(pageDocs.pageId, id)).limit(1)
      if (row?.sv && row.sv.length > 0) sv = row.sv
      else {
        const [full] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, id)).limit(1)
        sv = full?.state ? stateVectorOfStored(full.state) : Y.encodeStateVector(new Y.Doc())
      }
    }
    reply.header('cache-control', 'no-store')
    const dto: SyncCheckDTO = { gen: page.docGen, canEdit, trashed, sv: Buffer.from(sv).toString('base64') }
    const asked = (req.query as Record<string, unknown> | undefined)?.[SCHEMA_PARAM]
    if (asked !== undefined && parseSchemaVersion(asked) < DOC_SCHEMA_VERSION) dto.needs = await pageSchemaNeeds(id)
    return dto
  })
}
