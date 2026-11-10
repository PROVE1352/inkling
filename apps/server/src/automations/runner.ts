import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  AUTOMATION_DISABLE_AFTER,
  AUTOMATION_MAX_DEPTH,
  AUTOMATION_RUNS_KEPT,
  AUTOMATION_RUNS_PER_MINUTE,
  AUTOMATION_WS_RUNS_PER_MINUTE,
  automationVia,
  fillAutoProps,
  isAutoFieldType,
  matchesFilter,
  matchesViewFilter,
  resolveActionProps,
  renderTextVars,
} from '@inkling/shared'
import type { ActionVarContext, AutomationAction, AutomationTrigger, CollectionField, ViewFilter } from '@inkling/shared'
import type { AuthUser } from '../auth'
import { db } from '../db/index'
import { automationRuns, collectionAutomations, pages, users, workspaceMembers } from '../db/schema'
import { hasGrantsSql } from '../pageGrants'
import { findVisiblePage } from '../pageDto'
import { assertPageEditable } from '../editLock'
import { isAgentVia, PUBLIC_FORM_VIA } from '../agentVia'
import { enqueue, kickOutbox, outboxCommitted, ownedOrOrphaned, registerOutboxHandler, wakeAt } from '../outbox'
import { enqueueNotify } from '../notify/engine'
import { autoSourceColumns } from '../collectionQuery/autoValues'
import { AUTOMATION_RUN_HEADER, withRunToken } from './context'
import { collectionFields } from './rules'
import type { RuleRow } from './rules'
import type { AutomationJob } from './queue'
import './queue'

/**
 * The 'automation' outbox consumer (docs/adr/2240-* .. 2243-*): one run = one rule × one row.
 *
 *  - skipped (recorded): the chain is too deep or already ran this rule (loop marker), the rule ran
 *    too often this minute, the row is gone or in the trash;
 *  - not recorded: the rule was turned off or deleted, the "becomes" value or the condition does
 *    not match (most changes do not concern a rule);
 *  - otherwise the actions run in order, as the rule's author through the REST routes (context.ts);
 *    the first failure stops the run and is recorded with its action number. AUTOMATION_DISABLE_AFTER
 *    failures in a row turn the rule off and tell its author.
 */

let app: FastifyInstance | null = null
export function setAutomationApp(a: FastifyInstance | null): void {
  app = a
}

let log: (msg: string) => void = (m) => console.error(m)
export function setAutomationLogger(fn: (msg: string) => void): void {
  log = fn
}

const LEASE_MS = 60_000
const BATCH = 10

interface Claimed {
  id: string
  workspaceId: string
  payload: AutomationJob
}

// ---- rate limits (per process; a second instance doubles them, docs/adr/2242-*) ----
const ruleWindows = new Map<string, number[]>()
const wsWindows = new Map<string, number[]>()
function take(map: Map<string, number[]>, key: string, max: number, now: number): boolean {
  const w = (map.get(key) ?? []).filter((t) => now - t < 60_000)
  if (w.length >= max) {
    map.set(key, w)
    return false
  }
  w.push(now)
  map.set(key, w)
  if (map.size > 5_000) map.delete(map.keys().next().value as string)
  return true
}
/** Tests: forget the windows. */
export function resetAutomationLimits(): void {
  ruleWindows.clear()
  wsWindows.clear()
}

export async function runAutomationPass(): Promise<number> {
  // a process without the routes cannot run actions: leave the rows to one that can
  if (!app) return 0
  const rows = (await db.execute(sql`
    UPDATE outbox SET locked_until = now() + make_interval(secs => ${LEASE_MS / 1000}), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
        WHERE topic = 'automation' AND state = 'pending' AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now()) AND ${ownedOrOrphaned()}
        ORDER BY id LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id, workspace_id AS "workspaceId", payload
  `)) as unknown as Claimed[]
  for (const r of rows) {
    try {
      await runJob(r)
    } catch (err) {
      log(`[automations] run ${r.id} failed unexpectedly: ${String(err)}`)
    }
    await db.execute(sql`UPDATE outbox SET state = 'done', finished_at = now(), locked_until = NULL WHERE id = ${r.id} AND state = 'pending'`)
  }
  return rows.length
}

