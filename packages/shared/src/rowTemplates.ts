import { z } from 'zod'
import { templateInputsSchema } from './templates'
import type { TemplateCursorDTO, TemplateInputDTO } from './templates'
// type-only: erased at runtime, so no import cycle (same as csv.ts)
import type { RowDTO } from './index'

// ---------------------------------------------------------------------------
// Database row templates (docs/adr/1180-1184, docs/TEMPLATES.md "Row templates")
//
// A collection (database) keeps up to ROW_TEMPLATES_MAX templates for its "New row" button: a
// title pattern, property defaults by field id and a body (a Yjs document, edited with the page
// editor). One of them may be the default. They live in their own table, never as pages.
//
// This module must not import from './index' (index re-exports it; a cycle would hit the TDZ).
// ---------------------------------------------------------------------------

/** Templates per collection. */
export const ROW_TEMPLATES_MAX = 20
/** Largest stored body (bytes of the Yjs update). */
export const ROW_TEMPLATE_BODY_MAX_BYTES = 2 * 1024 * 1024
/** Largest body update accepted in one PATCH, as base64 characters. */
const BODY_UPDATE_MAX_CHARS = Math.ceil((ROW_TEMPLATE_BODY_MAX_BYTES * 4) / 3) + 4

/**
 * Property defaults are keyed by field id. Values use the row value shapes, plus two relative
 * forms resolved when a row is created:
 *   date   → 'YYYY-MM-DD', 'today', 'today+7', 'today-1' (the creator's day, in their time zone)
 *   person → a member id or 'me' (the person who creates the row)
 * Text and URL defaults may contain template variables ({{date}}, {{author}}, {{input:…}}).
 * Relation and rollup fields have no defaults.
 */
export const rowTemplatePropsSchema = z
  .record(z.string().min(1).max(40), z.unknown())
  .refine((r) => Object.keys(r).length <= 200, { message: 'Too many properties' })

export const ROW_TEMPLATE_DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|today(?:[+-]\d{1,4})?)$/

export interface RowTemplateDTO {
  id: string
  collectionId: string
  name: string
  icon: string | null
  /** Title pattern, e.g. `{{date}} Meeting`. Empty = rows start untitled. */
  title: string
  /** Property defaults (see rowTemplatePropsSchema). */
  props: Record<string, unknown>
  isDefault: boolean
  sortOrder: number
  /** {{input:…}} prompts in the title, the text defaults and the body, in order of appearance. */
  inputs: TemplateInputDTO[]
  /** The body has content (more than one empty paragraph). */
  hasBody: boolean
  updatedAt: string
}

export interface RowTemplateListDTO {
  templates: RowTemplateDTO[]
  /** Id of the default template, or null (the "New row" button creates an empty row). */
  defaultId: string | null
}

/** One template with its body: `state` is a base64 Yjs (V1) update of the 'document' fragment. */
export interface RowTemplateBodyDTO {
  template: RowTemplateDTO
  state: string
}

export const createRowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(16).nullish(),
  title: z.string().max(300).optional(),
  props: rowTemplatePropsSchema.optional(),
  /** Start from an existing row of this collection: its body and property values are copied. */
  fromRowId: z.uuid().optional(),
  isDefault: z.boolean().optional(),
})
export type CreateRowTemplateInput = z.infer<typeof createRowTemplateSchema>

export const updateRowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().max(16).nullable().optional(),
  title: z.string().max(300).optional(),
  /** Replaces all defaults. */
  props: rowTemplatePropsSchema.optional(),
  /**
   * Body changes as a base64 Yjs update (the editor sends what changed since its last save). The
   * server merges it into the stored body, so two editors saving at once both keep their edits.
   */
  update: z.string().max(BODY_UPDATE_MAX_CHARS).optional(),
  /**
   * Document schema of the app that made `update` (0.20, docs/adr/2425-*); absent = 1 (0.19 and older).
   * An update from an app older than the body's newest node type is refused (409 SCHEMA_OUTDATED).
   */
  schema: z.number().int().min(1).max(9999).optional(),
  /** true makes this the collection's default (the previous default is cleared); false clears it. */
  isDefault: z.boolean().optional(),
  sortOrder: z.number().finite().optional(),
})
export type UpdateRowTemplateInput = z.infer<typeof updateRowTemplateSchema>

/**
 * POST /pages/:id/collection/rows: one new row. `template` omitted → the collection's default
 * template (none → an empty row); null → an empty row; an id → that template. `props` are applied
 * over the template's defaults (board column, calendar date, explicit values).
 */
export const createRowSchema = z.object({
  template: z.uuid().nullable().optional(),
  /** Row title. Empty or missing → the template's title pattern. */
  title: z.string().max(300).optional(),
  props: z.record(z.string().max(40), z.unknown()).optional(),
  /** Answers to {{input:…}} prompts; missing ones use the prompt's default. */
  inputs: templateInputsSchema.optional(),
  /** IANA time zone of the creator ('today', {{date}}). Invalid or missing → the server's TZ. */
  tz: z.string().max(64).optional(),
})
export type CreateRowInput = z.infer<typeof createRowSchema>

export interface CreateRowResultDTO {
  /** The created row (same shape as rows in GET /pages/:id/collection). */
  row: RowDTO
  /** Template applied, or null for an empty row. */
  templateId: string | null
  /** Where {{cursor}} was in the body. */
  cursor?: TemplateCursorDTO
}
