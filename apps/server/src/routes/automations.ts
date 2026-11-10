import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AUTOMATIONS_MAX_PER_COLLECTION,
  automationInputSchema,
  automationPatchSchema,
  buttonWebhookSchema,
  parseButtonActions,
} from '@inkling/shared'
import type { AutomationInput, WebhookTargetDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { collectionAutomations, pageDocs, users, workspaceWebhooks } from '../db/schema'
import { badRequest, forbidden, notFound, AppError } from '../errors'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { assertPageEditable } from '../editLock'
import { findVisiblePage } from '../pageDto'
import { enqueue } from '../outbox'
import { stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { maskedHookUrl } from '../webhooks'
import { collectionFields, listRules, listRuns, toAutomationDTO, validateRule } from '../automations/rules'
import { setAutomationApp } from '../automations/runner'
import { requireCollectionPage } from './collections'

/**
 * Database automations (docs/adr/2240-*) and the server side of button blocks (docs/adr/2244-*).
 *
 *  - Rules are listed by members who can see the database; created, changed and deleted only by
 *    people who can edit it (the collection-settings bar: PUT /collection/fields), in the browser
 *    (like edit locks: no token, no agent makes rules in v1). A rule runs as whoever saved it or turned
 *    it on last, so editing someone's rule never borrows their rights.
 *  - Webhooks: members pick registered hooks by kind and host (never the URL); a button sends to a
 *    hook only when that page's stored document has that button with that hook.
 */

const ruleParams = z.object({ id: z.uuid(), ruleId: z.uuid() })
const runsQuery = z.object({ automationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).optional() })

async function requireBrowser(req: FastifyRequest): Promise<void> {
  if (req.authVia !== 'cookie') throw forbidden('Database automations are set up in the web app only')
}

/** The collection, its fields, and an edit check (the bar for its settings). */
async function editableCollection(id: string, userId: string) {
  const page = await requireCollectionPage(id, userId)
  const { role, acl } = await requireMembershipAcl(page.workspaceId, userId)
  await assertPageEditable(id, userId, { role, acl })
  return page
}

function hostOf(masked: string): string {
  const m = /^[a-z]+:\/\/([^/]+)/i.exec(masked)
  return m ? m[1] : '••••'
}

function findBlock(blocks: AnyBlock[], id: string): AnyBlock | null {
  for (const b of blocks) {
    if (b.id === id) return b
    const inner = findBlock(b.children ?? [], id)
    if (inner) return inner
  }
  return null
}

export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  setAutomationApp(app)

  app.get('/collections/:id/automations', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)
    let canEdit = req.authVia === 'cookie'
    if (canEdit) {
      try {
        await assertPageEditable(id, user.id, { role: page.role })
      } catch {
        canEdit = false
      }
    }
    return { automations: await listRules(id), canEdit }
  })

  app.post('/collections/:id/automations', { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await requireBrowser(req)
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await editableCollection(id, user.id)
    const body = automationInputSchema.parse(req.body)
    const fields = await collectionFields(id)
    await validateRule(body, { collectionId: id, workspaceId: page.workspaceId, userId: user.id, fields })
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM collection_automations WHERE collection_id = ${id}`)) as unknown as { n: number }[]
    if (n >= AUTOMATIONS_MAX_PER_COLLECTION) throw badRequest(`A database can have at most ${AUTOMATIONS_MAX_PER_COLLECTION} automations`)
    const [row] = await db
      .insert(collectionAutomations)
      .values({
        collectionId: id,
        workspaceId: page.workspaceId,
        name: body.name,
        enabled: body.enabled ?? true,
        trigger: body.trigger,
        condition: body.condition ?? null,
        actions: body.actions,
        createdBy: user.id,
      })
      .returning()
    return { automation: toAutomationDTO(row, user.name, fields) }
  })

  app.patch('/collections/:id/automations/:ruleId', { preHandler: requireUser }, async (req) => {
    await requireBrowser(req)
    const user = getUser(req)
    const { id, ruleId } = ruleParams.parse(req.params)
    const page = await editableCollection(id, user.id)
    const cur = (await db.select().from(collectionAutomations).where(and(eq(collectionAutomations.id, ruleId), eq(collectionAutomations.collectionId, id))).limit(1))[0]
    if (!cur) throw notFound()
    const patch = automationPatchSchema.parse(req.body ?? {})
    const next: AutomationInput = {
      name: patch.name ?? cur.name,
      enabled: patch.enabled ?? cur.enabled,
      trigger: patch.trigger ?? (cur.trigger as AutomationInput['trigger']),
      condition: patch.condition === undefined ? (cur.condition as AutomationInput['condition']) : patch.condition,
      actions: patch.actions ?? (cur.actions as AutomationInput['actions']),
    }
    // Turning a rule off changes nothing it does; anything else makes the saver its author.
    const offOnly = Object.keys(patch).length === 1 && patch.enabled === false
    const fields = await collectionFields(id)
    if (!offOnly) await validateRule(next, { collectionId: id, workspaceId: page.workspaceId, userId: user.id, fields })
    const [row] = await db
      .update(collectionAutomations)
      .set({
        name: next.name,
        enabled: next.enabled ?? true,
        trigger: next.trigger,
        condition: next.condition ?? null,
        actions: next.actions,
        updatedAt: new Date(),
        ...(offOnly ? {} : { createdBy: user.id }),
        // turned on again by hand: a fresh failure streak
        ...(patch.enabled === true ? { failureCount: 0, autoDisabledAt: null } : {}),
      })
      .where(eq(collectionAutomations.id, ruleId))
      .returning()
    const author = row.createdBy ? (await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)).limit(1))[0]?.name ?? null : null
    return { automation: toAutomationDTO(row, author, fields) }
  })

  app.delete('/collections/:id/automations/:ruleId', { preHandler: requireUser }, async (req, reply) => {
    await requireBrowser(req)
    const user = getUser(req)
    const { id, ruleId } = ruleParams.parse(req.params)
    await editableCollection(id, user.id)
    const gone = await db
      .delete(collectionAutomations)
      .where(and(eq(collectionAutomations.id, ruleId), eq(collectionAutomations.collectionId, id)))
      .returning({ id: collectionAutomations.id })
    if (!gone.length) throw notFound()
    return reply.code(204).send()
  })

  app.get('/collections/:id/automations/runs', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)
    const q = runsQuery.parse(req.query ?? {})
    return { runs: await listRuns(id, q.automationId ?? null, q.limit ?? 50) }
  })

  // Registered webhooks members may pick for buttons and rules: kind and host only.
  app.get('/workspaces/:id/webhook-targets', { preHandler: requireUser }, async (req): Promise<{ targets: WebhookTargetDTO[] }> => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const hooks = await db.select().from(workspaceWebhooks).where(eq(workspaceWebhooks.workspaceId, id))
    return {
      targets: hooks.map((h) => ({ id: h.id, kind: h.kind as WebhookTargetDTO['kind'], label: hostOf(maskedHookUrl(h)), enabled: h.enabled === '1' })),
    }
  })

  // A button's webhook action (docs/adr/2244-*): the hook comes from the stored button, not the client.
  app.post('/pages/:id/button-webhook', { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    const body = buttonWebhookSchema.parse(req.body)
    const [doc] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, id)).limit(1)
    let blocks: AnyBlock[] = []
    try {
      blocks = doc ? stateToBlocks(doc.state) : []
    } catch {
      blocks = []
    }
    const block = findBlock(blocks, body.blockId)
    const actions = block?.type === 'button' ? parseButtonActions(String(block.props?.actions ?? '')) : []
    const action = actions.find((a) => a.type === 'webhook' && a.webhookId === body.webhookId)
    if (!action || action.type !== 'webhook') throw new AppError(409, 'BUTTON_NOT_SAVED', 'This button is not saved with that webhook yet; try again in a few seconds')
    const hook = (await db.select().from(workspaceWebhooks).where(eq(workspaceWebhooks.id, body.webhookId)).limit(1))[0]
    if (!hook || hook.workspaceId !== page.workspaceId) throw notFound()
    if (hook.enabled !== '1') throw new AppError(409, 'WEBHOOK_OFF', 'The webhook is turned off')
    const label = String(block?.props?.label ?? '').trim() || 'Button'
    const n = await enqueue(db, [
      {
        topic: 'webhook',
        workspaceId: page.workspaceId,
        payload: {
          hookId: hook.id,
          event: { type: 'automation', workspaceId: page.workspaceId, pageId: id, actorId: user.id, via: user.via ?? null, field: label.slice(0, 80), message: action.message ?? null },
        },
      },
    ])
    if (n === 0) throw new AppError(429, 'RATE_LIMITED', 'The webhook queue of this workspace is full; try again later')
    return { ok: true }
  })
}