registerOutboxHandler('automation', runAutomationPass, BATCH)

async function record(rule: Pick<RuleRow, 'id' | 'name' | 'collectionId' | 'workspaceId' | 'createdBy'>, job: AutomationJob, status: 'ok' | 'failed' | 'skipped', opts: { failedAction?: number; error?: string } = {}): Promise<void> {
  const told = await db.transaction(async (tx) => {
    await tx.insert(automationRuns).values({
      automationId: rule.id,
      rowId: job.rowId,
      status,
      failedAction: opts.failedAction ?? null,
      error: opts.error ? opts.error.slice(0, 300) : null,
      actorId: job.actorId,
      depth: Math.min(job.depth, 32767),
    })
    // keep the newest AUTOMATION_RUNS_KEPT per rule
    await tx.execute(sql`
      DELETE FROM automation_runs WHERE automation_id = ${rule.id} AND id < (
        SELECT id FROM automation_runs WHERE automation_id = ${rule.id} ORDER BY id DESC OFFSET ${AUTOMATION_RUNS_KEPT - 1} LIMIT 1)
    `)
    if (status === 'ok') {
      await tx.execute(sql`UPDATE collection_automations SET failure_count = 0 WHERE id = ${rule.id} AND failure_count <> 0`)
    } else if (status === 'failed') {
      const [r] = (await tx.execute(sql`
        UPDATE collection_automations
           SET failure_count = failure_count + 1,
               enabled = CASE WHEN failure_count + 1 >= ${AUTOMATION_DISABLE_AFTER} THEN false ELSE enabled END,
               auto_disabled_at = CASE WHEN failure_count + 1 >= ${AUTOMATION_DISABLE_AFTER} AND enabled THEN now() ELSE auto_disabled_at END
         WHERE id = ${rule.id}
        RETURNING failure_count AS n, auto_disabled_at IS NOT NULL AND auto_disabled_at > now() - interval '5 seconds' AS "justOff"
      `)) as unknown as { n: number; justOff: boolean }[]
      if (r?.justOff && r.n === AUTOMATION_DISABLE_AFTER && rule.createdBy) {
        // the author hears once, on the database page (a direct notification like a mention)
        await enqueueNotify(tx, {
          workspaceId: rule.workspaceId,
          pageId: rule.collectionId,
          actorId: null,
          via: automationVia(rule.name),
          recipients: [{ userId: rule.createdBy, kind: 'doc_mention', reason: 'direct' }],
          excerpt: `Automation "${rule.name}" was turned off after ${AUTOMATION_DISABLE_AFTER} failed runs: ${opts.error ?? ''}`.slice(0, 280),
        })
        return true
      }
    }
    return false
  })
  if (told) outboxCommitted(['notify'])
}

/** A failure the author can fix (a target gone, lost rights, a webhook off): counts toward turning the rule off. */
class ActionError extends Error {}
/**
 * Nothing to do for this row, or the trigger may not do it (docs/adr/2241-*, 2243-*): recorded as
 * skipped with the reason and never counted, so outsiders (form answers, guests) or empty cells
 * cannot turn a rule off.
 */
class SkipAction extends Error {}

async function inject(user: AuthUser, method: 'POST' | 'PATCH', url: string, payload: unknown): Promise<unknown> {
  if (!app) throw new ActionError('automations are not running in this process')
  return withRunToken(user, async (token) => {
    const res = await app!.inject({ method, url, headers: { [AUTOMATION_RUN_HEADER]: token, 'content-type': 'application/json' }, payload: JSON.stringify(payload) })
    if (res.statusCode >= 400) {
      let msg = `HTTP ${res.statusCode}`
      try {
        const b = res.json() as { error?: { message?: string; code?: string } }
        if (b?.error?.message) msg = `${b.error.message}${b.error.code ? ` (${b.error.code})` : ''}`
      } catch {
        // not JSON
      }
      throw new ActionError(msg)
    }
    return res.json()
  })
}

