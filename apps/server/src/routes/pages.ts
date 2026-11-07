import { randomBytes, randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, ilike, inArray, isNull, max, ne, notExists, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createPageSchema, updatePageSchema } from '@inkling/shared'
import type {
  CollectionField,
  PageProperty,
  PageScope,
  ShareStatusDTO,
} from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db, withSsdPlanCosts } from '../db/index'
import {
  collectionViews,
  collections,
  files,
  pageDocs,
  pageLinks,
  pageTags,
  pageTexts,
  pages,
} from '../db/schema'
import { env } from '../env'
import { badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { blocksToCanvasState } from '../md/expand'
import { reindexPageTasksForPages } from '../md/taskIndex'
import { loadSharedSubtree } from './public'
import { assertPlacement, descendantsCte, lockTree, purgeDeletedSubtrees, withTreeLock } from '../pageTree'
import { findVisiblePage, pageColumns, toPageDTO, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import { escapeLike } from '../util'
import { closeConnectionsLosingPrivateAccess } from '../liveConnections'
import { precheckEtag } from '../httpCache'
import { workspaceVersion } from '../versions'
import { emitWebhookEvent } from '../webhooks'

const shortId = (): string => randomUUID().slice(0, 8)

/**
 * Names of things this route creates on the user's behalf (default fields, views, properties,
 * copy/map titles), in the creator's locale (docs/adr/0903-*). Stored as data, so existing rows
 * keep whatever language they were created in.
 */
const NAMES = {
  en: {
    status: 'Status',
    todo: 'To do',
    inProgress: 'In progress',
    done: 'Done',
    assignee: 'Assignee',
    due: 'Due',
    date: 'Date',
    tableView: 'Table',
    fullWidth: 'Full width',
    untitled: 'Untitled',
    copyOf: (title: string) => `Copy of ${title}`,
    mapOf: (title: string) => `${title} — map`,
  },
  ko: {
    status: '상태',
    todo: '할 일',
    inProgress: '진행 중',
    done: '완료',
    assignee: '담당',
    due: '마감',
    date: '날짜',
    tableView: '표',
    fullWidth: '전체 너비',
    untitled: '제목 없음',
    copyOf: (title: string) => `${title}의 사본`,
    mapOf: (title: string) => `${title} — 맵`,
  },
} satisfies Record<Locale, Record<string, string | ((title: string) => string)>>

/**
 * Public share token — an unguessable 128-bit random value (base64url).
 * pages.shareToken is unique, so retry on a clash (practically never happens).
 */
/** Number of subpages (viewable docs/collections) a folder share exposes — same subtree rule as the public routes. */
async function folderExposedCount(folderId: string, workspaceId: string): Promise<number> {
  const list = await loadSharedSubtree(folderId, workspaceId)
  return list.filter((p) => p.kind === 'doc' || p.kind === 'collection').length
}

async function generateUniqueShareToken(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBytes(16).toString('base64url')
    const clash = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.shareToken, token))
      .limit(1)
    if (clash.length === 0) return token
  }
  return randomBytes(16).toString('base64url')
}

/** Max pages a single duplicate may create (runaway/DoS guard — lowered in audit F5) */
const MAX_DUPLICATE_PAGES = 500

/** The 3 default fields of a new kind='collection' page (Status select / Assignee person / Due date) */
function defaultCollectionFields(locale: Locale): CollectionField[] {
  const n = NAMES[locale]
  return [
    {
      id: shortId(),
      name: n.status,
      type: 'select',
      options: [
        { id: shortId(), name: n.todo, color: 'gray' },
        { id: shortId(), name: n.inProgress, color: 'blue' },
        { id: shortId(), name: n.done, color: 'green' },
      ],
    },
    { id: shortId(), name: n.assignee, type: 'person' },
    { id: shortId(), name: n.due, type: 'date' },
  ]
}

/** Used by duplicate: pageColumns + props projection and its row type. */
const treeRowCols = { ...pageColumns, props: pages.props }
type SrcRow = PageRow & { props: unknown }

/**
 * Subtree collection used by duplicate.
 * BFS from rootRow over live (not soft-deleted) descendants visible to me (visibleTo), in
 * topological order (a parent always precedes its children). Guards against cycles/runaway
 * (MAX_DUPLICATE_PAGES).
 */
