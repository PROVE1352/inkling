/**
 * Chart tools (docs/adr/1606-*): create_chart and create_view, and the data line read_page prints
 * under each chart token.
 *
 * create_chart writes nothing of its own: it maps names to ids, checks the config with the shared
 * schema and the data once through the aggregate route (as the token's user), then writes the
 * chart token through the routes patch_section / update_page use (POST /pages/:id/section, or
 * POST /pages/:id/content to append to the page). So the suggestion mode, edit policy, auto-accept
 * rules, locks and claims of 0.12 apply unchanged, and the token is parsed by the same notation
 * code as any other (md/notation.ts). create_view is POST /pages/:id/collection/views with the
 * new optional `config`.
 */
import { z } from 'zod'
import {
  CHART_BUCKETS,
  CHART_FNS,
  CHART_KINDS,
  CHART_SORTS,
  CHART_TITLE_FIELD,
  canonicalChartConfig,
  chartAggregateInput,
  chartBlockConfigSchema,
  chartOptionsSchema,
  chartSettingsSchema,
  chartSummaryLine,
  defaultFormSettings,
  FORM_FIELD_TYPES,
  formSettingsSchema,
  viewConfigSchema,
  viewTypeSchema,
} from '@inkling/shared'
import type { ChartBlockConfig, ChartDataDTO, ChartSettings, CollectionField, CollectionViewDTO, SuggestionDTO, ViewConfig } from '@inkling/shared'
import { call, text, ToolError, wrapWrite, idArg } from './core'
import type { McpServer, ToolCtx } from './core'
import { loadAgentContext, withApplies } from './agentContext'
import { suggestionMadeText } from './collabTools'
import { cleanText, wrapUntrusted } from './trust'
import { findVisiblePage } from '../pageDto'

/** Charts annotated per read (each is one aggregate). */
const MAX_ANNOTATED = 20
const TOKEN_LINE = /^([ \t>]*)<!--[ \t]*inkling:chart[ \t]+(\{.*\})[ \t]*-->[ \t]*$/gm

/** Text that can sit inside an HTML comment (no `--`, one line). */
function commentSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/-{2,}/g, (m) => m.split('').join(' '))
}

