/**
 * Form views (docs/adr/1820-*, 1821-*, 1822-*): a view of a collection that asks for a new row.
 *
 * The view's config holds which properties the form asks for, in order, with "required" and a help
 * text each. Members fill it in the app (the row is made by POST /pages/:id/collection/rows); with a
 * public link anyone who has the link can submit (POST /api/public/forms/:token), and the answer is
 * only "received" — a public form never shows rows, option counts or other answers.
 *
 * `formSubmissionProps` is the one conversion from submitted values to row props, used by the web
 * (to show what is missing before sending) and by the server (which is the one that decides).
 */
import { z } from 'zod'
import type { CollectionField, FieldType, SelectOption } from './index'
import { looksLikeEmail, looksLikePhone } from './collectionFields'

/** The row title in a form's field list (not a property). */
export const FORM_TITLE_FIELD = 'title'
/** Name of the hidden field a person never fills in; a submission that fills it is dropped. */
export const FORM_HONEYPOT_FIELD = 'website'

export const FORM_LIMITS = {
  fields: 50,
  title: 200,
  description: 2000,
  help: 500,
  /** characters of one text answer */
  text: 5000,
  url: 2000,
  /** bytes of a public submission body */
  bodyBytes: 32 * 1024,
} as const

/** Property types a form can ask for. Person is for member forms only (public visitors cannot see members). */
// Automatic values (created / edited time and by, unique ID; docs/adr/2140-*) are never asked.
export const FORM_FIELD_TYPES = new Set<FieldType>(['text', 'number', 'select', 'multiSelect', 'date', 'checkbox', 'url', 'email', 'phone', 'person'])
export const PUBLIC_FORM_FIELD_TYPES = new Set<FieldType>(['text', 'number', 'select', 'multiSelect', 'date', 'checkbox', 'url', 'email', 'phone'])

export const formFieldSchema = z.object({
  /** property id, or 'title' for the row title */
  fieldId: z.string().min(1).max(40),
  required: z.boolean().optional(),
  /** help text under the question */
  description: z.string().max(FORM_LIMITS.help).optional(),
})
export type FormFieldSettings = z.infer<typeof formFieldSchema>

export const formSettingsSchema = z.object({
  /** heading of the form; the view name when missing */
  title: z.string().max(FORM_LIMITS.title).optional(),
  description: z.string().max(FORM_LIMITS.description).optional(),
  fields: z.array(formFieldSchema).max(FORM_LIMITS.fields),
  submitLabel: z.string().max(60).optional(),
  /** shown after a submission */
  successMessage: z.string().max(500).optional(),
})
export type FormSettings = z.infer<typeof formSettingsSchema>

/** Fields a form asks for, in order: unknown and ineligible properties are skipped, duplicates dropped. */
export function formFields(
  settings: FormSettings | undefined,
  fields: CollectionField[],
  opts: { public: boolean },
): { fieldId: string; field: CollectionField | null; required: boolean; description: string }[] {
  const allowed = opts.public ? PUBLIC_FORM_FIELD_TYPES : FORM_FIELD_TYPES
  const byId = new Map(fields.map((f) => [f.id, f]))
  const out: { fieldId: string; field: CollectionField | null; required: boolean; description: string }[] = []
  const seen = new Set<string>()
  for (const s of settings?.fields ?? []) {
    if (seen.has(s.fieldId)) continue
    const f = byId.get(s.fieldId)
    if (!f && s.fieldId !== FORM_TITLE_FIELD) continue
    if (f && !allowed.has(f.type)) continue
    seen.add(s.fieldId)
    out.push({ fieldId: s.fieldId, field: f ?? null, required: !!s.required, description: s.description ?? '' })
  }
  return out
}

/** A new form view's settings: the title and the first fields a form can ask for. */
export function defaultFormSettings(fields: CollectionField[]): FormSettings {
  return {
    fields: [
      { fieldId: FORM_TITLE_FIELD, required: true },
      ...fields.filter((f) => PUBLIC_FORM_FIELD_TYPES.has(f.type)).slice(0, 8).map((f) => ({ fieldId: f.id })),
    ],
  }
}

export type FormProblem = 'required' | 'invalid'