async function collectSubtree(rootRow: SrcRow, userId: string): Promise<SrcRow[]> {
  const ordered: SrcRow[] = [rootRow]
  const seen = new Set<string>([rootRow.id])
  let frontier = [rootRow.id]
  while (frontier.length > 0) {
    const children = (await db
      .select(treeRowCols)
      .from(pages)
      .where(
        and(
          inArray(pages.parentId, frontier),
          isNull(pages.deletedAt),
          visibleTo(userId),
        ),
      )
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))) as SrcRow[]
    const next: string[] = []
    for (const c of children) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      ordered.push(c)
      next.push(c.id)
    }
    if (ordered.length > MAX_DUPLICATE_PAGES) {
      throw badRequest('Too many subpages to duplicate')
    }
    frontier = next
  }
  return ordered
}

/** Height of a subtree collected by collectSubtree (0 = root only). */
function orderedHeight(ordered: SrcRow[]): number {
  const depth = new Map<string, number>()
  let h = 0
  for (const p of ordered) {
    const d = depth.size === 0 ? 0 : (depth.get(p.parentId as string) ?? 0) + 1
    depth.set(p.id, d)
    if (d > h) h = d
  }
  return h
}

/** Postgres uuid[] literal for ids we generated or validated (uuid charset only). */
function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

type CopyTable = 'page_docs' | 'page_texts' | 'page_tags'

/**
 * Copies per-page rows of `tables` from old ids to new ids entirely inside Postgres
 * (INSERT … SELECT joined to an unnest'ed id map). Large bytea/text never reach Node.
 */
async function copySubtreeRows(
  tx: Pick<typeof db, 'execute'>,
  idMap: Map<string, string>,
  tables: CopyTable[],
): Promise<void> {
  if (idMap.size === 0) return
  const olds = uuidArray([...idMap.keys()])
  const news = uuidArray([...idMap.values()])
  const m = sql`unnest(${olds}::uuid[], ${news}::uuid[]) AS m(old_id, new_id)`
  for (const t of tables) {
    if (t === 'page_docs') {
      await tx.execute(sql`INSERT INTO page_docs (page_id, state)
        SELECT m.new_id, d.state FROM ${m} JOIN page_docs d ON d.page_id = m.old_id`)
    } else if (t === 'page_texts') {
      await tx.execute(sql`INSERT INTO page_texts (page_id, text)
        SELECT m.new_id, x.text FROM ${m} JOIN page_texts x ON x.page_id = m.old_id`)
    } else {
      await tx.execute(sql`INSERT INTO page_tags (page_id, tag)
        SELECT m.new_id, g.tag FROM ${m} JOIN page_tags g ON g.page_id = m.old_id
        ON CONFLICT DO NOTHING`)
    }
  }
}

