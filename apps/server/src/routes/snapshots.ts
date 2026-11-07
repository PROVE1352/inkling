import { and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createSnapshotSchema } from '@inkling/shared'
import type { SnapshotDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { db } from '../db/index'
import { pageDocs, pageSnapshots, users } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import {
  blocksToMarkdown,
  blocksToStateBuffer,
  blocksToXmlFragment,
  stateToBlocks,
} from '../md/convert'
import { findVisiblePage } from '../pageDto'
import { createSnapshot } from '../snapshotStore'
import { liveDocState } from '../liveConnections'

const snapshotParamsSchema = z.object({ id: z.uuid(), sid: z.uuid() })

/** Labels of snapshots the server names itself, stored in the creator's locale (docs/adr/0903-*). */
const LABELS = {
  en: { manual: 'Manual', beforeRestore: 'Before restore' },
  ko: { manual: '수동', beforeRestore: '복원 전' },
} satisfies Record<Locale, Record<string, string>>

export async function registerSnapshotRoutes(app: FastifyInstance): Promise<void> {
  // Manual snapshot — stores the current document state as a snapshot (default label "Manual")
  app.post('/pages/:id/snapshots', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const body = createSnapshotSchema.parse(req.body ?? {})

    const cur = (
      await db
        .select({ state: pageDocs.state })
        .from(pageDocs)
        .where(eq(pageDocs.pageId, id))
        .limit(1)
    )[0]
    if (!cur) throw badRequest('Nothing to snapshot')

    const label =
      body.label && body.label.length > 0 ? body.label : LABELS[await requestLocale(req, user.id)].manual
    await createSnapshot(id, cur.state, label, user.id)

    return { ok: true }
  })

  // Snapshot list — latest 50 (byte length only, the state blob is not sent)
  app.get('/pages/:id/snapshots', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const rows = await db
      .select({
        id: pageSnapshots.id,
        label: pageSnapshots.label,
        createdAt: pageSnapshots.createdAt,
        bytes: sql<number>`octet_length(${pageSnapshots.state})::int`,
        authorId: pageSnapshots.createdBy,
        authorName: users.name,
        viaClient: pageSnapshots.viaClient,
      })
      .from(pageSnapshots)
      .leftJoin(users, eq(users.id, pageSnapshots.createdBy))
      .where(eq(pageSnapshots.pageId, id))
      .orderBy(desc(pageSnapshots.createdAt))
      .limit(50)

    const snapshots: SnapshotDTO[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
      bytes: r.bytes,
      author: r.authorId && r.authorName !== null ? { id: r.authorId, name: r.authorName } : null,
      viaClient: r.viaClient,
    }))
    return { snapshots }
  })

  // Snapshot preview — markdown (stateToBlocks → blocksToMarkdown)
  app.get('/pages/:id/snapshots/:sid/preview', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, sid } = snapshotParamsSchema.parse(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const snap = (
      await db
        .select({ state: pageSnapshots.state })
        .from(pageSnapshots)
        .where(and(eq(pageSnapshots.id, sid), eq(pageSnapshots.pageId, id)))
        .limit(1)
    )[0]
    if (!snap) throw notFound()

    const blocks = stateToBlocks(snap.state)
    const { markdown } = await blocksToMarkdown(blocks, { assetMode: 'absolute' })
    return { markdown }
  })

  // Restore a snapshot — applied live to the open document (DirectConnection)
  app.post('/pages/:id/snapshots/:sid/restore', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, sid } = snapshotParamsSchema.parse(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    // Canvases (cnodes/cedges) are out of scope in v1 — only doc pages can be restored
    if (page.kind !== 'doc') {
      throw badRequest('Only document pages can be restored')
    }

    const snap = (
      await db
        .select({ state: pageSnapshots.state })
        .from(pageSnapshots)
        .where(and(eq(pageSnapshots.id, sid), eq(pageSnapshots.pageId, id)))
        .limit(1)
    )[0]
    if (!snap) throw notFound()

    // Keep the current state as a "Before restore" snapshot right before restoring (for undo)
    const cur = (
      await db
        .select({ state: pageDocs.state })
        .from(pageDocs)
        .where(eq(pageDocs.pageId, id))
        .limit(1)
    )[0]
    // Prefer the in-memory document: page_docs trails it by the store debounce (ADR 0757).
    const before = liveDocState(id) ?? cur?.state
    if (before) {
      await createSnapshot(id, before, LABELS[await requestLocale(req, user.id)].beforeRestore, user.id)
    }

    // Inject the snapshot blocks into the live document fragment → propagated live to viewing clients
    const blocks = stateToBlocks(snap.state)
    // Audit F4: if inject throws after the delete inside transact, Yjs does not roll back and the
    // live document is broadcast and persisted empty. Verify the conversion first (throwaway doc) to
    // guarantee "fully convert, then replace". If this throws, the live document is untouched.
    blocksToStateBuffer(blocks)
    const conn = await hocuspocus.openDirectConnection(id)
    try {
      await conn.transact((doc) => {
        // One Yjs transaction → one update broadcast (no transient empty document on clients).
        doc.transact(() => {
          const frag = doc.getXmlFragment('document')
          frag.delete(0, frag.length)
          blocksToXmlFragment(blocks, frag)
        })
      })
    } finally {
      await conn.disconnect()
    }

    return { ok: true }
  })
}
