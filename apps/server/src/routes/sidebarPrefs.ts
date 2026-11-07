import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DEFAULT_SIDEBAR_PREFS, sidebarPrefsSchema } from '@inkling/shared'
import type { SidebarPrefsDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { users } from '../db/schema'
import { forbidden } from '../errors'

/**
 * Sidebar menu order and hidden menus, per user (docs/adr/1020-*).
 *
 *   GET /api/me/sidebar   → SidebarPrefsDTO ({ order: [], hidden: [] } when never customized)
 *   PUT /api/me/sidebar   { order, hidden } → the stored value; both empty = back to the default (NULL)
 *
 * Browser sessions only: this is how the web app looks, nothing an agent needs to read or change.
 * The same value also rides on GET /auth/me (`user.sidebar`) so the sidebar paints in the saved
 * order on the first frame.
 */
async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Sidebar settings are only available in the web app')
}

/** Normalizes the stored jsonb (NULL or a hand-edited row) to a DTO. */
export function toSidebarPrefsDTO(raw: unknown): SidebarPrefsDTO {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SIDEBAR_PREFS }
  const parsed = sidebarPrefsSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...DEFAULT_SIDEBAR_PREFS }
}

export async function loadSidebarPrefs(userId: string): Promise<SidebarPrefsDTO> {
  const [row] = await db.select({ prefs: users.sidebarPrefs }).from(users).where(eq(users.id, userId)).limit(1)
  return toSidebarPrefsDTO(row?.prefs)
}

export async function registerSidebarPrefsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/sidebar', { preHandler: requireSessionUser }, async (req) => {
    return loadSidebarPrefs(getUser(req).id)
  })

  app.put('/me/sidebar', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const next = sidebarPrefsSchema.parse(req.body)
    const isDefault = next.order.length === 0 && next.hidden.length === 0
    await db
      .update(users)
      .set({ sidebarPrefs: isDefault ? null : next })
      .where(eq(users.id, user.id))
    const dto: SidebarPrefsDTO = next
    return dto
  })
}
