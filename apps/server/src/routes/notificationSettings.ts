import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  setPageSubscriptionSchema,
  setWorkspaceNotificationLevelSchema,
  updateNotificationSettingsSchema,
} from '@inkling/shared'
import type {
  EmailDigestMode,
  NotificationLevel,
  NotificationSettingsDTO,
  PageSubscriptionDTO,
  SubscriptionDTO,
} from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { mailEnabled } from '../env'
import { forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'

/**
 * Notification settings and subscriptions (docs/adr/1001-*, 1004-*). Browser sessions only: an
 * agent acting for a person must not be able to silence that person's notifications.
 */
async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Notification settings are only available in the web app')
}

const MAX_SUBSCRIPTIONS = 500

async function loadSettings(userId: string): Promise<{ emailInstant: boolean; emailDigest: EmailDigestMode }> {
  const rows = (await db.execute(sql`
    SELECT email_instant AS "emailInstant", email_digest AS "emailDigest" FROM user_notification_settings WHERE user_id = ${userId}
  `)) as unknown as { emailInstant: boolean; emailDigest: EmailDigestMode }[]
  return rows[0] ?? { emailInstant: true, emailDigest: 'daily' }
}

async function listSubscriptions(userId: string): Promise<SubscriptionDTO[]> {
  const rows = (await db.execute(sql`
    SELECT np.workspace_id AS "workspaceId", w.name AS "workspaceName", np.root_page_id AS "rootPageId",
           p.title AS "rootTitle", np.level, np.subtree, np.agent_digest AS "agentDigest", np.updated_at AS "updatedAt"
      FROM notification_prefs np
      JOIN workspaces w ON w.id = np.workspace_id
      JOIN workspace_members m ON m.workspace_id = np.workspace_id AND m.user_id = np.user_id
      LEFT JOIN pages p ON p.id = np.root_page_id
     WHERE np.user_id = ${userId} AND ${liveWorkspace(sql`np.workspace_id`)}
       AND (np.root_page_id IS NULL OR (p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${userId})))
     ORDER BY w.name, np.root_page_id NULLS FIRST, p.title
     LIMIT ${MAX_SUBSCRIPTIONS}
  `)) as unknown as (Omit<SubscriptionDTO, 'updatedAt'> & { updatedAt: Date | string })[]
  return rows.map((r) => ({
    ...r,
    rootTitle: r.rootPageId ? (r.rootTitle ?? '') : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }))
}

