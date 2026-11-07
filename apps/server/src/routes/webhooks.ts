import { randomUUID } from 'node:crypto'
import { and, count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import type { WebhookEvent } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import type { AuthUser } from '../auth'
import { db } from '../db/index'
import { workspaces, workspaceWebhooks } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import {
  invalidateWebhookCache,
  maskedHookUrl,
  maskWebhookUrl,
  MAX_WEBHOOKS_PER_WORKSPACE,
  parseWebhookUrl,
  sendTestMessage,
  storeHookUrl,
  toWebhookDTO,
  WebhookUrlError,
} from '../webhooks'
import { recordAudit } from '../workspaceAdmin'

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS as unknown as [WebhookEvent, ...WebhookEvent[]]))
  .max(WEBHOOK_EVENTS.length)
  .transform((a) => [...new Set(a)])

const createSchema = z.object({
  url: z.string().min(1).max(512),
  events: eventsSchema,
  /** Only consulted for loopback URLs in webhook test mode; otherwise inferred from the host. */
  kind: z.enum(['slack', 'discord']).optional(),
})

const updateSchema = z.object({
  events: eventsSchema.optional(),
  enabled: z.boolean().optional(),
})

/** Webhook settings are limited to workspace owners — same rule as the web menu (C-L12). */
async function requireWebhookAdmin(workspaceId: string, user: AuthUser): Promise<void> {
  const role = await requireMembership(workspaceId, user.id)
  if (role !== 'owner') throw forbidden('Only workspace owners can manage webhooks')
}

async function loadHook(id: string, user: AuthUser) {
  const hook = (await db.select().from(workspaceWebhooks).where(eq(workspaceWebhooks.id, id)).limit(1))[0]
  if (!hook) throw notFound()
  await requireWebhookAdmin(hook.workspaceId, user)
  return hook
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workspaces/:id/webhooks', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    await requireWebhookAdmin(workspaceId, user)
    const rows = await db
      .select()
      .from(workspaceWebhooks)
      .where(eq(workspaceWebhooks.workspaceId, workspaceId))
      .orderBy(workspaceWebhooks.createdAt)
    return { webhooks: rows.map(toWebhookDTO) }
  })

  app.post(
    '/workspaces/:id/webhooks',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      await requireWebhookAdmin(workspaceId, user)
      const body = createSchema.parse(req.body)
      let parsed
      try {
        parsed = parseWebhookUrl(body.url, body.kind)
      } catch (e) {
        if (e instanceof WebhookUrlError) throw badRequest(e.message)
        throw e
      }
      const [{ n }] = await db
        .select({ n: count() })
        .from(workspaceWebhooks)
        .where(eq(workspaceWebhooks.workspaceId, workspaceId))
      if (n >= MAX_WEBHOOKS_PER_WORKSPACE) {
        throw new AppError(409, 'LIMIT_REACHED', `At most ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks per workspace`)
      }
      const row = await db.transaction(async (tx) => {
        // The id is chosen here: it is the AAD that binds the sealed URL to this row (docs/adr/1111-*).
        const id = randomUUID()
        const [row] = await tx
          .insert(workspaceWebhooks)
          .values({ id, workspaceId, kind: parsed.kind, url: storeHookUrl(id, parsed.url), events: body.events, createdBy: user.id })
          .returning()
        // the masked URL only: the full URL is a secret (docs/adr/0946-*)
        await recordAudit(tx, {
          workspaceId,
          actor: user,
          action: 'webhook.created',
          target: { type: 'webhook', id: row.id, label: maskWebhookUrl(parsed.url) },
          after: { kind: row.kind, events: body.events },
        })
        return row
      })
      invalidateWebhookCache(workspaceId)
      return { webhook: toWebhookDTO(row) }
    },
  )

  app.patch('/webhooks/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const hook = await loadHook(idParam(req.params), user)
    const body = updateSchema.parse(req.body)
    const set: Partial<typeof workspaceWebhooks.$inferInsert> = {}
    if (body.events) set.events = body.events
    if (body.enabled !== undefined) {
      set.enabled = body.enabled ? '1' : '0'
      // Re-enabling clears the failure streak so the hook gets a fresh budget.
      if (body.enabled) Object.assign(set, { failureCount: 0, autoDisabledAt: null })
    }
    if (Object.keys(set).length === 0) return { webhook: toWebhookDTO(hook) }
    const row = await db.transaction(async (tx) => {
      const [row] = await tx.update(workspaceWebhooks).set(set).where(eq(workspaceWebhooks.id, hook.id)).returning()
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      if (body.events) {
        before.events = hook.events
        after.events = body.events
      }
      if (body.enabled !== undefined) {
        before.enabled = hook.enabled === '1'
        after.enabled = body.enabled
      }
      await recordAudit(tx, {
        workspaceId: hook.workspaceId,
        actor: user,
        action: 'webhook.updated',
        target: { type: 'webhook', id: hook.id, label: maskedHookUrl(hook) },
        before,
        after,
      })
      return row
    })
    invalidateWebhookCache(hook.workspaceId)
    return { webhook: toWebhookDTO(row) }
  })

  app.delete('/webhooks/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const hook = await loadHook(idParam(req.params), user)
    await db.transaction(async (tx) => {
      const gone = await tx
        .delete(workspaceWebhooks)
        .where(and(eq(workspaceWebhooks.id, hook.id), eq(workspaceWebhooks.workspaceId, hook.workspaceId)))
        .returning({ id: workspaceWebhooks.id })
      if (gone.length > 0) {
        await recordAudit(tx, {
          workspaceId: hook.workspaceId,
          actor: user,
          action: 'webhook.deleted',
          target: { type: 'webhook', id: hook.id, label: maskedHookUrl(hook) },
          before: { kind: hook.kind, events: hook.events },
        })
      }
    })
    invalidateWebhookCache(hook.workspaceId)
    return reply.code(204).send()
  })

  app.post(
    '/webhooks/:id/test',
    { preHandler: requireUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const hook = await loadHook(idParam(req.params), user)
      const ws = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, hook.workspaceId)).limit(1))[0]
      const result = await sendTestMessage(hook, ws?.name ?? 'Workspace')
      const fresh = (await db.select().from(workspaceWebhooks).where(eq(workspaceWebhooks.id, hook.id)).limit(1))[0]
      return {
        ok: result.ok,
        status: result.ok ? result.status : null,
        error: result.ok ? null : result.error,
        webhook: toWebhookDTO(fresh ?? hook),
      }
    },
  )
}