export async function registerPageRoutes(app: FastifyInstance): Promise<void> {
  // Pages of a workspace (soft-deleted excluded)
  app.get('/workspaces/:id/pages', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireMembership(workspaceId, user.id)
    // Tree depends only on this workspace's pages rows (ADR 0752): answer 304 before the query.
    if (precheckEtag(req, reply, [user.id, await workspaceVersion(workspaceId)])) return reply

    const rows = await db
      .select(pageColumns)
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          isNull(pages.deletedAt),
          visibleTo(user.id),
        ),
      )
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))

    return { pages: rows.map(toPageDTO) }
  })

  // Create a page (optional kind/title)
  app.post('/pages', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const body = createPageSchema.parse(req.body)
    const role = await requireMembership(body.workspaceId, user.id)

    const parentId = body.parentId ?? null
    // scope: with a parent, the parent's scope is forced (body.scope ignored); at the root, body.scope (default shared)
    if (parentId) {
      const parent = await findVisiblePage(parentId, user.id)
      if (!parent || parent.workspaceId !== body.workspaceId) {
        throw badRequest('Parent page is invalid')
      }
    }
    const kind = body.kind ?? 'doc'
    // Default names (date property, collection fields/view) in the creator's locale — looked up only when used.
    const locale: Locale = kind === 'collection' || (body.date && kind === 'doc') ? await requestLocale(req, user.id) : 'en'
    const names = NAMES[locale]

    // Creation under a parent is a tree change (docs/adr/0800-*): the parent must still be live,
    // within the depth cap and not inside a public folder the actor may not publish into — all
    // checked under the workspace tree lock so a concurrent delete/move cannot slip in between.
    const row = await withTreeLock(body.workspaceId, async (tx) => {
      let scope: PageScope = body.scope ?? 'shared'
      if (parentId) {
        const chain = await assertPlacement(tx, {
          workspaceId: body.workspaceId,
          parentId,
          role,
        })
        scope = chain[0].scope
      }
      const parentCond = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId)
      const [{ maxSort }] = await tx
        .select({ maxSort: max(pages.sortOrder) })
        .from(pages)
        .where(and(eq(pages.workspaceId, body.workspaceId), parentCond))
      const sortOrder = (maxSort ?? 0) + 1000
      const insertValues = {
        workspaceId: body.workspaceId,
        parentId,
        kind,
        scope,
        title: body.title ?? '',
        sortOrder,
        createdBy: user.id,
        // Global calendar "new page on this date" — a date property shaped like a template's withDate.
        ...(body.date && kind === 'doc'
          ? { properties: [{ id: 'date', name: names.date, type: 'date', value: body.date }] }
          : {}),
      }
      const [page] = await tx.insert(pages).values(insertValues).returning(pageColumns)
      // A collection page gets its scaffolding (default fields + a default table view) in the same transaction
      if (kind === 'collection') {
        await tx.insert(collections).values({ pageId: page.id, fields: defaultCollectionFields(locale) })
        await tx.insert(collectionViews).values({
          pageId: page.id,
          name: names.tableView,
          type: 'table',
          config: {},
          sortOrder: 1000,
        })
      }
      return page
    })

    // Workspace webhooks: new pages in the shared section only (re-checked at delivery).
    if (row.scope === 'shared') {
      emitWebhookEvent({ type: 'page_created', workspaceId: body.workspaceId, pageId: row.id, actorId: user.id })
    }
    return { page: toPageDTO(row) }
  })

  // Update a page (title/icon/parent/order/section move)
  //  One transaction: the page row is locked FOR UPDATE so concurrent property edits (fullWidth,
  //  date, done) merge instead of overwriting each other (A-M5), and parent/scope changes run
  //  under the workspace tree lock with a single ancestor walk (docs/adr/0800-*).
  app.patch('/pages/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = updatePageSchema.parse(req.body)

    const visible = await findVisiblePage(id, user.id)
    if (!visible) throw notFound()
    const role = await requireMembership(visible.workspaceId, user.id)
    const treeChange = body.parentId !== undefined || body.scope !== undefined
    // Names of properties this request may add (fullWidth / date / done), in the editor's locale.
    // Resolved before the transaction so the row lock is not held across the lookup.
    const addsProperty =
      body.fullWidth === true || (body.dateProperty !== undefined && body.dateProperty.value !== null) || body.done === true
    const names = NAMES[addsProperty ? await requestLocale(req, user.id) : 'en']

    const { row, privatized } = await db.transaction(async (tx) => {
      if (treeChange) await lockTree(tx, visible.workspaceId)
      const [page] = await tx
        .select({ ...pageColumns, properties: pages.properties })
        .from(pages)
        .where(and(eq(pages.id, id), isNull(pages.deletedAt), visibleTo(user.id)))
        .limit(1)
        .for('update')
      if (!page) throw notFound()

      const updates: Partial<typeof pages.$inferInsert> = { updatedAt: new Date() }

      if (body.title !== undefined) updates.title = body.title
      if (body.icon !== undefined) updates.icon = body.icon
      if (body.coverUrl !== undefined) updates.coverUrl = body.coverUrl
      if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder
      // Aliases (alternate names for [[alias]] wikilinks): trim, drop empties, dedupe (case-insensitive, first spelling wins).
      if (body.aliases !== undefined) {
        const seen = new Set<string>()
        const cleaned: string[] = []
        for (const raw of body.aliases) {
          const trimmed = raw.trim()
          if (!trimmed) continue
          const key = trimmed.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          cleaned.push(trimmed)
        }
        updates.aliases = cleaned
      }

      // Partial properties update — applied on the locked row's current value in the order fullWidth → date → done.
      let props: PageProperty[] | null = null
      const baseProps = (): PageProperty[] =>
        props ?? (Array.isArray(page.properties) ? (page.properties as PageProperty[]) : [])
      // Full width (M13) — true adds/keeps a checkbox property, false removes it.
      if (body.fullWidth !== undefined) {
        const rest = baseProps().filter((p) => p?.id !== 'fullWidth')
        props = body.fullWidth
          ? [...rest, { id: 'fullWidth', name: names.fullWidth, type: 'checkbox', value: true }]
          : rest
      }
      // Update one date property (global calendar drag) — other properties are kept.
      if (body.dateProperty !== undefined) {
        const base = baseProps()
        const propId = body.dateProperty.id ?? 'date'
        const value = body.dateProperty.value
        const idx = base.findIndex((p) => p?.id === propId)
        if (value === null) {
          props = base.filter((p) => p?.id !== propId)
        } else if (idx >= 0) {
          if (base[idx].type !== 'date') throw badRequest('Not a date property')
          props = base.map((p, i) => (i === idx ? { ...p, value } : p))
        } else {
          props = [...base, { id: propId, name: names.date, type: 'date', value }]
        }
      }
      // Done mark (checked in the Due view) — the 'done' checkbox property.
      if (body.done !== undefined) {
        const rest = baseProps().filter((p) => p?.id !== 'done')
        props = body.done
          ? [...rest, { id: 'done', name: names.done, type: 'checkbox', value: true }]
          : rest
      }
      if (props) updates.properties = props

      // ── Section (scope) computation ──────────────────────────────────
      const scopeChanging = body.scope !== undefined && body.scope !== page.scope
      const finalScope: PageScope = body.scope ?? page.scope

      // Parent change checks: cycle, depth, trash and public-folder rules, all at once under the tree lock.
      let newParentScope: PageScope | null = null
      if (body.parentId !== undefined) {
        const newParentId = body.parentId
        if (newParentId === null) {
          updates.parentId = null
        } else {
          if (newParentId === id) throw badRequest('A page cannot be its own parent')
          const [vp] = await tx
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.id, newParentId), isNull(pages.deletedAt), visibleTo(user.id)))
            .limit(1)
          if (!vp) throw badRequest('Parent page is invalid')
          const chain = await assertPlacement(tx, {
            workspaceId: page.workspaceId,
            parentId: newParentId,
            movingId: id,
            role,
          })
          newParentScope = chain[0].scope
          updates.parentId = newParentId
        }
      }

      // The scope of the final parent must equal finalScope (child = parent scope invariant).
      //  - new parent given: new parent's scope === finalScope (a parentId-only move is caught here too)
      //  - parent unchanged + scope changed: existing parent's scope (= page.scope) !== finalScope → 400
      const finalParentId = body.parentId !== undefined ? body.parentId : page.parentId
      if (finalParentId !== null) {
        const parentScope: PageScope = newParentScope ?? page.scope
        if (parentScope !== finalScope) {
          throw badRequest("The parent page's section (shared/private) does not match")
        }
      }

      // ── Apply the scope change: page + all descendants in one recursive CTE ──
      let privatized: string[] = []
      if (scopeChanging) {
        if (finalScope === 'private') {
          // shared → private: the whole subtree must be mine (or ownerless) so others' pages cannot be made private.
          const subtree = (await tx.execute(sql`
            ${descendantsCte(id)}
            SELECT p.id, p.created_by FROM pages p JOIN descendants d ON d.id = p.id
          `)) as unknown as { id: string; created_by: string | null }[]
          const foreign = subtree.filter(
            (r) => r.created_by !== null && r.created_by !== user.id,
          )
          // 403 if the target page itself is someone else's (no privatizing), 400 if such pages are among its descendants.
          if (foreign.some((r) => r.id === id)) {
            throw forbidden("You can't move a page another member created to Private")
          }
          if (foreign.length > 0) {
            throw badRequest("Can't move to Private: it contains subpages other members created")
          }
        }
        // private → shared: the locked row passed visibleTo, so only the author gets here.

        // Ownerless pages (author deleted) are claimed by the mover when they become private:
        // an ownerless private page is visible to nobody (pageDto.visibleTo).
        const changed = (await tx.execute(sql`
          ${descendantsCte(id)}
          UPDATE pages SET scope = ${finalScope}, updated_at = now(),
                 created_by = CASE WHEN ${finalScope} = 'private'
                                   THEN coalesce(created_by, ${user.id}::uuid) ELSE created_by END
          WHERE id IN (SELECT id FROM descendants)
          RETURNING id
        `)) as unknown as { id: string }[]
        if (finalScope === 'private') privatized = changed.map((r) => r.id)
      }

      const [row] = await tx
        .update(pages)
        .set(updates)
        .where(eq(pages.id, id))
        .returning(pageColumns)
      return { row, privatized }
    })

    // Live collab sockets of members who just lost sight of the subtree (docs/adr/0754-*).
    if (privatized.length) await closeConnectionsLosingPrivateAccess(privatized)
    return { page: toPageDTO(row) }
  })

  // Delete a page (soft delete of the page and all descendants)
  app.delete('/pages/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    await withTreeLock(page.workspaceId, (tx) =>
      tx.execute(sql`
        ${descendantsCte(id)}
        UPDATE pages
        SET deleted_at = now()
        WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL
      `),
    )

    return reply.code(204).send()
  })

  // ── Public web sharing (M15) ─────────────────────────────────────
  // Only owners (workspace owner) can turn a public link on/off. Private pages cannot be shared.
  // One token per page (idempotent) — an existing one is reused.
  app.post('/pages/:id/share', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)
    if (role !== 'owner') throw forbidden('Only owners can publish pages')
    if (page.scope === 'private') throw badRequest("Private pages can't be shared")

    const current = (
      await db
        .select({ shareToken: pages.shareToken })
        .from(pages)
        .where(eq(pages.id, id))
        .limit(1)
    )[0]
    let token = current?.shareToken ?? null
    if (!token) {
      token = await generateUniqueShareToken()
      await db.update(pages).set({ shareToken: token }).where(eq(pages.id, id))
    }

    const dto: ShareStatusDTO = { shared: true, token }
    if (page.kind === 'folder') dto.exposedCount = await folderExposedCount(page.id, page.workspaceId)
    return dto
  })

  // Stop sharing (owner) — removes the token; existing links stop working at once (404).
  app.delete('/pages/:id/share', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)
    if (role !== 'owner') throw forbidden('Only owners can stop sharing')

    await db.update(pages).set({ shareToken: null }).where(eq(pages.id, id))

    const dto: ShareStatusDTO = { shared: false, token: null }
    return dto
  })

  // Current share status (members) — the token is shown only to members of that workspace.
  app.get('/pages/:id/share', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const current = (
      await db
        .select({ shareToken: pages.shareToken })
        .from(pages)
        .where(eq(pages.id, id))
        .limit(1)
    )[0]
    const token = current?.shareToken ?? null

    const dto: ShareStatusDTO = { shared: Boolean(token), token }
    // For folders, also return the number of viewable subpages that are (or would be, if published) exposed.
    if (page.kind === 'folder') dto.exposedCount = await folderExposedCount(page.id, page.workspaceId)
    return dto
  })

  // A workspace's web shares (members) — for the sidebar "Web shares" screen.
  // Only live pages visible to me that have a shareToken. Folders include their currently exposed subpage count.
  // canManage = may stop sharing (owner) — same rule as the per-page share routes.
  app.get('/workspaces/:id/shared', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const wsId = idParam(req.params)
    const role = await requireMembership(wsId, user.id)

    const rows = await db
      .select({
        id: pages.id,
        title: pages.title,
        icon: pages.icon,
        kind: pages.kind,
        parentId: pages.parentId,
        shareToken: pages.shareToken,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, wsId),
          isNull(pages.deletedAt),
          sql`${pages.shareToken} IS NOT NULL`,
          visibleTo(user.id),
        ),
      )
      .orderBy(asc(pages.title))

    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        kind: r.kind,
        parentId: r.parentId,
        token: r.shareToken as string,
        updatedAt: r.updatedAt.toISOString(),
        exposedCount: r.kind === 'folder' ? await folderExposedCount(r.id, wsId) : undefined,
      })),
    )
    return { canManage: role === 'owner', items }
  })

  // Backlinks: live pages that link to this (target) page
  app.get('/pages/:id/backlinks', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    // The target page must be visible to me (404 otherwise),
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    // and only source pages visible to me are listed (hidden even if someone's private page links here).
    const rows = await db
      .select(pageColumns)
      .from(pageLinks)
      .innerJoin(pages, eq(pages.id, pageLinks.sourcePageId))
      .where(
        and(
          eq(pageLinks.targetPageId, id),
          isNull(pages.deletedAt),
          visibleTo(user.id),
        ),
      )
      .orderBy(desc(pages.updatedAt))

    return { pages: rows.map(toPageDTO) }
  })

  // Unlinked mentions: visible pages whose text mentions the target's title/aliases (page_texts ILIKE)
  // but that have no wikilink (page_links) to this page yet.
  //  - excludes the page itself, updatedAt desc, limit 30.
  //  - terms are trimmed and must be 2+ characters (1-character titles/aliases are noise), lowercase dedupe.
  //  - no terms to match → empty list.
  app.get('/pages/:id/unlinked', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const aliases = Array.isArray(page.aliases) ? (page.aliases as unknown[]) : []
    const seen = new Set<string>()
    const terms: string[] = []
    for (const raw of [page.title, ...aliases]) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (trimmed.length < 2) continue // noise guard: skip too-short terms
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(trimmed)
    }
    if (terms.length === 0) return { pages: [] }

    const patterns = terms.map((t) => ilike(pageTexts.text, `%${escapeLike(t)}%`))
    const textMatch = patterns.length === 1 ? patterns[0] : or(...patterns)
    // Probe page_texts through the trigram index first (94 ms → 1.1 ms on 5k pages, ADR 0755).
    const textIds = sql`${pages.id} IN (SELECT ${pageTexts.pageId} FROM ${pageTexts} WHERE ${textMatch})`

    // Exclude candidates that already link to the target (page_links (source, thisId)).
    const alreadyLinked = notExists(
      db
        .select({ one: sql<number>`1` })
        .from(pageLinks)
        .where(
          and(
            eq(pageLinks.sourcePageId, pages.id),
            eq(pageLinks.targetPageId, id),
          ),
        ),
    )

    const rows = await withSsdPlanCosts((tx) =>
      tx
        .select(pageColumns)
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, page.workspaceId),
            isNull(pages.deletedAt),
            visibleTo(user.id),
            ne(pages.id, id), // exclude the page itself
            textIds,
            alreadyLinked,
          ),
        )
        .orderBy(desc(pages.updatedAt))
        .limit(30),
    )

    return { pages: rows.map(toPageDTO) }
  })

  // Restore: the page + descendants get deleted_at=null. If the parent is still deleted, move to the root.
  //  One transaction under the tree lock; the UPDATE only touches rows that are still deleted, so a
  //  concurrent purge either ran first (404) or waits and finds nothing to purge (A-M11).
  app.post('/pages/:id/restore', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const target = (
      await db
        .select({ workspaceId: pages.workspaceId })
        .from(pages)
        .where(and(eq(pages.id, id), visibleTo(user.id)))
        .limit(1)
    )[0]
    if (!target) throw notFound()
    await requireMembership(target.workspaceId, user.id)

    const row = await withTreeLock(target.workspaceId, async (tx) => {
      const [cur] = await tx
        .select({ parentId: pages.parentId, deletedAt: pages.deletedAt })
        .from(pages)
        .where(and(eq(pages.id, id), visibleTo(user.id)))
        .limit(1)
      if (!cur) throw notFound()
      if (!cur.deletedAt) throw badRequest('This page is not deleted')

      await tx.execute(sql`
        ${descendantsCte(id, { onlyDeleted: true })}
        UPDATE pages
        SET deleted_at = NULL
        WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NOT NULL
        RETURNING id
      `)

      // Promote to the root when the parent is gone or still deleted
      if (cur.parentId) {
        const [parent] = await tx
          .select({ deletedAt: pages.deletedAt })
          .from(pages)
          .where(eq(pages.id, cur.parentId))
          .limit(1)
        if (!parent || parent.deletedAt) {
          await tx.update(pages).set({ parentId: null }).where(eq(pages.id, id))
        }
      }
      const [r] = await tx.select(pageColumns).from(pages).where(eq(pages.id, id)).limit(1)
      return r
    })
    return { page: toPageDTO(row) }
  })

  // Delete forever: trashed (deleted) pages only. Hard delete of the page + descendants (cascade).
  app.delete('/pages/:id/purge', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const target = (
      await db
        .select({ workspaceId: pages.workspaceId })
        .from(pages)
        .where(and(eq(pages.id, id), visibleTo(user.id)))
        .limit(1)
    )[0]
    if (!target) throw notFound()
    await requireMembership(target.workspaceId, user.id)

    const fileIds = await withTreeLock(target.workspaceId, async (tx) => {
      const [cur] = await tx
        .select({ deletedAt: pages.deletedAt })
        .from(pages)
        .where(eq(pages.id, id))
        .limit(1)
      if (!cur) throw notFound()
      if (!cur.deletedAt) {
        throw badRequest('Only pages in the trash can be deleted forever')
      }
      return (await purgeDeletedSubtrees(tx, [id])).fileIds
    })

    // Clean up attachment rows + blobs on disk (best-effort, failures isolated)
    if (fileIds.length > 0) {
      try {
        await db.delete(files).where(inArray(files.id, fileIds))
      } catch (err) {
        req.log.error({ err }, '[inkling] purge: failed to delete attachment rows')
      }
      for (const fid of fileIds) {
        try {
          await unlink(path.join(env.dataDir, 'uploads', fid))
        } catch {
          // already gone or could not delete — ignore (best-effort)
        }
      }
    }

    return reply.code(204).send()
  })

  // Duplicate a page (template) — recursively copies the target + its descendant tree.
  //  - root: same parentId and scope, title "Copy of …" (creator's locale), sortOrder = siblings' max + 1000.
  //  - descendants: under the new parent (the copy), keeping relative structure/sortOrder/scope.
  //  - copies page_docs.state / props / kind / icon / page_texts; for collections also fields and views.
  //  - wikilink hrefs are not rewritten in v1 (they keep pointing at the original pages).
  app.post(
    '/pages/:id/duplicate',
    {
      preHandler: requireUser,
      // Hardening H5: curb amplification abuse via mass tree copies — 20/min per IP for authenticated members.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    // Visibility guard (404 if not visible). The data is re-read below, including props.
    const guard = await findVisiblePage(id, user.id)
    if (!guard) throw notFound()
    const role = await requireMembership(guard.workspaceId, user.id)

    const [rootRow] = (await db
      .select(treeRowCols)
      .from(pages)
      .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
      .limit(1)) as SrcRow[]
    if (!rootRow) throw notFound()

    // Collect descendants (BFS → topological order, parents always before children). Cycle/runaway guard.
    // Audit F1: visibleTo keeps others' private pages inside the subtree from leaking (inside collectSubtree).
    const ordered = await collectSubtree(rootRow, user.id)

    // old id → new id map
    const idMap = new Map<string, string>()
    for (const p of ordered) idMap.set(p.id, randomUUID())

    // root sortOrder = max among siblings + 1000
    const siblingCond = rootRow.parentId
      ? eq(pages.parentId, rootRow.parentId)
      : isNull(pages.parentId)
    const [{ maxSort }] = await db
      .select({ maxSort: max(pages.sortOrder) })
      .from(pages)
      .where(and(eq(pages.workspaceId, rootRow.workspaceId), siblingCond))
    const rootSortOrder = (maxSort ?? 0) + 1000
    const rootTitle = NAMES[await requestLocale(req, user.id)].copyOf(rootRow.title)

    const pageInserts = ordered.map((p) => {
      const isRoot = p.id === rootRow.id
      return {
        id: idMap.get(p.id)!,
        workspaceId: rootRow.workspaceId,
        // The root keeps its original parent (an existing page); descendants go under their copied parents.
        parentId: isRoot ? rootRow.parentId : idMap.get(p.parentId as string)!,
        kind: p.kind,
        scope: p.scope,
        title: isRoot ? rootTitle : p.title,
        props: p.props,
        icon: p.icon,
        sortOrder: isRoot ? rootSortOrder : p.sortOrder,
        createdBy: user.id,
      }
    })

    const oldIds = ordered.map((p) => p.id)

    const result = await withTreeLock(rootRow.workspaceId, async (tx) => {
      // The copy lands next to the original: its parent must still be live (tree lock, ADR 0800).
      if (rootRow.parentId) {
        await assertPlacement(tx, {
          workspaceId: rootRow.workspaceId,
          parentId: rootRow.parentId,
          role,
          height: orderedHeight(ordered),
          publicRule: false,
        })
      }
      // 1) Insert pages first (satisfies child-table FKs). FKs are checked at statement end, so a
      //    child referencing its parent within one multi-row VALUES is safe; BFS order is kept anyway.
      const inserted = await tx.insert(pages).values(pageInserts).returning(pageColumns)

      // 2) page_docs.state + 3) page_texts — copied inside Postgres (INSERT … SELECT over
      //    an old→new id map), so Yjs states / search text of the whole subtree never pass
      //    through Node memory (docs/adr/0751-*).
      await copySubtreeRows(tx, idMap, ['page_docs', 'page_texts'])

      // 4) copy collections (fields)
      const cols = await tx
        .select({ pageId: collections.pageId, fields: collections.fields })
        .from(collections)
        .where(inArray(collections.pageId, oldIds))
      if (cols.length > 0) {
        await tx
          .insert(collections)
          .values(cols.map((c) => ({ pageId: idMap.get(c.pageId)!, fields: c.fields })))
      }

      // 5) copy collection_views (new view ids)
      const views = await tx
        .select({
          pageId: collectionViews.pageId,
          name: collectionViews.name,
          type: collectionViews.type,
          config: collectionViews.config,
          sortOrder: collectionViews.sortOrder,
        })
        .from(collectionViews)
        .where(inArray(collectionViews.pageId, oldIds))
      if (views.length > 0) {
        await tx.insert(collectionViews).values(
          views.map((v) => ({
            pageId: idMap.get(v.pageId)!,
            name: v.name,
            type: v.type,
            config: v.config,
            sortOrder: v.sortOrder,
          })),
        )
      }

      // Response: root first, then descendants (BFS order). returning order is not guaranteed, so map by id.
      const byId = new Map(inserted.map((r) => [r.id, r]))
      return ordered.map((p) => toPageDTO(byId.get(idMap.get(p.id)!)!))
    })

    // After commit: task index of the copied docs (best-effort, does not block the response)
    void reindexPageTasksForPages([...idMap.values()])

    return { pages: result }
  })

  // Expand to canvas (M13) — analyzes a doc page's block structure and creates a new ontology map (canvas).
  //  - creates a "<original title> — map" canvas page (creator's locale) under the same parent/scope (original untouched).
  //  - nodes/edges are encoded into a new Y.Doc (cnodes/cedges) and stored straight into page_docs.state
  //    (a brand-new document nobody has open, so no need to go through collab — same pattern as duplicate).
  app.post(
    '/pages/:id/expand-canvas',
    {
      preHandler: requireUser,
      // Curb document-conversion amplification — 20/min per IP for authenticated members (same as duplicate).
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      const role = await requireMembership(page.workspaceId, user.id)
      if (page.kind !== 'doc') {
        throw badRequest('Only document pages can be expanded to a canvas')
      }

      // Source doc state → blocks (no doc → empty body = root node only)
      const cur = (
        await db
          .select({ state: pageDocs.state })
          .from(pageDocs)
          .where(eq(pageDocs.pageId, id))
          .limit(1)
      )[0]
      let blocks: AnyBlock[] = []
      if (cur) {
        try {
          blocks = stateToBlocks(cur.state)
        } catch (err) {
          req.log.error({ err, pageId: id }, '[inkling] expand to canvas: document conversion failed')
          blocks = []
        }
      }

      const names = NAMES[await requestLocale(req, user.id)]
      const rootTitle = page.title || names.untitled
      // Encode outside the transaction first — so a failure creates no page.
      const state = blocksToCanvasState(rootTitle, blocks)

      // sortOrder = max among siblings under the same parent + 1000
      const parentCond = page.parentId
        ? eq(pages.parentId, page.parentId)
        : isNull(pages.parentId)
      const [{ maxSort }] = await db
        .select({ maxSort: max(pages.sortOrder) })
        .from(pages)
        .where(and(eq(pages.workspaceId, page.workspaceId), parentCond))
      const sortOrder = (maxSort ?? 0) + 1000

      const row = await withTreeLock(page.workspaceId, async (tx) => {
        if (page.parentId) {
          await assertPlacement(tx, {
            workspaceId: page.workspaceId,
            parentId: page.parentId,
            role,
            publicRule: false,
          })
        }
        const [created] = await tx
          .insert(pages)
          .values({
            workspaceId: page.workspaceId,
            parentId: page.parentId,
            kind: 'canvas',
            scope: page.scope, // same scope as the parent/original (keeps the child = parent invariant)
            title: names.mapOf(rootTitle),
            sortOrder,
            createdBy: user.id,
          })
          .returning(pageColumns)
        await tx.insert(pageDocs).values({ pageId: created.id, state })
        return created
      })

      return { page: toPageDTO(row) }
    },
  )
}
