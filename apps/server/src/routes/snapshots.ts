import { assertWorkspaceWritable } from '../quota/room'
import { desc, eq, sql } from 'drizzle-orm'
import { assertPageEditable } from '../editLock'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createSnapshotSchema } from '@inkling/shared'
import type { SnapshotDTO, SnapshotStepDTO } from '@inkling/shared'
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
import type { StepMeta } from '../snapshotStore'
import { asAgentStep } from '../context/sectionWrite'
import { isAgentVia } from '../agentVia'
import { liveDoc } from '../liveConnections'
import { pageEditGate } from '../docWriteGate'
import { gatedTransact } from '../md/docWrite'
import { actorOf, withEditActor } from '../context/attribution'
import { bumpDocGen } from '../docGen'

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
    await assertWorkspaceWritable(db, page.workspaceId) // a full workspace takes no new version (docs/adr/2506-*)

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
        step: pageSnapshots.step,
      })
      .from(pageSnapshots)
      .leftJoin(users, eq(users.id, pageSnapshots.createdBy))
      .where(eq(pageSnapshots.pageId, id))
      // id last: rows of one transaction share created_at (deterministic order, docs/adr/0937-*)
      .orderBy(desc(pageSnapshots.createdAt), desc(pageSnapshots.id))
      .limit(50)

    const steps = stepNumbers(rows)
    const snapshots: SnapshotDTO[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
      bytes: r.bytes,
      author: r.authorId && r.authorName !== null ? { id: r.authorId, name: r.authorName } : null,
      viaClient: r.viaClient,
      ...(r.step ? { step: steps.get(r.id)! } : {}),
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

    const locale = () => requestLocale(req, user.id)
    // The restore itself (applied live to the open document, under the write gate).
    const apply = async () => {
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
      // After the content (docs/adr/2201-*): device copies with unsent edits stop merging blindly.
      await bumpDocGen(id)
    }

    // An agent's restore is one AI step (docs/adr/2180-*, 2181-*): the page before it is a version
    // (its previous step when nothing happened since, else a "Before restore" row) and the restored
    // page is a new step on top; the steps after the restored version stay in the history.
    if (isAgentVia(user.via)) {
      const r = await asAgentStep(id, user, locale, async () => {
        await apply()
        return { result: undefined, step: { tool: 'restore_version', restoredFrom: sid } satisfies StepMeta }
      }, { beforeLabel: 'beforeRestore' })
      return { ok: true, before: r.before, step: r.step }
    }

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
    const saved = before ? await createSnapshot(id, before, LABELS[await locale()].beforeRestore, user.id, user.via ?? null) : null
    await apply()
    return { ok: true, before: saved, step: null }
  })
}

/**
 * Step numbers of AI step rows (newest first in `rows`): a run is consecutive step rows of one client
 * with no other row in between; its steps count from 1, oldest first (docs/adr/2180-*).
 */
export function stepNumbers(rows: { id: string; viaClient: string | null; step: unknown }[]): Map<string, SnapshotStepDTO> {
  const out = new Map<string, SnapshotStepDTO>()
  let prev: { via: string | null; n: number } | null = null
  for (const r of [...rows].reverse()) {
    const meta = r.step as StepMeta | null
    if (!meta) {
      prev = null
      continue
    }
    const n: number = prev && prev.via === r.viaClient ? prev.n + 1 : 1
    prev = { via: r.viaClient, n }
    out.set(r.id, {
      n,
      tool: meta.tool,
      ...(meta.mode ? { mode: meta.mode } : {}),
      sections: meta.sections ?? [],
      ...(meta.more ? { more: meta.more } : {}),
      ...(typeof meta.added === 'number' ? { added: meta.added } : {}),
      ...(typeof meta.removed === 'number' ? { removed: meta.removed } : {}),
      ...(meta.restoredFrom ? { restoredFrom: meta.restoredFrom } : {}),
    })
  }
  return out
}