/** Role of a workspace member, null for others (guests, outsiders). */
async function memberRole(workspaceId: string, userId: string): Promise<string | null> {
  const r = (await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1))[0]
  return r?.role ?? null
}

/**
 * The trigger's cap (docs/adr/2241-*): an action that writes outside the triggering row runs only when
 * whoever triggered could make that write too. A public form visitor, a guest or an agent
 * connection (whose range and blocks the run cannot carry) cannot reach another database through a
 * rule; dates have no trigger person and run with the author's rights alone.
 */
export async function triggerMayReach(job: Pick<AutomationJob, 'actorId' | 'actorVia' | 'event'>, rule: Pick<RuleRow, 'collectionId' | 'workspaceId'>, target: string): Promise<string | null> {
  if (job.event === 'date' || !job.actorId) return null
  if (job.actorVia === PUBLIC_FORM_VIA) return 'started by a public form answer, which cannot write to other databases'
  if (isAgentVia(job.actorVia) && target !== rule.collectionId) return 'started by an agent connection, which cannot write to other databases through a rule'
  const role = await memberRole(rule.workspaceId, job.actorId)
  if (!role) return 'started by a guest, who cannot write to other databases through a rule'
  const page = await findVisiblePage(target, job.actorId)
  if (!page) return 'the person who started it cannot see that database'
  try {
    await assertPageEditable(target, job.actorId, { role: role as 'member' })
  } catch {
    return 'the person who started it cannot edit that database'
  }
  return null
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function runJob(r: Claimed): Promise<void> {
  const job = r.payload
  const rule = (await db.select().from(collectionAutomations).where(eq(collectionAutomations.id, job.ruleId)).limit(1))[0]
  if (!rule || !rule.enabled) return
  // loop marker (docs/adr/2242-*)
  if (job.depth > AUTOMATION_MAX_DEPTH) return record(rule, job, 'skipped', { error: `loop: more than ${AUTOMATION_MAX_DEPTH} automation steps in a row` })
  if (job.chain.includes(rule.id)) return record(rule, job, 'skipped', { error: 'loop: this rule already ran in this chain' })
  const now = Date.now()
  if (!take(ruleWindows, rule.id, AUTOMATION_RUNS_PER_MINUTE, now) || !take(wsWindows, rule.workspaceId, AUTOMATION_WS_RUNS_PER_MINUTE, now)) {
    return record(rule, job, 'skipped', { error: 'rate limit: too many runs this minute' })
  }
  const row = (
    await db
      .select({ id: pages.id, title: pages.title, props: pages.props, parentId: pages.parentId, deletedAt: pages.deletedAt, workspaceId: pages.workspaceId, ...autoSourceColumns })
      .from(pages)
      .where(eq(pages.id, job.rowId))
      .limit(1)
  )[0]
  if (!row || row.deletedAt || row.parentId !== rule.collectionId) return record(rule, job, 'skipped', { error: 'the row is in the trash, deleted or moved' })
  const fields = await collectionFields(rule.collectionId)
  const props = { ...((row.props ?? {}) as Record<string, unknown>) }
  fillAutoProps(fields.filter((f) => isAutoFieldType(f.type)), props, row)
  const trigger = rule.trigger as AutomationTrigger
  if (trigger.type === 'fieldChanged' && trigger.to !== undefined) {
    const f = fields.find((x) => x.id === trigger.fieldId)
    if (!f || !matchesFilter(f, props[f.id], 'eq', trigger.to)) return
  }
  if (!matchesViewFilter(props, fields, (rule.condition ?? null) as ViewFilter | null)) return

  if (!rule.createdBy) return record(rule, job, 'failed', { failedAction: 0, error: "the rule's author no longer has an account" })
  const author = (
    await db.select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, hasGrants: hasGrantsSql(users.id) }).from(users).where(eq(users.id, rule.createdBy)).limit(1)
  )[0]
  if (!author) return record(rule, job, 'failed', { failedAction: 0, error: "the rule's author no longer has an account" })
  const user: AuthUser = {
    id: author.id,
    email: author.email,
    name: author.name,
    isAdmin: author.isAdmin,
    ...(author.hasGrants ? { hasGrants: true } : {}),
    via: automationVia(rule.name),
    automation: { ruleId: rule.id, depth: job.depth, chain: job.chain },
  }
  const actorName = job.actorId ? ((await db.select({ name: users.name }).from(users).where(eq(users.id, job.actorId)).limit(1))[0]?.name ?? '') : ''
  const ctx: ActionVarContext = { today: today(), userId: job.actorId, userName: actorName, pageId: row.id, pageTitle: row.title, creatorId: row.createdBy ?? null }
  const actions = (rule.actions ?? []) as AutomationAction[]
  for (const [i, a] of actions.entries()) {
    try {
      await runAction(a, { rule, job, user, row: { id: row.id, workspaceId: row.workspaceId, props }, fields, ctx })
    } catch (err) {
      if (err instanceof SkipAction) return record(rule, job, 'skipped', { failedAction: i, error: err.message })
      const msg = err instanceof ActionError ? err.message : String(err instanceof Error ? err.message : err)
      if (!(err instanceof ActionError)) log(`[automations] rule ${rule.id} action ${i + 1}: ${String(err)}`)
      return record(rule, job, 'failed', { failedAction: i, error: msg })
    }
  }
  return record(rule, job, 'ok')
}