/** JSON for a token line: no `--` (so no `-->`) and no line breaks, as md/notation.ts writes it. */
function tokenJson(value: unknown): string {
  return JSON.stringify(value).replace(/--/g, '-\\u002d').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

async function aggregateFor(ctx: ToolCtx, workspaceId: string, cfg: ChartBlockConfig): Promise<{ data?: ChartDataDTO; error?: string }> {
  const res = await call(ctx, 'POST', `/api/workspaces/${workspaceId}/charts/aggregate`, {
    json: chartAggregateInput(cfg),
    passStatuses: [400, 403, 404],
  })
  if (res.statusCode === 200) return { data: res.json() as ChartDataDTO }
  if (res.statusCode === 404 || res.statusCode === 403) return { error: 'its data source is not visible to you (or was deleted)' }
  const body = res.json() as { error?: { message?: string } }
  return { error: body.error?.message ?? `HTTP ${res.statusCode}` }
}

/**
 * Under each chart token of a page read, one comment line with the chart's numbers for this
 * reader: `<!-- inkling:chart-data count by Status: Done 12, Todo 3 (15 rows) -->`. The line is an
 * HTML comment that is not a token, so writing the Markdown back drops it (the chart is unchanged).
 */
export async function annotateCharts(ctx: ToolCtx, workspaceId: string, markdown: string): Promise<string> {
  if (!markdown.includes('inkling:chart')) return markdown
  const lines = [...markdown.matchAll(TOKEN_LINE)].slice(0, MAX_ANNOTATED)
  if (!lines.length) return markdown
  const notes = new Map<string, string>()
  for (const m of lines) {
    if (notes.has(m[0])) continue
    let raw: unknown
    try {
      raw = JSON.parse(m[2])
    } catch {
      continue
    }
    const parsed = chartBlockConfigSchema.safeParse(raw)
    let note: string
    if (!parsed.success) note = 'not set up yet'
    else {
      const r = await aggregateFor(ctx, workspaceId, parsed.data)
      note = r.data ? chartSummaryLine(r.data) : `unavailable: ${r.error}`
    }
    notes.set(m[0], `${m[1]}<!-- inkling:chart-data ${commentSafe(note)} -->`)
  }
  return markdown.replace(TOKEN_LINE, (line) => (notes.has(line) ? `${line}\n${notes.get(line)}` : line))
}

const dimSpec = z.string().trim().min(1).max(200)

interface CollectionDef {
  pageId: string
  fields: CollectionField[]
  views: CollectionViewDTO[]
}

type FormArgs = {
  title?: string
  description?: string
  fields: { property: string; required?: boolean; description?: string }[]
  submitLabel?: string
  successMessage?: string
}

/** Form settings from names (docs/adr/1820-*): properties by name or id, 'title' for the row title. */
function toFormSettings(fields: CollectionField[], a: FormArgs) {
  const seen = new Set<string>()
  const out = a.fields.map((q) => {
    const id = fieldId(fields, q.property, 'form.fields')
    const f = fields.find((x) => x.id === id)
    if (f && !FORM_FIELD_TYPES.has(f.type)) {
      throw new ToolError(`form.fields: "${cleanText(f.name)}" is a ${f.type} property; a form asks for text, number, select, multiSelect, date, checkbox, url or person. Nothing was written.`)
    }
    if (seen.has(id)) throw new ToolError(`form.fields: "${cleanText(q.property)}" is listed twice. Nothing was written.`)
    seen.add(id)
    return { fieldId: id, ...(q.required ? { required: true } : {}), ...(q.description ? { description: q.description } : {}) }
  })
  const r = formSettingsSchema.safeParse({ ...a, fields: out })
  if (!r.success) throw new ToolError(`Invalid form settings: ${r.error.issues[0]?.message ?? 'bad settings'}. Nothing was written.`)
  return r.data
}

async function loadCollection(ctx: ToolCtx, collectionId: string): Promise<CollectionDef> {
  try {
    const res = await call(ctx, 'GET', `/api/pages/${collectionId}/collection`, { query: { rows: '0' } })
    return (res.json() as { collection: CollectionDef }).collection
  } catch {
    throw new ToolError(`Collection ${collectionId} not found (not a collection you can see). Nothing was written.`)
  }
}

/** A property by id or (case-insensitive) name; 'title' is the row title. */
function fieldId(fields: CollectionField[], ref: string, what: string): string {
  const byId = fields.find((f) => f.id === ref)
  if (byId) return byId.id
  const byName = fields.filter((f) => f.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0].id
  if (ref.toLowerCase() === CHART_TITLE_FIELD) return CHART_TITLE_FIELD
  const names = fields.map((f) => `"${cleanText(f.name)}" (${f.type})`).join(', ')
  throw new ToolError(`${what}: no property "${cleanText(ref)}"${byName.length > 1 ? ' (several have that name; pass its id)' : ''}. Properties: ${names || '(none)'}, or "title". Nothing was written.`)
}

const settingsInput = {
  kind: z.enum(CHART_KINDS).describe('barH is horizontal; heatmap needs series'),
  groupBy: dimSpec.describe('Property (name or id, "title" for the row title) or query column to group by'),
  bucket: z.enum(CHART_BUCKETS).optional().describe('date grouping'),
  series: dimSpec.optional().describe('Second grouping (stacked / grouped bars, several lines)'),
  seriesBucket: z.enum(CHART_BUCKETS).optional(),
  measure: z.enum(CHART_FNS).optional().describe('count (default), or an aggregate of measureField'),
  measureField: dimSpec.optional().describe('Number property (or query column) for sum / avg / min / max'),
  sort: z.enum(CHART_SORTS).optional().describe('auto (default): option / date order, else largest first'),
  limit: z.number().int().min(1).max(100).optional().describe('Groups drawn at most (default 12 for pies, 30 otherwise)'),
  title: z.string().trim().max(120).optional(),
  options: chartOptionsSchema.optional().describe('Chart library options, e.g. {"showLabels": false, "unit": "h"}'),
}
type SettingsArgs = {
  kind: ChartSettings['kind']
  groupBy: string
  bucket?: (typeof CHART_BUCKETS)[number]
  series?: string
  seriesBucket?: (typeof CHART_BUCKETS)[number]
  measure?: (typeof CHART_FNS)[number]
  measureField?: string
  sort?: (typeof CHART_SORTS)[number]
  limit?: number
  title?: string
  options?: Record<string, unknown>
}

/** Agent arguments → chart settings, names mapped to ids with `map` (identity for query columns). */
function toSettings(a: SettingsArgs, map: (ref: string, what: string) => string): ChartSettings {
  const measure = a.measure ?? 'count'
  if (measure !== 'count' && !a.measureField) throw new ToolError(`measure=${measure} needs measureField (a number property). Nothing was written.`)
  const s = {
    kind: a.kind,
    groupBy: { field: map(a.groupBy, 'groupBy'), ...(a.bucket ? { bucket: a.bucket } : {}) },
    ...(a.series ? { series: { field: map(a.series, 'series'), ...(a.seriesBucket ? { bucket: a.seriesBucket } : {}) } } : {}),
    ...(measure !== 'count' ? { measure: { fn: measure, field: map(a.measureField!, 'measureField') } } : {}),
    ...(a.sort ? { sort: a.sort } : {}),
    ...(a.limit ? { limit: a.limit } : {}),
    ...(a.title ? { title: a.title } : {}),
    ...(a.options ? { options: a.options } : {}),
  }
  const r = chartSettingsSchema.safeParse(s)
  if (!r.success) throw new ToolError(`Invalid chart: ${r.error.issues[0]?.message ?? 'bad settings'}. Nothing was written.`)
  return r.data
}

export function registerChartTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'create_chart',
    {
      title: 'Create chart',
      description:
        'Insert a chart block into a document page. Its data is a collection (optionally through one of its views\' filters) or a ' +
        'query block query, grouped by a property and counted or summed — always computed for whoever looks, never stored. ' +
        'Properties by name. section = §anchor to put it at the end of that section (placement=start: right after its heading, ' +
        'after: as new content after the section); without section it is appended to the page. Like patch_section, it may be ' +
        'kept as a suggestion (suggest=true, or the page/workspace policy). read_page shows charts as `<!-- inkling:chart {…} -->` ' +
        'with a data line under it.',
      inputSchema: {
        pageId: idArg('page').describe('Document page to insert into'),
        section: z.string().trim().min(1).max(500).optional().describe('Section anchor; omit to append to the page'),
        placement: z.enum(['end', 'start', 'after']).optional().describe('In the section: end (default), start, or after the section'),
        collectionId: idArg('page').optional().describe('Data source: a collection (use this or query)'),
        view: z.string().trim().min(1).max(100).optional().describe("Use this view's filters (view name or id of the collection)"),
        query: z.string().trim().min(1).max(2000).optional().describe('Data source: a query block query, e.g. TABLE Status, Points FROM "Roadmap"'),
        ...settingsInput,
        suggest: z.boolean().optional().describe('true: leave it as a suggestion for a person (needs section)'),
      },
    },
    wrapWrite(ctx, async (args: SettingsArgs & { pageId: string; section?: string; placement?: 'end' | 'start' | 'after'; collectionId?: string; view?: string; query?: string; suggest?: boolean }) => {
      if (!!args.collectionId === !!args.query) throw new ToolError('Give exactly one data source: collectionId or query. Nothing was written.')
      if (args.suggest && !args.section) throw new ToolError('suggest needs a section (§anchor) to suggest into. Nothing was written.')
      const page = await findVisiblePage(args.pageId, ctx.user.id)
      if (!page) throw new ToolError('Page not found or not visible to you; use find_context to get a valid id. Nothing was written.')
      if (page.kind !== 'doc') throw new ToolError(`Charts go into document pages; this page is a ${page.kind}. For a collection use create_view(type="chart"). Nothing was written.`)

      let cfg: ChartBlockConfig
      if (args.collectionId) {
        const def = await loadCollection(ctx, args.collectionId)
        let viewId: string | undefined
        if (args.view) {
          const v = def.views.find((x) => x.id === args.view) ?? def.views.filter((x) => x.name.toLowerCase() === args.view!.toLowerCase())[0]
          if (!v) throw new ToolError(`View "${cleanText(args.view)}" not found; views: ${def.views.map((x) => `"${cleanText(x.name)}"`).join(', ')}. Nothing was written.`)
          viewId = v.id
        }
        const settings = toSettings(args, (ref, what) => fieldId(def.fields, ref, what))
        cfg = { source: { type: 'collection', collectionId: def.pageId, ...(viewId ? { viewId } : {}) }, ...settings }
      } else {
        cfg = { source: { type: 'query', query: args.query! }, ...toSettings(args, (ref) => ref) }
      }
      cfg = canonicalChartConfig(chartBlockConfigSchema.parse(cfg))

      // the data once, as this user: a source they cannot see or a bad field writes nothing
      const check = await aggregateFor(ctx, page.workspaceId, cfg)
      if (!check.data) throw new ToolError(`Cannot chart this: ${check.error}. Nothing was written.`)

      const markdown = `<!-- inkling:chart ${tokenJson(cfg)} -->`
      let written
      if (args.section) {
        const mode = args.placement === 'start' ? 'prepend' : args.placement === 'after' ? 'insert_after' : 'append'
        written = await call(ctx, 'POST', `/api/pages/${page.id}/section`, {
          json: { ref: args.section, markdown, mode, ...(args.suggest ? { suggest: true } : {}) },
        })
      } else {
        written = await call(ctx, 'POST', `/api/pages/${page.id}/content`, { json: { markdown, mode: 'append' } })
      }
      if (written.statusCode === 202) return text(suggestionMadeText((written.json() as { suggestion: SuggestionDTO }).suggestion))
      const ac = await loadAgentContext(ctx, [page.id])
      const where = args.section ? `§${(written.json() as { section?: { anchor: string } | null }).section?.anchor ?? args.section}` : 'the end of the page'
      return text(
        withApplies(
          ac,
          `Chart inserted at ${where}.\ndata: ` +
            wrapUntrusted(chartSummaryLine(check.data), { source: 'page', id: page.id }) +
            `\ntoken: ${markdown}`,
        ),
      )
    }),
  )

  server.registerTool(
    'create_view',
    {
      title: 'Create view',
      description:
        'Add a view to a collection. config is optional; property names are accepted wherever a field id goes ' +
        '(groupByFieldId, dateFieldId, startFieldId, endFieldId, sorts/filters fieldId). type=chart needs chart; it draws the ' +
        "rows the view's filters keep. type=form takes form (without it the form asks for the title and the first properties); " +
        'a form adds rows, and an owner or admin turns on its public link in the app.',
      inputSchema: {
        collectionId: idArg('page').describe('Collection id'),
        type: viewTypeSchema,
        name: z.string().trim().min(1).max(60).describe('View name'),
        config: z.record(z.string(), z.unknown()).optional().describe('View config (sorts, filters, groupByFieldId, dateFieldId, …)'),
        // create_chart's settings, checked in the handler (docs/adr/1945-*: one copy in the tool list)
        chart: z.record(z.string(), z.unknown()).optional().describe("create_chart's settings: kind, groupBy, bucket, series, measure, measureField, sort, limit, title, options"),
        form: z
          .object({
            title: z.string().max(200).optional(),
            description: z.string().max(2000).optional(),
            fields: z
              .array(
                z.object({
                  property: z.string().min(1).max(60).describe('Property name or id, or "title" for the row title'),
                  required: z.boolean().optional(),
                  description: z.string().max(500).optional().describe('Help text under the question'),
                }),
              )
              .max(50),
            submitLabel: z.string().max(60).optional(),
            successMessage: z.string().max(500).optional(),
          })
          .optional()
          .describe('type=form: the questions, in order (text, number, select, multiSelect, date, checkbox, url, person)'),
      },
    },
    wrapWrite(ctx, async ({ collectionId, type, name, config, chart: chartRaw, form }: { collectionId: string; type: z.infer<typeof viewTypeSchema>; name: string; config?: Record<string, unknown>; chart?: Record<string, unknown>; form?: FormArgs }) => {
      let chart: SettingsArgs | undefined
      if (chartRaw) {
        const p = z.object(settingsInput).safeParse(chartRaw)
        if (!p.success) {
          const i = p.error.issues[0]
          throw new ToolError(`Invalid chart settings: ${i ? `${i.path.join('.')}: ${i.message}` : 'bad settings'}. Nothing was written.`)
        }
        chart = p.data as SettingsArgs
      }
      if (chart && type !== 'chart') throw new ToolError('chart settings are for type="chart". Nothing was written.')
      if (form && type !== 'form') throw new ToolError('form settings are for type="form". Nothing was written.')
      if (type === 'chart' && !chart) throw new ToolError('type="chart" needs chart settings (at least kind and groupBy). Nothing was written.')
      const def = await loadCollection(ctx, collectionId)
      const id = (ref: unknown, what: string) => (typeof ref === 'string' ? fieldId(def.fields, ref, what) : ref)
      const c: Record<string, unknown> = { ...(config ?? {}) }
      for (const k of ['groupByFieldId', 'dateFieldId', 'startFieldId', 'endFieldId']) if (c[k] !== undefined) c[k] = id(c[k], k)
      for (const k of ['sorts', 'filters']) {
        if (Array.isArray(c[k])) c[k] = (c[k] as Record<string, unknown>[]).map((x) => (x && typeof x === 'object' ? { ...x, fieldId: id(x.fieldId, `${k}.fieldId`) } : x))
      }
      if (chart) c.chart = canonicalChartConfig(toSettings(chart, (ref, what) => fieldId(def.fields, ref, what)))
      if (type === 'form') c.form = form ? toFormSettings(def.fields, form) : defaultFormSettings(def.fields)
      const parsed = viewConfigSchema.safeParse(c)
      if (!parsed.success) {
        const i = parsed.error.issues[0]
        throw new ToolError(`Invalid view config: ${i ? `${i.path.join('.')}: ${i.message}` : 'bad config'}. Nothing was written.`)
      }
      const res = await call(ctx, 'POST', `/api/pages/${collectionId}/collection/views`, { json: { name, type, config: parsed.data as ViewConfig } })
      const view = (res.json() as { view: CollectionViewDTO }).view
      const ac = await loadAgentContext(ctx, [collectionId])
      let tail = ''
      if (view.type === 'chart' && view.config.chart) {
        const r = await aggregateFor(ctx, (await findVisiblePage(collectionId, ctx.user.id))?.workspaceId ?? '', {
          source: { type: 'collection', collectionId, viewId: view.id },
          ...view.config.chart,
        })
        tail = r.data ? `\ndata: ${wrapUntrusted(chartSummaryLine(r.data), { source: 'page', id: collectionId })}` : `\ndata: unavailable (${r.error})`
      }
      if (view.type === 'form') {
        const asked = (view.config.form?.fields ?? []).map((q) => {
          const f = def.fields.find((x) => x.id === q.fieldId)
          return `${f ? cleanText(f.name) : 'Title'}${q.required ? '*' : ''}`
        })
        tail = `\nasks: ${asked.join(', ') || '(nothing)'} (* = required). Members fill it in the app; an owner or admin can turn on its public link.`
      }
      return text(withApplies(ac, `View "${cleanText(view.name)}" (${view.type}) created: id ${view.id}.${tail}`))
    }),
  )
}