export interface FormConversion {
  title: string
  props: Record<string, unknown>
  /** problems by field id ('title' for the title) */
  problems: Record<string, FormProblem>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function option(opts: SelectOption[] | undefined, v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  const list = opts ?? []
  return (list.find((o) => o.id === s) ?? list.find((o) => o.name.toLowerCase() === s.toLowerCase()))?.id ?? null
}

/**
 * Submitted values → row title and props for the fields the form asks for. Keys the form does not
 * ask for are ignored (a visitor cannot write any other property). Empty answers are left out; a
 * required one that is empty, or an answer of the wrong shape, is a problem. Person answers are
 * member ids (the server checks membership; public forms never ask for a person).
 */
export function formSubmissionProps(
  settings: FormSettings | undefined,
  fields: CollectionField[],
  values: Record<string, unknown>,
  opts: { public: boolean },
): FormConversion {
  const out: FormConversion = { title: '', props: {}, problems: {} }
  for (const q of formFields(settings, fields, opts)) {
    const raw = values[q.fieldId]
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0)
    const f = q.field
    if (!f) {
      // the row title
      if (empty) {
        if (q.required) out.problems[q.fieldId] = 'required'
        continue
      }
      if (typeof raw !== 'string') {
        out.problems[q.fieldId] = 'invalid'
        continue
      }
      out.title = raw.trim().replace(/[\r\n]+/g, ' ').slice(0, 300)
      continue
    }
    if (f.type === 'checkbox') {
      const on = raw === true || raw === 'true' || raw === 'on'
      if (raw !== undefined && raw !== null && typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false' && raw !== 'on' && raw !== '') {
        out.problems[f.id] = 'invalid'
        continue
      }
      if (q.required && !on) out.problems[f.id] = 'required'
      else if (on) out.props[f.id] = true
      continue
    }
    if (empty) {
      if (q.required) out.problems[f.id] = 'required'
      continue
    }
    let v: unknown = undefined
    switch (f.type) {
      case 'text':
        if (typeof raw === 'string' && raw.length <= FORM_LIMITS.text) v = raw.trim()
        break
      case 'url':
        if (typeof raw === 'string' && raw.trim().length <= FORM_LIMITS.url && !/[\s<>"]/.test(raw.trim())) v = raw.trim()
        break
      case 'email':
        if (typeof raw === 'string' && raw.trim().length <= FORM_LIMITS.url && looksLikeEmail(raw)) v = raw.trim()
        break
      case 'phone':
        if (typeof raw === 'string' && looksLikePhone(raw)) v = raw.trim()
        break
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
        if (Number.isFinite(n) && Math.abs(n) < 1e15) v = n
        break
      }
      case 'date':
        if (typeof raw === 'string' && validDate(raw.trim())) v = raw.trim()
        break
      case 'select':
        v = option(f.options, raw) ?? undefined
        break
      case 'multiSelect': {
        const list = Array.isArray(raw) ? raw : [raw]
        if (list.length > 50) break
        const ids = list.map((x) => option(f.options, x))
        if (ids.every((x): x is string => !!x)) v = [...new Set(ids)]
        break
      }
      case 'person':
        if (!opts.public && typeof raw === 'string' && UUID_RE.test(raw.trim())) v = raw.trim().toLowerCase()
        break
    }
    if (v === undefined) out.problems[f.id] = 'invalid'
    else out.props[f.id] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// public link (members) and public form (visitors)
// ---------------------------------------------------------------------------

/** GET/POST/DELETE /collection-views/:id/form-link (members). */
export interface FormLinkDTO {
  /** a public link is on */
  shared: boolean
  /** the token for /f/<token>; null when off (or when its copy cannot be opened) */
  token: string | null
  /** may turn a link on (owners and admins) */
  canPublish: boolean
}

export interface PublicFormFieldDTO {
  /** property id, or 'title' */
  key: string
  name: string
  type: FieldType | 'title'
  required: boolean
  description: string
  options?: { id: string; name: string; color: SelectOption['color'] }[]
}

/** GET /api/public/forms/:token — the questions only: never a row, a count or another answer. */
export interface PublicFormDTO {
  title: string
  description: string
  submitLabel: string | null
  successMessage: string | null
  fields: PublicFormFieldDTO[]
  /** name of the hidden field to render (left empty by people) */
  honeypot: string
}

/** POST /api/public/forms/:token */
export const publicFormSubmitSchema = z
  .object({
    values: z.record(z.string().max(40), z.unknown()),
    [FORM_HONEYPOT_FIELD]: z.string().max(500).optional(),
  })
  .strict()