interface RunCtx {
  rule: RuleRow
  job: AutomationJob
  user: AuthUser
  row: { id: string; workspaceId: string; props: Record<string, unknown> }
  fields: CollectionField[]
  ctx: ActionVarContext
}

async function runAction(a: AutomationAction, c: RunCtx): Promise<void> {
  switch (a.type) {
    case 'setFields': {
      const gone = Object.keys(a.props).filter((k) => !c.fields.some((f) => f.id === k))
      if (gone.length) throw new ActionError(`the field ${gone.join(', ')} was removed from the database`)
      const props = resolveActionProps(c.fields, a.props, c.ctx)
      if (!Object.keys(props).length) throw new SkipAction('nothing to set for this row (the values did not resolve)')
      await inject(c.user, 'PATCH', `/api/pages/${c.row.id}/props`, { props })
      return
    }
    case 'assign': {
      if (!c.fields.some((f) => f.id === a.fieldId)) throw new ActionError('the person field was removed from the database')
      const v = resolveActionProps(c.fields, { [a.fieldId]: a.to }, c.ctx)[a.fieldId]
      const first = Array.isArray(v) ? v[0] : v
      if (!first) throw new SkipAction('nobody to assign for this row (no one triggered it)')
      await inject(c.user, 'PATCH', `/api/pages/${c.row.id}/props`, { props: { [a.fieldId]: first } })
      return
    }
    case 'assignAgent': {
      const cap = c.job.actorVia === PUBLIC_FORM_VIA ? 'started by a public form answer, which cannot hand rows to an AI connection' : c.job.actorId && !c.job.event.startsWith('date') && !(await memberRole(c.rule.workspaceId, c.job.actorId)) ? 'started by a guest, who cannot hand rows to an AI connection' : null
      if (cap) throw new SkipAction(cap)
      await inject(c.user, 'PATCH', `/api/pages/${c.row.id}/props`, { props: { [`agent:${a.fieldId}`]: a.connection } })
      return
    }
    case 'addRow': {
      // a database that is gone is the author's to fix; the trigger's cap is not
      const [live] = (await db.execute(sql`SELECT 1 AS x FROM pages WHERE id = ${a.collectionId} AND kind = 'collection' AND deleted_at IS NULL`)) as unknown as unknown[]
      if (!live) throw new ActionError('the database to add rows to is in the trash or deleted')
      const cap = await triggerMayReach(c.job, c.rule, a.collectionId)
      if (cap) throw new SkipAction(cap)
      const target = a.collectionId === c.rule.collectionId ? c.fields : await collectionFields(a.collectionId)
      const props = resolveActionProps(target, a.props, c.ctx)
      await inject(c.user, 'POST', `/api/pages/${a.collectionId}/collection/rows`, {
        template: a.templateId ?? null,
        ...(a.title ? { title: renderTextVars(a.title, c.ctx).slice(0, 300) } : {}),
        props,
      })
      return
    }
    case 'notify': {
      if (a.fieldId && !c.fields.some((f) => f.id === a.fieldId)) throw new ActionError('the person field was removed from the database')
      const ids = new Set<string>()
      if (a.fieldId) {
        const v = c.row.props[a.fieldId]
        for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') ids.add(x)
      }
      if (a.creator && c.ctx.creatorId) ids.add(c.ctx.creatorId)
      for (const u of a.userIds ?? []) ids.add(u)
      // only members who can see the row (a person cell may name someone who lost access since)
      const to: string[] = []
      for (const u of [...ids].slice(0, 20)) {
        if ((await memberRole(c.row.workspaceId, u)) && (await findVisiblePage(c.row.id, u))) to.push(u)
      }
      if (!to.length) throw new SkipAction('nobody to notify for this row (empty field, or no one who can see the row)')
      const message = a.message ? renderTextVars(a.message, c.ctx) : ''
      await enqueueNotify(db, {
        workspaceId: c.row.workspaceId,
        pageId: c.row.id,
        actorId: c.job.actorId,
        via: automationVia(c.rule.name),
        recipients: to.map((userId) => ({ userId, kind: 'doc_mention' as const, reason: 'direct' as const })),
        excerpt: `${c.rule.name}${message ? `: ${message}` : ''}`.slice(0, 280),
      })
      outboxCommitted(['notify'])
      return
    }
    case 'webhook': {
      const [hook] = (await db.execute(sql`SELECT workspace_id AS ws, enabled FROM workspace_webhooks WHERE id = ${a.webhookId}`)) as unknown as { ws: string; enabled: string }[]
      if (!hook || hook.ws !== c.row.workspaceId) throw new ActionError('the webhook was removed')
      if (hook.enabled !== '1') throw new ActionError('the webhook is turned off')
      const n = await enqueue(db, [
        {
          topic: 'webhook',
          workspaceId: c.row.workspaceId,
          payload: {
            hookId: a.webhookId,
            event: {
              type: 'automation',
              workspaceId: c.row.workspaceId,
              pageId: c.row.id,
              actorId: c.job.actorId,
              via: automationVia(c.rule.name),
              field: c.rule.name,
              message: a.message ? renderTextVars(a.message, c.ctx).slice(0, 500) : null,
            },
          },
        },
      ])
      if (n === 0) throw new ActionError('the workspace webhook queue is full')
      return
    }
  }
}

// ---- date triggers: a tick (docs/adr/2240-*) ----
let timer: NodeJS.Timeout | null = null
export const AUTOMATION_DATE_TICK_MS = 15 * 60_000

export function startAutomationScheduler(): void {
  if (timer) return
  const tick = async () => {
    try {
      const { queueDateRuns } = await import('./queue')
      if ((await queueDateRuns(today())) > 0) kickOutbox('automation')
    } catch (err) {
      log(`[automations] date tick failed: ${String(err)}`)
    }
  }
  timer = setInterval(() => void tick(), AUTOMATION_DATE_TICK_MS)
  timer.unref()
  const first = setTimeout(() => void tick(), 20_000)
  first.unref()
  wakeAt('automation', 1_000)
}

export function stopAutomationScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