/** My row on the page and what applies there (nearest row wins). */
export async function pageSubscription(userId: string, pageId: string, workspaceId: string): Promise<PageSubscriptionDTO> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, title, 0 AS depth FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, p.title, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
    )
    SELECT np.root_page_id AS "rootPageId", np.level, np.subtree, np.agent_digest AS "agentDigest",
           up.depth, up.title
      FROM notification_prefs np LEFT JOIN up ON up.id = np.root_page_id
     WHERE np.user_id = ${userId} AND np.workspace_id = ${workspaceId}
       AND (np.root_page_id IS NULL OR up.id IS NOT NULL)
     ORDER BY CASE WHEN np.root_page_id IS NULL THEN 100000 ELSE up.depth END
  `)) as unknown as {
    rootPageId: string | null
    level: NotificationLevel
    subtree: boolean
    agentDigest: boolean
    depth: number | null
    title: string | null
  }[]
  const own = rows.find((r) => r.rootPageId === pageId) ?? null
  // Rows that cover this page: the page's own row, ancestors' rows with subtree, the workspace row.
  const covering = rows.filter((r) => r.rootPageId === null || r.depth === 0 || r.subtree)
  const nearest = covering[0]
  const [meta] = (await db.execute(sql`
    SELECT created_by AS "createdBy", owner_id AS "ownerId" FROM pages WHERE id = ${pageId}
  `)) as unknown as { createdBy: string | null; ownerId: string | null }[]
  return {
    pageId,
    own: own ? { level: own.level, subtree: own.subtree, agentDigest: own.agentDigest } : null,
    effective: nearest
      ? {
          level: nearest.level,
          source: nearest.rootPageId === null ? 'workspace' : nearest.rootPageId === pageId ? 'page' : 'ancestor',
          fromPageId: nearest.rootPageId,
          fromTitle: nearest.rootPageId ? (nearest.title ?? '') : null,
        }
      : { level: 'mentions', source: 'default', fromPageId: null, fromTitle: null },
    agentDigest: covering.some((r) => r.agentDigest),
    implicit: meta?.createdBy === userId || meta?.ownerId === userId,
  }
}

export async function registerNotificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/notification-settings', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const s = await loadSettings(user.id)
    const dto: NotificationSettingsDTO = { ...s, mailAvailable: mailEnabled, subscriptions: await listSubscriptions(user.id) }
    return dto
  })

  app.patch('/me/notification-settings', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const b = updateNotificationSettingsSchema.parse(req.body)
    const cur = await loadSettings(user.id)
    const next = { emailInstant: b.emailInstant ?? cur.emailInstant, emailDigest: b.emailDigest ?? cur.emailDigest }
    await db.execute(sql`
      INSERT INTO user_notification_settings (user_id, email_instant, email_digest, updated_at)
      VALUES (${user.id}, ${next.emailInstant}, ${next.emailDigest}, now())
      ON CONFLICT (user_id) DO UPDATE SET email_instant = EXCLUDED.email_instant, email_digest = EXCLUDED.email_digest, updated_at = now()
    `)
    // Turning a channel off drops what was waiting for it.
    if (!next.emailInstant) {
      await db.execute(sql`
        UPDATE notifications SET mail_state = ${next.emailDigest === 'off' ? null : 'digest'}
         WHERE user_id = ${user.id} AND mail_state = 'instant'
      `)
    }
    if (next.emailDigest === 'off') {
      await db.execute(sql`UPDATE notifications SET mail_state = NULL WHERE user_id = ${user.id} AND mail_state = 'digest'`)
    }
    const dto: NotificationSettingsDTO = { ...next, mailAvailable: mailEnabled, subscriptions: await listSubscriptions(user.id) }
    return dto
  })

  app.get('/pages/:id/subscription', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    return pageSubscription(user.id, id, page.workspaceId)
  })

  app.put('/pages/:id/subscription', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    const b = setPageSubscriptionSchema.parse(req.body)
    if (b.level === null) {
      await db.execute(sql`DELETE FROM notification_prefs WHERE user_id = ${user.id} AND root_page_id = ${id}`)
    } else {
      await db.execute(sql`
        INSERT INTO notification_prefs (user_id, workspace_id, root_page_id, level, subtree, agent_digest, updated_at)
        VALUES (${user.id}, ${page.workspaceId}, ${id}, ${b.level}, ${b.subtree ?? true}, ${b.agentDigest ?? false}, now())
        ON CONFLICT (user_id, workspace_id, root_page_id) DO UPDATE SET
          level = EXCLUDED.level,
          subtree = ${b.subtree === undefined ? sql`notification_prefs.subtree` : sql`EXCLUDED.subtree`},
          agent_digest = ${b.agentDigest === undefined ? sql`notification_prefs.agent_digest` : sql`EXCLUDED.agent_digest`},
          updated_at = now()
      `)
    }
    return pageSubscription(user.id, id, page.workspaceId)
  })

  app.get('/workspaces/:id/notification-level', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const rows = (await db.execute(sql`
      SELECT level, agent_digest AS "agentDigest" FROM notification_prefs
       WHERE user_id = ${user.id} AND workspace_id = ${id} AND root_page_id IS NULL
    `)) as unknown as { level: NotificationLevel; agentDigest: boolean }[]
    return { level: rows[0]?.level ?? 'mentions', agentDigest: rows[0]?.agentDigest ?? false, isDefault: !rows[0] }
  })

  app.put('/workspaces/:id/notification-level', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const b = setWorkspaceNotificationLevelSchema.parse(req.body)
    const agentDigest = b.agentDigest ?? false
    if (b.level === 'mentions' && !agentDigest) {
      // Back to the default: no row.
      await db.execute(sql`DELETE FROM notification_prefs WHERE user_id = ${user.id} AND workspace_id = ${id} AND root_page_id IS NULL`)
    } else {
      await db.execute(sql`
        INSERT INTO notification_prefs (user_id, workspace_id, root_page_id, level, subtree, agent_digest, updated_at)
        VALUES (${user.id}, ${id}, NULL, ${b.level}, true, ${agentDigest}, now())
        ON CONFLICT (user_id, workspace_id, root_page_id) DO UPDATE SET level = EXCLUDED.level, agent_digest = EXCLUDED.agent_digest, updated_at = now()
      `)
    }
    return { level: b.level, agentDigest, isDefault: b.level === 'mentions' && !agentDigest }
  })
}
