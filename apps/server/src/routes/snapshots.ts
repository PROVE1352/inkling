import { desc, eq, sql } from 'drizzle-orm'
import { assertPageEditable } from '../editLock'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createSnapshotSchema } from '@inkling/shared'
import type { SnapshotDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { db } from '../db/index'
import { pageDocs, pageSnapshots, users } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import {
  blocksToMarkdown,
  blocksToStateBuffer,
  blocksToXmlFragment,
} from '../md/convert'
import { findVisiblePage } from '../pageDto'
import { createSnapshot, snapshotBlocks } from '../snapshotStore'
import { liveDoc } from '../liveConnections'
import { pageEditGate } from '../docWriteGate'
import { gatedTransact } from '../md/docWrite'
import { actorOf, withEditActor } from '../context/attribution'

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
        .select({ state: pageDocs.state, stateVector: pageDocs.stateVector })
        .from(pageDocs)
        .where(eq(pageDocs.pageId, id))
        .limit(1)
    )[0]
    if (!cur) throw badRequest('Nothing to snapshot')

    const label =
      body.label && body.label.length > 0 ? body.label : LABELS[await requestLocale(req, user.id)].manual
    await createSnapshot(id, cur, label, user.id)

    return { ok: true }
  })

  // Snapshot list — latest 50 (byte length only, the state blob is not sent). `bytes` is what the
  // row stores: a whole state, or the diff from the previous version (docs/adr/1100-*).
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

    // Rebuilt from its diff chain (docs/adr/1100-*); a broken chain answers 409 SNAPSHOT_UNAVAILABLE.
    const blocks = await snapshotBlocks(id, sid)
    if (!blocks) throw notFound()
    const { markdown } = await blocksToMarkdown(blocks, { assetMode: 'absolute' })
    return { markdown }
  })

  // Restore a snapshot — applied live to the open document (DirectConnection)
  app.post('/pages/:id/snapshots/:sid/restore', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, sid } = snapshotParamsSchema.parse(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    // Role and the workspace's lock state come with the membership (docs/adr/1071-*).
    const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
    await assertPageEditable(id, user.id, { role, acl })

    // Canvases (cnodes/cedges) are out of scope in v1 — only doc pages can be restored
    if (page.kind !== 'doc') {
      throw badRequest('Only document pages can be restored')
    }

    // Rebuilt from its diff chain (docs/adr/1100-*) before anything is written: a broken chain
    // answers 409 SNAPSHOT_UNAVAILABLE and leaves the page and its history untouched.
    const blocks = await snapshotBlocks(id, sid)
    if (!blocks) throw notFound()

    // Keep the current state as a "Before restore" snapshot right before restoring (for undo).
    // Prefer the in-memory document: page_docs trails it by the store debounce (ADR 0757).
    const live = liveDoc(id)
    const cur = live
      ? null
      : (
          await db
            .select({ state: pageDocs.state, stateVector: pageDocs.stateVector })
            .from(pageDocs)
            .where(eq(pageDocs.pageId, id))
            .limit(1)
        )[0]
    const before = live ?? cur
    // The restore is a new edit on top of the history, never a rewind: this snapshot undoes it
    // (restore it again). An agent restore records its client like other agent edits (docs/adr/0936-*).
    if (before) {
      await createSnapshot(id, before, LABELS[await requestLocale(req, user.id)].beforeRestore, user.id, user.via ?? null)
    }

    // Inject the snapshot blocks into the live document fragment → propagated live to viewing clients
    // Audit F4: if inject throws after the delete inside transact, Yjs does not roll back and the
    // live document is broadcast and persisted empty. Verify the conversion first (throwaway doc) to
    // guarantee "fully convert, then replace". If this throws, the live document is untouched.
    blocksToStateBuffer(blocks)
    // Under the write gate (docs/adr/1151-*, 1513-*): a lock change, agent block or member removal
    // that commits after the check above is seen before the edit, or waits until it is applied.
    // The change feed records who restored it (and the agent's client).
    const gate = pageEditGate(id, page.workspaceId, user.id, { role, acl })
    await withEditActor([id], actorOf(user), async () => {
      const conn = await hocuspocus.openDirectConnection(id)
      try {
        await gatedTransact(
          conn,
          (doc) => {
            // One Yjs transaction → one update broadcast (no transient empty document on clients).
            doc.transact(() => {
              const frag = doc.getXmlFragment('document')
              frag.delete(0, frag.length)
              blocksToXmlFragment(blocks, frag)
            })
          },
          gate,
        )
      } finally {
        await conn.disconnect()
      }
    })

    return { ok: true }
  })
}
