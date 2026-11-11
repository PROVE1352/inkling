import { assertWorkspaceRoom } from '../quota/room'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { assertPageEditable } from '../editLock'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { quickTaskSchema, updateTaskSchema } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pageTasks, pages } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { markdownToBlocks } from '../md/convert'
import { appendBlocksToDoc } from '../md/docWrite'
import { editTaskInDoc, TaskEditError } from '../md/taskEdit'
import { forgetDocIndex } from '../docIndexer'
import { reindexPageTasks } from '../md/taskIndex'
import { findVisiblePage, visibleTo } from '../pageDto'
import { assertTopLevelInRange } from '../tokenRange'

/**
 * Title of the workspace document that collects quick-added tasks (one per workspace, top level
 * of the shared section). A new one is created in the creator's locale.
 */
const TODO_DOC_TITLE: Record<Locale, string> = { en: 'Tasks', ko: '할 일' }
/**
 * Titles the lookup accepts. Installs from before i18n already have a '할 일' document (legacy
 * Korean title, kept as data); matching every localized title keeps them, and workspaces whose
 * members use different languages, from getting a second Tasks document.
 */
const TODO_DOC_TITLES = [...new Set(Object.values(TODO_DOC_TITLE))]

const blockIdParam = z.object({ id: z.uuid(), blockId: z.string().min(1).max(100) })

/** Escape markdown special characters: a quick-add title must go in literally. */
function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]<>~#|]/g, (c) => `\\${c}`).replace(/\s+/g, ' ')
}

/**
 * Find or create the workspace Tasks document: the oldest live doc at the top level of the shared
 * section titled like TODO_DOC_TITLES. Serialized with a per-workspace advisory lock so concurrent
 * requests do not create two.
 */
async function findOrCreateTodoDoc(workspaceId: string, userId: string, locale: Locale): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'todo-doc:' + workspaceId}))`)
    const found = (
      await tx
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.workspaceId, workspaceId),
            isNull(pages.parentId),
            isNull(pages.deletedAt),
            eq(pages.kind, 'doc'),
            eq(pages.scope, 'shared'),
            inArray(pages.title, TODO_DOC_TITLES),
            visibleTo(userId),
          ),
        )
        .orderBy(asc(pages.createdAt))
        .limit(1)
    )[0]
    if (found) return found.id
    // the to-do document is a top-level page: not for a subtree-limited connection (docs/adr/1202-*)
    assertTopLevelInRange(workspaceId, userId)
    const [{ maxSort }] = await tx
      .select({ maxSort: sql<number | null>`max(${pages.sortOrder})` })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.parentId)))
    await assertWorkspaceRoom(tx, workspaceId, { pages: 1 }) // docs/adr/2505-*
    const [created] = await tx
      .insert(pages)
      .values({
        workspaceId,
        parentId: null,
        kind: 'doc',
        scope: 'shared',
        title: TODO_DOC_TITLE[locale],
        sortOrder: (Number(maxSort) || 0) + 1000,
        createdBy: userId,
      })
      .returning({ id: pages.id })
    return created.id
  })
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  // Edit one task in a document: toggle done / change the date. The document (Yjs) is changed via
  // the safe path, then the store hook reindexes page_tasks (finished before the response).
  // Returns the resulting task row.
  app.patch(
    '/pages/:id/tasks/:blockId',
    { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const { id, blockId } = blockIdParam.parse(req.params)
      const body = updateTaskSchema.parse(req.body)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      await assertPageEditable(id, user.id)
      if (page.kind !== 'doc') throw badRequest('Not a document page')

      try {
        await editTaskInDoc(id, blockId, body)
      } catch (err) {
        if (err instanceof TaskEditError) {
          if (err.code === 'not_found') throw notFound()
          throw badRequest(err.message)
        }
        throw err
      }

      const task = (
        await db
          .select({
            blockId: pageTasks.blockId,
            text: pageTasks.text,
            due: pageTasks.due,
            checked: pageTasks.checked,
          })
          .from(pageTasks)
          .where(and(eq(pageTasks.pageId, id), eq(pageTasks.blockId, blockId)))
          .limit(1)
      )[0]
      return { ok: true, task: task ?? null }
    },
  )

  // Quick-add a task: append `- [ ] title 📅 YYYY-MM-DD` to the end of the workspace Tasks
  // document and reindex page_tasks right away (so it shows on the calendar and due list at once).
  // Existing blocks are not rewritten.
  app.post(
    '/workspaces/:id/tasks',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const wsId = idParam(req.params)
      await requireMembership(wsId, user.id)
      const body = quickTaskSchema.parse(req.body)

      const pageId = await findOrCreateTodoDoc(wsId, user.id, await requestLocale(req, user.id))
      // The workspace Tasks document may be locked like any page (docs/adr/0970-*).
      await assertPageEditable(pageId, user.id)
      const md = `- [ ] ${escapeMd(body.title)} 📅 ${body.date}\n`
      const incoming = await markdownToBlocks(md, () => null)
      if (incoming.length !== 1 || incoming[0].type !== 'checkListItem') {
        throw badRequest('Could not convert the task')
      }
      const blocks = await appendBlocksToDoc(pageId, incoming)
      forgetDocIndex(pageId) // out-of-band rewrite (docs/adr/0750-*)
      await reindexPageTasks(pageId, blocks)

      return { ok: true, pageId, blockId: incoming[0].id ?? null }
    },
  )
}
