import { asc, eq, sql } from 'drizzle-orm'
import { isAutoFieldType, summarizeAutomation } from '@inkling/shared'
import type { AutomationAction, AutomationDTO, AutomationInput, AutomationRunDTO, AutomationTrigger, CollectionField, ViewFilter } from '@inkling/shared'
import { db } from '../db/index'
import { collectionAutomations, collections, users, workspaceWebhooks } from '../db/schema'
import { badRequest } from '../errors'
import { findVisiblePage } from '../pageDto'

export type RuleRow = typeof collectionAutomations.$inferSelect

export async function collectionFields(collectionId: string): Promise<CollectionField[]> {
  const r = (await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, collectionId)).limit(1))[0]
  return (r?.fields ?? []) as CollectionField[]
}

export function toAutomationDTO(r: RuleRow, authorName: string | null, fields: CollectionField[]): AutomationDTO {
  const trigger = r.trigger as AutomationTrigger
  const condition = (r.condition ?? null) as ViewFilter | null
  const actions = (r.actions ?? []) as AutomationAction[]
  return {
    id: r.id,
    collectionId: r.collectionId,
    name: r.name,
    enabled: r.enabled,
    trigger,
    condition,
    actions,
    summary: summarizeAutomation({ trigger, condition, actions }, fields),
    createdBy: r.createdBy,
    createdByName: authorName,
    autoDisabledAt: r.autoDisabledAt ? r.autoDisabledAt.toISOString() : null,
    failureCount: r.failureCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listRules(collectionId: string): Promise<AutomationDTO[]> {
  const rows = await db
    .select({ r: collectionAutomations, name: users.name })
    .from(collectionAutomations)
    .leftJoin(users, eq(users.id, collectionAutomations.createdBy))
    .where(eq(collectionAutomations.collectionId, collectionId))
    .orderBy(asc(collectionAutomations.createdAt), asc(collectionAutomations.id))
  if (!rows.length) return []
  const fields = await collectionFields(collectionId)
  return rows.map((x) => toAutomationDTO(x.r, x.name ?? null, fields))
}

const STORED = new Set(['text', 'number', 'select', 'multiSelect', 'date', 'checkbox', 'url', 'email', 'phone', 'person', 'relation', 'status'])

function field(fields: CollectionField[], id: string, what: string): CollectionField {
  const f = fields.find((x) => x.id === id)
  if (!f) throw badRequest(`${what}: no field "${id}" in this database`)
  return f
}

function assertWritable(f: CollectionField, what: string): void {
  if (f.type === 'rollup' || f.type === 'formula' || isAutoFieldType(f.type) || !STORED.has(f.type)) {
    throw badRequest(`${what}: "${f.name}" is computed and cannot be set`)
  }
}

/**
 * A rule fits the collection and the workspace: fields exist with the right types, a target
 * database is one the author can see in the same workspace, a webhook is one registered there.
 * Run-time checks (REST as the author) still decide every write.
 */
export async function validateRule(input: AutomationInput, ctx: { collectionId: string; workspaceId: string; userId: string; fields: CollectionField[] }): Promise<void> {
  const { fields } = ctx
  const t = input.trigger
  if (t.type === 'fieldChanged') {
    const f = field(fields, t.fieldId, 'Trigger')
    if (f.type === 'rollup' || f.type === 'formula' || isAutoFieldType(f.type)) throw badRequest(`Trigger: "${f.name}" is computed; a change of it is not a write`)
  }
  if (t.type === 'dateReached' && field(fields, t.fieldId, 'Trigger').type !== 'date') throw badRequest('Trigger: "date reached" needs a date field')
  for (const [i, a] of input.actions.entries()) {
    const what = `Action ${i + 1}`
    switch (a.type) {
      case 'setFields':
        if (!Object.keys(a.props).length) throw badRequest(`${what}: no values to set`)
        for (const k of Object.keys(a.props)) assertWritable(field(fields, k, what), what)
        break
      case 'assign':
      case 'assignAgent':
        if (field(fields, a.fieldId, what).type !== 'person') throw badRequest(`${what}: needs a person field`)
        break
      case 'notify':
        if (a.fieldId && field(fields, a.fieldId, what).type !== 'person') throw badRequest(`${what}: needs a person field`)
        if (!a.fieldId && !a.creator && !a.userIds?.length) throw badRequest(`${what}: nobody to notify`)
        break
      case 'webhook': {
        const hook = (await db.select({ ws: workspaceWebhooks.workspaceId }).from(workspaceWebhooks).where(eq(workspaceWebhooks.id, a.webhookId)).limit(1))[0]
        if (!hook || hook.ws !== ctx.workspaceId) throw badRequest(`${what}: no such webhook in this workspace`)
        break
      }
      case 'addRow': {
        const target = await findVisiblePage(a.collectionId, ctx.userId)
        if (!target || target.kind !== 'collection' || target.workspaceId !== ctx.workspaceId) throw badRequest(`${what}: no such database in this workspace`)
        const tf = a.collectionId === ctx.collectionId ? fields : await collectionFields(a.collectionId)
        for (const k of Object.keys(a.props ?? {})) assertWritable(field(tf, k, what), what)
        break
      }
    }
  }
}

/** Recent runs of a collection's rules (or one rule), newest first. */
export async function listRuns(collectionId: string, ruleId: string | null, limit: number): Promise<AutomationRunDTO[]> {
  const rows = (await db.execute(sql`
    SELECT r.id::text AS id, r.automation_id AS "automationId", r.row_id AS "rowId", p.title AS "rowTitle",
           r.status, r.failed_action AS "failedAction", r.error, u.name AS "actorName", r.depth, r.created_at AS at
      FROM automation_runs r
      JOIN collection_automations a ON a.id = r.automation_id
      LEFT JOIN pages p ON p.id = r.row_id AND p.deleted_at IS NULL
      LEFT JOIN users u ON u.id = r.actor_id
     WHERE a.collection_id = ${collectionId} ${ruleId ? sql`AND r.automation_id = ${ruleId}` : sql``}
     ORDER BY r.id DESC LIMIT ${limit}
  `)) as unknown as (Omit<AutomationRunDTO, 'at'> & { at: Date | string })[]
  return rows.map((r) => ({ ...r, rowTitle: r.rowTitle ?? null, at: new Date(r.at).toISOString() }))
}

/** The collection page of a rule id, or null. */
export async function ruleById(id: string): Promise<RuleRow | null> {
  return (await db.select().from(collectionAutomations).where(eq(collectionAutomations.id, id)).limit(1))[0] ?? null
}

