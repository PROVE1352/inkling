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
import { memberOrGuestSql } from '../pageGrants'
import {
  assertPublicWebhookHost,
  invalidateWebhookCache,
  listDeliveries,
  maskedHookUrl,
  maskWebhookUrl,
  MAX_WEBHOOKS_PER_WORKSPACE,
  newWebhookSecret,
  parseWebhookUrl,
  resendDelivery,
  SECRET_ROTATION_GRACE_MS,
  sendTestMessage,
  storeHookSecret,
  storeHookUrl,
  toWebhookDTO,
  WebhookUrlError,
} from '../webhooks'
import { recordAudit } from '../workspaceAdmin'
import { assertWorkspaceWritable } from '../quota/room'

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS as unknown as [WebhookEvent, ...WebhookEvent[]]))
  .max(WEBHOOK_EVENTS.length)
  .transform((a) => [...new Set(a)])

const createSchema = z.object({
  url: z.string().min(1).max(512),
  events: eventsSchema,
  /**
   * 'generic' (signed JSON to any public https endpoint, docs/adr/1190-*) must be chosen explicitly.
   * 'slack' / 'discord' are inferred from the host; the hint only matters for loopback URLs in
   * webhook test mode.
   */
  kind: z.enum(['slack', 'discord', 'generic']).optional(),
})

const rotateSchema = z.object({
  /** Keep signing with the old secret for 24 h (default) so receivers can switch without a gap. */
  keepPrevious: z.boolean().optional(),
})

const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() })
const deliveryParams = z.object({ id: z.uuid(), deliveryId: z.string().regex(/^[1-9][0-9]{0,17}$/) })

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
  // A hook of a workspace the caller is not in is "not found", like a missing id (docs/adr/1301-*).
  const hook = (
    await db
      .select()
      .from(workspaceWebhooks)
      .where(and(eq(workspaceWebhooks.id, id), memberOrGuestSql(workspaceWebhooks.workspaceId, user.id, false)))
      .limit(1)
  )[0]
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
      await assertWorkspaceWritable(db, workspaceId) // full workspace: LIMIT_STORAGE (docs/adr/2533-*)
      let parsed
      try {
        parsed = parseWebhookUrl(body.url, body.kind)
        if (parsed.kind === 'generic') await assertPublicWebhookHost(parsed.url)
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
      // Generic hooks sign every delivery; the secret is returned in this response only.
      const secret = parsed.kind === 'generic' ? newWebhookSecret() : null
      const row = await db.transaction(async (tx) => {
        // The id is chosen here: it is the AAD that binds the sealed URL to this row (docs/adr/1111-*).
        const id = randomUUID()
        const [row] = await tx
          .insert(workspaceWebhooks)
          .values({
            id,
            workspaceId,
            kind: parsed.kind,
            url: storeHookUrl(id, parsed.url),
            secret: secret ? storeHookSecret(id, secret) : null,
            events: body.events,
            createdBy: user.id,
          })
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
      return { webhook: toWebhookDTO(row), secret }
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
      if (body.enabled) Object.assign(set, { failureCount: 0, autoDisabledAt: null, failingSince: null })
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
      const result = await sendTestMessage(hook, ws?.name ?? 'Workspace', { id: user.id, name: user.name })
      const fresh = (await db.select().from(workspaceWebhooks).where(eq(workspaceWebhooks.id, hook.id)).limit(1))[0]
      return {
        ok: result.ok,
        status: result.ok ? result.status : null,
        error: result.ok ? null : result.error,
        webhook: toWebhookDTO(fresh ?? hook),
      }
    },
  )

  // Signing secret of a generic hook: a new one, shown once (docs/adr/1190-*). The old one keeps
  // being signed with for 24 h unless `keepPrevious: false` (a leaked secret is revoked at once).
  app.post(
    '/webhooks/:id/secret',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const hook = await loadHook(idParam(req.params), user)
      if (hook.kind !== 'generic') throw badRequest('Only generic webhooks have a signing secret')
      const body = rotateSchema.parse(req.body ?? {})
      const keep = body.keepPrevious !== false && !!hook.secret
      const secret = newWebhookSecret()
      const until = keep ? new Date(Date.now() + SECRET_ROTATION_GRACE_MS) : null
      const row = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(workspaceWebhooks)
          // the stored (sealed) old value is moved as is: same purpose and AAD
          .set({ secret: storeHookSecret(hook.id, secret), previousSecret: keep ? hook.secret : null, previousSecretUntil: until })
          .where(eq(workspaceWebhooks.id, hook.id))
          .returning()
        await recordAudit(tx, {
          workspaceId: hook.workspaceId,
          actor: user,
          action: 'webhook.updated',
          target: { type: 'webhook', id: hook.id, label: maskedHookUrl(hook) },
          after: { secret: 'rotated', previousValidUntil: until ? until.toISOString() : null },
        })
        return row
      })
      return { webhook: toWebhookDTO(row), secret }
    },
  )

  // Recent deliveries (docs/adr/1191-*).
  app.get('/webhooks/:id/deliveries', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const hook = await loadHook(idParam(req.params), user)
    const q = deliveriesQuery.parse(req.query ?? {})
    return { deliveries: await listDeliveries(hook.id, q.limit ?? 30) }
  })

  // Send a recorded delivery again: same delivery id, re-resolved and re-signed now.
  app.post(
    '/webhooks/:id/deliveries/:deliveryId/resend',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const p = deliveryParams.parse(req.params)
      const hook = await loadHook(p.id, user)
      if (hook.enabled !== '1') throw new AppError(409, 'WEBHOOK_DISABLED', 'Enable the webhook before sending deliveries again')
      const r = await resendDelivery(hook.id, Number(p.deliveryId))
      if (r === 'gone') throw new AppError(410, 'DELIVERY_GONE', 'This delivery is too old to send again')
      if (r === 'busy') throw new AppError(409, 'DELIVERY_IN_FLIGHT', 'This delivery is being sent right now')
      return reply.code(202).send({ ok: true })
    },
  )
}
