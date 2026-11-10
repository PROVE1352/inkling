import { z } from 'zod'

/**
 * Id argument schemas of every MCP tool (docs/adr/1940-*): a plain string in the tool list, the id
 * rule as a zod refinement (not shown in the list). Resolution of prefixes: idArgs.ts. No imports
 * besides zod, so core.ts can use it without a cycle.
 */

export type IdKind = 'page' | 'trashedPage' | 'workspace' | 'thread' | 'full'

export const FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A full id, or a prefix of 8–32 hex characters (dashes allowed where a full id has them). */
export function isIdOrPrefix(s: string): boolean {
  const t = s.trim()
  if (FULL_RE.test(t)) return true
  if (!/^[0-9a-f-]+$/i.test(t) || t.length > 36) return false
  const hex = t.replace(/-/g, '').length
  return hex >= 8 && hex <= 32
}

export const MESSAGES: Record<IdKind | 'any', string> = {
  page: 'expected a page id: the full id or its first 8+ hex characters (as find_context, list_pages and read_page print it)',
  trashedPage: 'expected the id of a trashed page: the full id or its first 8+ hex characters (list_trash)',
  workspace: 'expected a workspace id: the full id or its first 8+ hex characters (list_workspaces)',
  thread: 'expected a comment thread id: the full id or its first 8+ hex characters (list_comments)',
  full: 'expected a full id (36 characters, as the tool that listed it prints it)',
  any: 'expected an id: the full id or its first 8+ hex characters',
}

const CHECKS = {
  page: z.refine<string>((s) => isIdOrPrefix(s), { message: MESSAGES.page }),
  trashedPage: z.refine<string>((s) => isIdOrPrefix(s), { message: MESSAGES.trashedPage }),
  workspace: z.refine<string>((s) => isIdOrPrefix(s), { message: MESSAGES.workspace }),
  thread: z.refine<string>((s) => isIdOrPrefix(s), { message: MESSAGES.thread }),
  full: z.refine<string>((s) => FULL_RE.test(s.trim()), { message: MESSAGES.full }),
  any: z.refine<string>((s) => isIdOrPrefix(s), { message: MESSAGES.any }),
} as const

const KIND_OF_CHECK = new Map<unknown, IdKind | 'any'>(Object.entries(CHECKS).map(([k, c]) => [c, k as IdKind | 'any']))

/** An id argument of `kind` (a plain string in the tool list; see the module comment). */
export const idArg = (kind: IdKind) => z.string().trim().check(CHECKS[kind])

/** The shared `uuid()` of core.ts: an id whose kind comes from the field name. */
export const anyIdArg = () => z.string().trim().check(CHECKS.any)

/** Kinds of `uuid()` fields by name (modules that do not pick a kind themselves). */
export const FIELD_KINDS: Record<string, IdKind> = {
  pageId: 'page',
  parentId: 'page',
  forPageId: 'page',
  collectionId: 'page',
  rowId: 'page',
  target: 'page',
  workspaceId: 'workspace',
  threadId: 'thread',
}

/** Is this string one of the full-id forms (for callers that tell ids from keys, e.g. template ids). */
export const isFullId = (s: string) => FULL_RE.test(s.trim())

// ---------------------------------------------------------------------------
// plan: where the id fields of a tool's input schema are
// ---------------------------------------------------------------------------

export type Plan =
  | { t: 'id'; kind: IdKind }
  | { t: 'array'; of: Plan }
  | { t: 'object'; fields: [string, Plan][] }
  | { t: 'union'; of: Plan }

interface ZodLike {
  _zod: { def: Record<string, unknown> & { type: string } }
}

function idKindOf(s: ZodLike, field: string): IdKind | null {
  const checks = (s._zod.def.checks as unknown[] | undefined) ?? []
  for (const c of checks) {
    const k = KIND_OF_CHECK.get(c)
    if (k === 'any') return FIELD_KINDS[field] ?? 'full'
    if (k) return k
  }
  return null
}

export function planOf(schema: unknown, field: string): Plan | null {
  const s = schema as ZodLike
  const def = s?._zod?.def
  if (!def) return null
  switch (def.type) {
    case 'string': {
      const kind = idKindOf(s, field)
      return kind ? { t: 'id', kind } : null
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'nonoptional':
      return planOf(def.innerType, field)
    case 'pipe':
      return planOf(def.in, field)
    case 'array': {
      const of = planOf(def.element, field)
      return of ? { t: 'array', of } : null
    }
    case 'object': {
      const fields: [string, Plan][] = []
      for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
        const p = planOf(v, k)
        if (p) fields.push([k, p])
      }
      return fields.length ? { t: 'object', fields } : null
    }
    case 'union': {
      for (const o of def.options as unknown[]) {
        const p = planOf(o, field)
        if (p) return { t: 'union', of: p }
      }
      return null
    }
    default:
      return null
  }
}

/** The plan of a raw input shape (what registerTool receives). */
export function planOfShape(shape: unknown): [string, Plan][] {
  if (!shape || typeof shape !== 'object') return []
  if ((shape as ZodLike)._zod) {
    const p = planOf(shape, '')
    return p?.t === 'object' ? p.fields : []
  }
  const out: [string, Plan][] = []
  for (const [k, v] of Object.entries(shape as Record<string, unknown>)) {
    const p = planOf(v, k)
    if (p) out.push([k, p])
  }
  return out
}
