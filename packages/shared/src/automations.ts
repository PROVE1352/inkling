/**
 * Buttons and database automations (0.18, docs/adr/2240-* .. 2245-*).
 *
 *  - A button block (`button`, blocks.ts) holds a label, a color and a list of actions run in order
 *    by the person who presses it, through the REST routes that person may use anyway.
 *  - A collection automation is a rule: one trigger, an optional condition (the 0.17 view filter
 *    tree, `matchesViewFilter`) and actions. The server runs it after the row write commits, as the
 *    rule's author, labelled `automation: <name>` (agentVia.ts) — see ADR 2240-2243.
 *
 * Values in actions may hold variables, resolved by `resolveActionProps` on the side that runs the
 * action (web for buttons, server for automations):
 *    date      'today', 'today+N', 'today-N'
 *    person    'me' (who pressed / who triggered), 'creator' (the row's creator, automations only)
 *    relation  'this' (the page the button is on / the row that triggered)
 *    text      '{{today}}', '{{me}}' (a name), '{{page}}' (the page title) inside the text
 *
 * This file must not import values from './index' (index re-exports it); type imports are fine.
 */
import { z } from 'zod'
import { viewFilterSchema } from './collectionFields'
import type { ViewFilter } from './collectionFields'
import type { CollectionField } from './index'

// ---------------------------------------------------------------------------
// button block
// ---------------------------------------------------------------------------

/** Colors of a button: BlockNote's text/background color names (the block style range). */
export const BUTTON_COLORS = ['default', 'gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const
export type ButtonColor = (typeof BUTTON_COLORS)[number]

/** Actions per button / per automation. */
export const BUTTON_ACTIONS_MAX = 5
export const AUTOMATION_ACTIONS_MAX = 5
/** Field values one action may set. */
export const ACTION_PROPS_MAX = 20
/** Largest `actions` JSON a button block keeps (characters). */
export const BUTTON_ACTIONS_MAX_CHARS = 8_000

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const propsSchema = z
  .record(z.string().max(40), z.unknown())
  .refine((p) => Object.keys(p).length <= ACTION_PROPS_MAX, { message: `At most ${ACTION_PROPS_MAX} values` })

/** Add a row to a collection (template optional; values may hold variables). */
export const addRowActionSchema = z.object({
  type: z.literal('addRow'),
  collectionId: id,
  templateId: id.nullable().optional(),
  title: z.string().max(300).optional(),
  props: propsSchema.optional(),
})
/** Set values of the row the button is on / the row that triggered. */
export const setFieldsActionSchema = z.object({
  type: z.literal('setFields'),
  props: propsSchema,
})
/** Open a page of the workspace or an http(s) URL (buttons only). */
export const openActionSchema = z.object({
  type: z.literal('open'),
  pageId: id.optional(),
  url: z.string().max(2000).optional(),
})
/** Send to a webhook an owner registered in the workspace (never a URL typed here). */
export const webhookActionSchema = z.object({
  type: z.literal('webhook'),
  webhookId: id,
  message: z.string().max(500).optional(),
})

export const buttonActionSchema = z.discriminatedUnion('type', [addRowActionSchema, setFieldsActionSchema, openActionSchema, webhookActionSchema])
export type ButtonAction = z.infer<typeof buttonActionSchema>
export const buttonActionsSchema = z.array(buttonActionSchema).max(BUTTON_ACTIONS_MAX)

/** The actions of a button block's `actions` prop; invalid entries are dropped (never throws). */
export function parseButtonActions(json: string | null | undefined): ButtonAction[] {
  if (!json) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ButtonAction[] = []
  for (const a of raw.slice(0, BUTTON_ACTIONS_MAX)) {
    const r = buttonActionSchema.safeParse(a)
    if (r.success) out.push(r.data)
  }
  return out
}

/** Canonical JSON of button actions (sorted keys inside each action), '' for none. */
export function buttonActionsJson(actions: ButtonAction[]): string {
  if (!actions.length) return ''
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v
  return JSON.stringify(actions.map(sortKeys))
}

/** Is `url` an http(s) URL a button may open? */
export function isOpenableUrl(url: string): boolean {
  // no URL global in this package's lib (shared by server and web): a strict prefix check
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url.trim()) && url.length <= 2000
}

// ---------------------------------------------------------------------------
// variables
// ---------------------------------------------------------------------------

export interface ActionVarContext {
  /** YYYY-MM-DD in the runner's time zone. */
  today: string
  /** Who pressed the button / who triggered the automation (null: nobody known). */
  userId: string | null
  userName?: string
  /** The page the button is on, or the row that triggered. */
  pageId?: string | null
  pageTitle?: string
  /** The triggering row's creator (automations). */
  creatorId?: string | null
}

