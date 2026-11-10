import { z } from 'zod'

// ---------------------------------------------------------------------------
// Page templates (docs/adr/0920-0925, docs/TEMPLATES.md)
//
// Built-ins are code constants (id = key); custom templates live in the `templates` table
// (id = uuid). A template is either a single document or a structure: a page tree with
// sub-pages, folders, collections (fields, views, optional starter rows) and canvases.
//
// This module must not import from './index' (index re-exports it; a cycle would hit the TDZ).
// ---------------------------------------------------------------------------

/** Built-in template keys (code constants, never seeded into the DB). */
export const builtinTemplateKeySchema = z.enum([
  // documents
  'meeting',
  'brainstorm',
  'kickoff',
  'standup',
  'retro',
  // structures
  'project',
  'meetingSeries',
  'readingList',
  'weeklyReview',
  // 0.17: tasks with sub-tasks for a team of agents (docs/adr/2147-*)
  'agentBoard',
])
export type BuiltinTemplateKey = z.infer<typeof builtinTemplateKeySchema>

/** Gallery categories. Custom templates default to 'custom'. */
export const templateCategorySchema = z.enum(['docs', 'projects', 'meetings', 'personal', 'custom'])
export type TemplateCategory = z.infer<typeof templateCategorySchema>
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = templateCategorySchema.options

/** Hard limits of a structure template (save, import and instantiate). */
export const TEMPLATE_MAX_PAGES = 200
/** Levels below the template root (0 = a single page). Placement still obeys the tree depth cap. */
export const TEMPLATE_MAX_HEIGHT = 12
/** At most this many distinct {{input:…}} prompts per template. */
export const TEMPLATE_MAX_INPUTS = 20

/** One `{{input:Question|default}}` prompt, asked in the gallery before creating. */
export interface TemplateInputDTO {
  /** The question text (also the key in `inputs` when creating). */
  name: string
  /** Value used when the prompt is left empty. */
  default: string
}

/** Gallery/list item. Built-ins have id = key (e.g. 'meeting'), custom ones id = uuid. */
export interface TemplateDTO {
  id: string
  builtin: boolean
  name: string
  description: string | null
  icon: string | null
  category: TemplateCategory
  /** 'doc' = one document page; 'structure' = a page tree (sub-pages, collections, canvases). */
  kind: 'doc' | 'structure'
  /** Pages one instantiation creates (1 for a document template). */
  pageCount: number
  /** shared = every member; private = creator only. Built-ins: 'shared'. */
  scope: 'shared' | 'private'
  /** Created by the viewer (custom templates only). */
  mine: boolean
  /** defaultProps.withDate: the created root page gets a date property (meeting notes, standup). */
  withDate: boolean
  /** {{input:…}} prompts, in order of first appearance. */
  inputs: TemplateInputDTO[]
}

/** One block of a template preview (plain text — rendered by the client, never as HTML). */
export interface TemplatePreviewBlockDTO {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'number' | 'check' | 'quote' | 'code' | 'table' | 'other'
  text: string
  checked?: boolean
  /** Nesting level of list items (0 = top). */
  depth: number
}

/** One page of a structure template preview outline. */
export interface TemplatePreviewNodeDTO {
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  title: string
  icon: string | null
  depth: number
  /** Collections: number of fields / views / starter rows. */
  fields?: number
  views?: string[]
  rows?: number
}

export interface TemplatePreviewDTO {
  /** First blocks of the root document (empty for a folder/collection root). */
  blocks: TemplatePreviewBlockDTO[]
  /** Whether the root document has more blocks than shown. */
  truncated: boolean
  /** Page outline (root first, depth-first). One entry for a document template. */
  outline: TemplatePreviewNodeDTO[]
}

/** Save a page (optionally with its sub-pages) as a custom template. */
export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  icon: z.string().max(16).optional(),
  category: templateCategorySchema.optional(),
  fromPageId: z.uuid(),
  /** Include sub-pages, folders, canvases and collections under the page (default false). */
  includeSubpages: z.boolean().optional(),
  /** Keep collection rows as starter rows (default false: fields and views only). */
  includeRows: z.boolean().optional(),
  /** Only me. A template saved from a private page is always private. */
  private: z.boolean().optional(),
})
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>

/** Values for {{input:…}} prompts: question → answer. */
export const templateInputsSchema = z
  .record(z.string().max(200), z.string().max(2000))
  .refine((r) => Object.keys(r).length <= TEMPLATE_MAX_INPUTS, { message: 'Too many inputs' })

/** Create a page (tree) from a template: exactly one of templateId (custom) or builtinKey (built-in). */
export const createPageFromTemplateSchema = z
  .object({
    workspaceId: z.uuid(),
    parentId: z.uuid().nullish(),
    /** Only meaningful without parentId: the section to create the root page in (children inherit the parent's scope) */
    scope: z.enum(['shared', 'private']).optional(),
    /** {{date}} and the date property of withDate templates (YYYY-MM-DD). Defaults to today in `tz`. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** Root page title and the {{title}} value. Defaults to the template's root title. */
    title: z.string().max(300).optional(),
    templateId: z.uuid().optional(),
    builtinKey: builtinTemplateKeySchema.optional(),
    /** Answers to {{input:…}} prompts. Missing ones use the prompt's default. */
    inputs: templateInputsSchema.optional(),
    /** IANA time zone of the creator (today/{{time}}). Invalid or missing → the server's TZ. */
    tz: z.string().max(64).optional(),
  })
  .refine((d) => Boolean(d.templateId) !== Boolean(d.builtinKey), {
    message: 'Specify exactly one of templateId or builtinKey',
  })
export type CreatePageFromTemplateInput = z.infer<typeof createPageFromTemplateSchema>

/** Where {{cursor}} ended up after instantiation (the client puts the caret there). */
export interface TemplateCursorDTO {
  pageId: string
  blockId: string
  /** Character offset inside the block's text. */
  offset: number
}
