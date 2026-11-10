/**
 * Cell display and write mapping for the collection agent tools (docs/adr/0934-*). Pure.
 *
 * Display: stored props (option ids, user ids, row ids) → short strings an agent can read and
 * feed back into a filter or update (option names, member names, linked row titles).
 * Write: `{ "Field name": value }` → `{ fieldId: storedValue }` with the same rules as the batch
 * route's sanitizer, but strict: an invalid value is an error that names the valid ones instead of
 * being dropped silently.
 */
import { formatFormulaNumber, formulaErrorText } from '@inkling/shared'
import type { CollectionField, FormulaErrorCode } from '@inkling/shared'
import { fieldResolver, findOption, optionNames, parseBool, parseDateValue } from './filter'
import { agentPropKey } from '@inkling/shared'

/** A connection written into a person cell (docs/adr/1864-*): full ref, connection key or short id. */
const AGENT_VALUE_RE = /^(?:[0-9a-f-]{36}\/)?(?:grant|token):[0-9a-f-]{36}$|^[gt]:[0-9a-f]{4,32}$/i
import type { ResolvedField } from './filter'

export const CELL_MAX_CHARS = 200
const MULTI_SHOWN = 10
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One line, no column separator ambiguity, bounded length. */
export function cleanCell(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  if (out.length > CELL_MAX_CHARS) out = `${out.slice(0, CELL_MAX_CHARS - 1)}…`
  return out
}

/** Numbers rounded to 12 significant digits: 0.1 + 0.2 shows as 0.3, the same on every call. */
export function formatNumber(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : ''
}

function list(items: string[]): string {
  const shown = items.slice(0, MULTI_SHOWN).join(', ')
  return items.length > MULTI_SHOWN ? `${shown} (+${items.length - MULTI_SHOWN} more)` : shown
}

export interface DisplayCtx {
  /** visible linked rows (from resolveRelations) */
  refTitles: Map<string, string>
  /** workspace member names */
  personNames: Map<string, string>
  /** formula errors of this row by field id (docs/adr/1825-*) */
  formulaErrors?: Record<string, FormulaErrorCode>
}

/**
 * Display string of one cell. `props` must already be passed through resolveRelations (relation
 * cells hold only visible links, rollups are computed).
 */
export function formatCell(f: ResolvedField, title: string, props: Record<string, unknown>, ctx: DisplayCtx): string {
  if (f.kind === 'title') return cleanCell(title)
  const field = f.field
  const v = props[field.id]
  if (field.type === 'formula') {
    const err = ctx.formulaErrors?.[field.id]
    if (err) return formulaErrorText(err)
    if (typeof v === 'number') return formatFormulaNumber(v)
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    return v === undefined || v === null ? '' : cleanCell(String(v))
  }
  // unchecked is a value (filters treat a missing checkbox as false), never an empty cell
  if (field.type === 'checkbox') return v === true ? 'true' : 'false'
  if (v === undefined || v === null || v === '') return ''
  switch (field.type) {
    case 'text':
    case 'url':
    case 'date':
      return cleanCell(String(v))
    case 'number':
      return typeof v === 'number' ? formatNumber(v) : cleanCell(String(v))
    case 'select':
      return cleanCell(field.options?.find((o) => o.id === v)?.name ?? '')
    case 'multiSelect':
      return Array.isArray(v)
        ? cleanCell(list(v.map((id) => field.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean)))
        : ''
    case 'person':
      return cleanCell(ctx.personNames.get(String(v)) ?? '')
    case 'relation':
      return Array.isArray(v)
        ? cleanCell(
            list(
              v
                .filter((id) => ctx.refTitles.has(String(id)))
                .map((id) => ctx.refTitles.get(String(id)) || 'Untitled'),
            ),
          )
        : ''
    case 'rollup':
      if (Array.isArray(v)) return cleanCell(list(v.map(String)))
      return typeof v === 'number' ? formatNumber(v) : cleanCell(String(v))
  }
  return cleanCell(String(v))
}

/** Field summary returned by the query route (names, not ids, except `id` for #id escapes). */
export interface FieldSummary {
  id: string
  name: string
  type: CollectionField['type']
  /** select / multiSelect option names */
  options?: string[]
  /** relation: target collection title */
  target?: string
  /** rollup: aggregate function (read-only) */
  rollup?: string
  /** formula: expression and result type (read-only) */
  formula?: { expression: string; result: string }
}

/** `Status (select: Todo, Doing, Done)` */
export function describeField(f: FieldSummary, maxOptions = Infinity): string {
  switch (f.type) {
    case 'select':
    case 'multiSelect': {
      const opts = f.options ?? []
      const shown = opts.slice(0, maxOptions).join(', ')
      const more = opts.length > maxOptions ? ` (+${opts.length - maxOptions} more; describe=true lists all)` : ''
      return `${f.name} (${f.type}: ${opts.length ? shown + more : 'no options'})`
    }
    case 'relation':
      return `${f.name} (relation → ${f.target ?? '?'})`
    case 'rollup':
      return `${f.name} (rollup ${f.rollup ?? ''}, read-only)`
    case 'formula':
      return `${f.name} (formula → ${f.formula?.result ?? 'text'}, read-only)`
    default:
      return `${f.name} (${f.type})`
  }
}

// ---------------------------------------------------------------------------
// write mapping
// ---------------------------------------------------------------------------

export class ValueError extends Error {}

export interface Member {
  id: string
  name: string
  email: string
}