export const ACTION_DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|today(?:[+-]\d{1,4})?)$/

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

/** 'today', 'today+3', '2026-01-02' → a date; anything else → null. */
export function resolveDateVar(value: string, today: string): string | null {
  const v = value.trim().toLowerCase()
  if (!ACTION_DATE_RE.test(v)) return null
  if (!v.startsWith('today')) return v
  const n = v.length > 5 ? Number(v.slice(5)) : 0
  return addDays(today, n)
}

/** `{{today}}`, `{{me}}`, `{{page}}` inside a text. Unknown variables stay as typed. */
export function renderTextVars(text: string, ctx: ActionVarContext): string {
  return text.replace(/\{\{\s*(today|me|page)\s*\}\}/gi, (_m, name: string) => {
    switch (name.toLowerCase()) {
      case 'today':
        return ctx.today
      case 'me':
        return ctx.userName ?? ''
      default:
        return ctx.pageTitle ?? ''
    }
  })
}

/**
 * Concrete values from action values: variables resolved by field type. Fields that do not exist
 * (deleted since the action was set up) and variables that cannot resolve here (no page for
 * 'this', nobody for 'me') are left out, so the write sets what it can and never a raw variable.
 */
export function resolveActionProps(
  fields: CollectionField[],
  props: Record<string, unknown> | undefined,
  ctx: ActionVarContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!props) return out
  const byId = new Map(fields.map((f) => [f.id, f]))
  for (const [key, value] of Object.entries(props)) {
    const f = byId.get(key)
    if (!f) continue
    if (value === null) {
      out[key] = null
      continue
    }
    switch (f.type) {
      case 'date': {
        if (typeof value !== 'string') continue
        const d = resolveDateVar(value, ctx.today)
        if (d) out[key] = d
        break
      }
      case 'person': {
        const one = (v: unknown): string | null =>
          v === 'me' ? ctx.userId : v === 'creator' ? (ctx.creatorId ?? null) : typeof v === 'string' && id.safeParse(v).success ? v : null
        const list = (Array.isArray(value) ? value : [value]).map(one).filter((x): x is string => !!x)
        if (list.length) out[key] = Array.isArray(value) ? [...new Set(list)] : list[0]
        break
      }
      case 'relation': {
        const one = (v: unknown): string | null => (v === 'this' ? (ctx.pageId ?? null) : typeof v === 'string' && id.safeParse(v).success ? v : null)
        const list = (Array.isArray(value) ? value : [value]).map(one).filter((x): x is string => !!x)
        if (list.length) out[key] = [...new Set(list)]
        break
      }
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        out[key] = typeof value === 'string' ? renderTextVars(value, ctx).slice(0, 10_000) : value
        break
      default:
        out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// collection automations
// ---------------------------------------------------------------------------

export const AUTOMATIONS_MAX_PER_COLLECTION = 20
/** Runs kept per rule for the settings screen. */
export const AUTOMATION_RUNS_KEPT = 50
/** Failures in a row after which a rule turns itself off (and its author hears about it). */
export const AUTOMATION_DISABLE_AFTER = 5
/** Automation-made writes that may trigger further automations (1 = a rule's write triggers rules once more). */
export const AUTOMATION_MAX_DEPTH = 3
/** Runs per rule per minute; beyond, runs are recorded as skipped. */
export const AUTOMATION_RUNS_PER_MINUTE = 30
/** Runs per workspace per minute. */
export const AUTOMATION_WS_RUNS_PER_MINUTE = 120

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rowAdded') }),
  z.object({
    type: z.literal('fieldChanged'),
    fieldId: z.string().min(1).max(40),
    /** "becomes": the new value equals this (option id / text / number / checkbox). Absent = any change. */
    to: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
  }),
  z.object({
    type: z.literal('dateReached'),
    fieldId: z.string().min(1).max(40),
    /** Days before the date (0 = on the day, 1 = the day before). */
    daysBefore: z.number().int().min(0).max(30),
  }),
])
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>

/** Who an automation notifies: people in a person field of the row, its creator, or named members. */
export const notifyActionSchema = z.object({
  type: z.literal('notify'),
  fieldId: z.string().max(40).optional(),
  creator: z.boolean().optional(),
  userIds: z.array(id).max(20).optional(),
  message: z.string().max(500).optional(),
})
/** Put people in a person field ('me' = who triggered, 'creator' = the row's creator, or member ids). */
export const assignActionSchema = z.object({
  type: z.literal('assign'),
  fieldId: z.string().min(1).max(40),
  to: z.array(z.string().max(40)).min(1).max(20),
})
/** Hand the row to a person's AI connection next to a person field (team agents, docs/adr/1861-*). */
export const assignAgentActionSchema = z.object({
  type: z.literal('assignAgent'),
  fieldId: z.string().min(1).max(40),
  /** A connection ref as the person cell takes it (`<userId>/grant:<id>`, see teamAgents.ts). */
  connection: z.string().min(1).max(200),
})