export interface MapCtx {
  userId: string
  today: string
  /** required only when a person field is written */
  members?: Member[]
  /** The caller's connection key, for "this connection" (docs/adr/1864-*). */
  connection?: string | null
}

export interface MappedWrite {
  /** fieldId → stored value (null = clear) for every non-relation field */
  props: Record<string, unknown>
  /** relation fields: row ids or titles to resolve against the target collection (full replacement) */
  relations: { field: CollectionField; refs: string[] }[]
  /** a "Title" key in the input */
  title?: string
}

/** Does the input touch a person field? (the caller then loads the member list) */
export function needsMembers(fields: CollectionField[], input: Record<string, unknown>): boolean {
  const r = fieldResolver(fields)
  return Object.keys(input).some((k) => {
    try {
      const f = r.resolve(k)
      return f.kind === 'field' && f.field.type === 'person'
    } catch {
      return false
    }
  })
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return [v]
}

export function mapWrite(fields: CollectionField[], input: Record<string, unknown>, ctx: MapCtx): MappedWrite {
  const resolver = fieldResolver(fields)
  const out: MappedWrite = { props: {}, relations: [] }
  const errors: string[] = []
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(input)) {
    let f: ResolvedField
    try {
      f = resolver.resolve(name)
    } catch (err) {
      errors.push((err as Error).message)
      continue
    }
    if (f.kind === 'title') {
      if (value === null || typeof value !== 'string') errors.push('Title must be a string')
      else out.title = value.trim().slice(0, 500)
      continue
    }
    const field = f.field
    if (seen.has(field.id)) {
      errors.push(`"${field.name}" is given twice`)
      continue
    }
    seen.add(field.id)
    if (field.type === 'rollup') {
      errors.push(`"${field.name}" is a rollup (computed, read-only); change the related rows instead`)
      continue
    }
    if (field.type === 'formula') {
      errors.push(`"${field.name}" is a formula (computed, read-only); change the properties it reads instead`)
      continue
    }
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      if (field.type === 'relation') out.relations.push({ field, refs: [] })
      else out.props[field.id] = null
      continue
    }
    const bad = (expect: string) => errors.push(`"${field.name}" (${field.type}): ${expect}; got ${JSON.stringify(value)}`)
    switch (field.type) {
      case 'text':
      case 'url':
        if (typeof value === 'string' || typeof value === 'number') out.props[field.id] = String(value).slice(0, 10_000)
        else bad('expects a string')
        break
      case 'number': {
        const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
        if (Number.isFinite(n)) out.props[field.id] = n
        else bad('expects a number')
        break
      }
      case 'checkbox': {
        const b = parseBool(value)
        if (b === null) bad('expects true or false')
        else out.props[field.id] = b
        break
      }
      case 'date': {
        const d = typeof value === 'string' ? parseDateValue(value, ctx.today) : null
        if (d) out.props[field.id] = d
        else bad('expects YYYY-MM-DD (or today, today+N)')
        break
      }
      case 'select': {
        const id = typeof value === 'string' ? findOption(field, value) : null
        if (id) out.props[field.id] = id
        else bad(`expects one of: ${optionNames(field)}`)
        break
      }
      case 'multiSelect': {
        const ids: string[] = []
        const unknown: string[] = []
        for (const item of asList(value)) {
          const id = typeof item === 'string' ? findOption(field, item) : null
          if (id) {
            if (!ids.includes(id)) ids.push(id)
          } else unknown.push(String(item))
        }
        if (unknown.length) bad(`unknown option(s) ${unknown.map((u) => `"${u}"`).join(', ')}; options: ${optionNames(field)}`)
        else out.props[field.id] = ids
        break
      }
      case 'person': {
        const s = typeof value === 'string' ? value.trim() : ''
        // A person's agent connection (docs/adr/1864-*): "this connection", <userId>/grant:<id>,
        // grant:<id> / token:<id> or the short g:xxxxxxxx. The server checks it and fills the cell
        // with the connection's person (PATCH /pages/:id/props).
        const conn = s.toLowerCase() === 'this connection' ? (ctx.connection ?? null) : AGENT_VALUE_RE.test(s) ? s : null
        if (s.toLowerCase() === 'this connection' && !conn) {
          bad('"this connection" is for an agent connection')
          break
        }
        if (conn) {
          out.props[agentPropKey(field.id)] = conn
          break
        }
        const members = ctx.members ?? []
        let id: string | null = null
        if (s.toLowerCase() === 'me') id = ctx.userId
        else if (UUID_RE.test(s)) id = members.find((m) => m.id === s.toLowerCase())?.id ?? null
        else {
          const hits = members.filter((m) => m.name.toLowerCase() === s.toLowerCase() || m.email.toLowerCase() === s.toLowerCase())
          if (hits.length > 1) {
            bad(`"${s}" matches ${hits.length} members; use the email or user id`)
            break
          }
          id = hits[0]?.id ?? null
        }
        if (id) out.props[field.id] = id
        else bad(`expects a workspace member (name, email, user id or "me")${members.length ? `; members: ${members.slice(0, 20).map((m) => m.name).join(', ')}` : ''}`)
        break
      }
      case 'relation': {
        const refs = asList(value).map((x) => String(x).trim()).filter(Boolean)
        if (refs.length > 100) bad('at most 100 linked rows per update')
        else out.relations.push({ field, refs })
        break
      }
    }
  }
  if (errors.length) throw new ValueError(errors.join('\n'))
  return out
}