export const automationActionSchema = z.discriminatedUnion('type', [
  setFieldsActionSchema,
  assignActionSchema,
  notifyActionSchema,
  webhookActionSchema,
  addRowActionSchema,
  assignAgentActionSchema,
])
export type AutomationAction = z.infer<typeof automationActionSchema>

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  trigger: automationTriggerSchema,
  condition: viewFilterSchema.nullable().optional(),
  actions: z.array(automationActionSchema).min(1).max(AUTOMATION_ACTIONS_MAX),
})
export type AutomationInput = z.infer<typeof automationInputSchema>
export const automationPatchSchema = automationInputSchema.partial()

export interface AutomationDTO {
  id: string
  collectionId: string
  name: string
  enabled: boolean
  trigger: AutomationTrigger
  condition: ViewFilter | null
  actions: AutomationAction[]
  /** `trigger → actions` in one line (summarizeAutomation with the database's fields). */
  summary: string
  createdBy: string | null
  createdByName: string | null
  /** Set when the rule turned itself off after AUTOMATION_DISABLE_AFTER failures in a row. */
  autoDisabledAt: string | null
  failureCount: number
  createdAt: string
  updatedAt: string
}

export type AutomationRunStatus = 'ok' | 'failed' | 'skipped'

export interface AutomationRunDTO {
  id: string
  automationId: string
  rowId: string | null
  rowTitle: string | null
  status: AutomationRunStatus
  /** Index of the action that failed (0-based), null otherwise. */
  failedAction: number | null
  error: string | null
  /** Who triggered (null: a date, or nobody known). */
  actorName: string | null
  depth: number
  at: string
}

/** The via label of writes an automation makes (agentVia.ts reads the prefix). */
export const AUTOMATION_VIA_PREFIX = 'automation: '
export function automationVia(name: string): string {
  return `${AUTOMATION_VIA_PREFIX}${name.replace(/\s+/g, ' ').trim()}`.slice(0, 80)
}
export function isAutomationVia(via: string | null | undefined): boolean {
  return !!via && via.startsWith(AUTOMATION_VIA_PREFIX)
}

const fieldName = (fields: CollectionField[], fid: string) => fields.find((f) => f.id === fid)?.name?.trim() || fid

/** One line: `trigger → action, action` (agents' describe output, settings list). */
export function summarizeAutomation(rule: Pick<AutomationDTO, 'trigger' | 'actions' | 'condition'>, fields: CollectionField[]): string {
  const t = rule.trigger
  const trig =
    t.type === 'rowAdded'
      ? 'row added'
      : t.type === 'fieldChanged'
        ? `${fieldName(fields, t.fieldId)} changed${t.to !== undefined ? ` to ${optionLabel(fields, t.fieldId, t.to)}` : ''}`
        : `${t.daysBefore ? `${t.daysBefore}d before ` : ''}${fieldName(fields, t.fieldId)}`
  const cond = rule.condition && rule.condition.items.length ? ' (if filter)' : ''
  const acts = rule.actions.map((a) => {
    switch (a.type) {
      case 'setFields':
        return `set ${Object.keys(a.props).map((k) => fieldName(fields, k)).join(', ')}`
      case 'assign':
        return `assign ${fieldName(fields, a.fieldId)}`
      case 'notify':
        return `notify ${a.fieldId ? fieldName(fields, a.fieldId) : a.creator ? 'creator' : 'people'}`
      case 'webhook':
        return 'webhook'
      case 'addRow':
        return 'add row to another database'
      case 'assignAgent':
        return `hand to AI (${fieldName(fields, a.fieldId)})`
    }
  })
  return `${trig}${cond} → ${acts.join(', ')}`
}

function optionLabel(fields: CollectionField[], fid: string, v: string | number | boolean): string {
  const f = fields.find((x) => x.id === fid)
  const opt = typeof v === 'string' ? f?.options?.find((o) => o.id === v) : undefined
  return JSON.stringify(opt?.name ?? v)
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

/** A registered webhook as members may pick it (GET /workspaces/:id/webhook-targets): never its URL. */
export interface WebhookTargetDTO {
  id: string
  kind: 'slack' | 'discord' | 'generic'
  /** Masked host, e.g. "hooks.slack.com/…" */
  label: string
  enabled: boolean
}

/** POST /pages/:id/button-webhook: the button block (in that page) whose webhook action to run. */
export const buttonWebhookSchema = z.object({
  blockId: z.string().min(1).max(64),
  webhookId: id,
})
