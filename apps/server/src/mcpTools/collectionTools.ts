/**
 * Collection (database) tools: query_rows, update_row, create_row (docs/adr/0934-*).
 *
 * Reads go through GET /api/pages/:id/collection/query and GET /api/pages/:id/row (filter, sort
 * and keyset pagination run in SQL; read-only tokens can use them). Writes go through the same
 * routes as the web app: PATCH /api/pages/:id/props (with the optional baseVersion check) and
 * POST /api/pages/:id/collection/rows (row templates, docs/adr/1181-*). Property names are mapped to field ids and values are
 * validated here (collectionQuery/values.ts) so a bad value is an error, never a silent drop.
 */
import { z } from 'zod'
import type { CollectionField, CreateRowResultDTO, RowTemplateListDTO } from '@inkling/shared'
import type { CollectionRowDTO, QueryRowsDTO } from '../routes/collectionQuery'
import { sanitizeBatchProps } from '../routes/collectionsExt'
import { opsHelp } from '../collectionQuery/filter'
import { describeField, mapWrite, needsMembers, ValueError } from '../collectionQuery/values'
import type { MappedWrite, Member } from '../collectionQuery/values'
import { call, text, ToolError, uuid, wrap, wrapWrite } from './core'
import { connectionKey } from '../leases'
import type { McpServer, ToolCtx } from './core'
import { loadAgentContext, pageFacts, withApplies } from './agentContext'
import { cleanText, wrapUntrusted } from './trust'
import { agentPropKey } from '@inkling/shared'
import { peopleStatusLine } from '../memberStatus'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const today = () => new Date().toISOString().slice(0, 10)

const FILTER_HELP =
  'Filter by property NAME: `Status = Done AND Due < 2026-12-01 AND Tags has urgent`, `Title ~ "deploy"`, ' +
  '`Owner = me`, `Due is empty`, `NOT (A = 1 OR B is not empty)`. Operators: = != < <= > >= ~ (contains) !~ has !has ' +
  '"is empty" "is not empty". Dates: YYYY-MM-DD or today / today+7 (UTC). Quote values containing AND/OR/operators.'

const OPS_SUMMARY = [
  `title/text/url: ${opsHelp('text')}`,
  `number/date: ${opsHelp('number')}`,
  `checkbox: = true|false, != true|false`,
  `select/person: ${opsHelp('select')} (person: me, member name, email or user id)`,
  `multiSelect/relation: ${opsHelp('multiSelect')} (relation: row title or row id)`,
  'rollup: read-only, not filterable',
].join('\n')

function rowLines(columns: string[], cells: string[]): string {
  const lines: string[] = []
  columns.forEach((c, i) => {
    if (cells[i]) lines.push(`${c}: ${cells[i]}`)
  })
  return lines.join('\n') || '(all properties empty)'
}

async function getRow(ctx: ToolCtx, rowId: string): Promise<CollectionRowDTO> {
  try {
    return (await call(ctx, 'GET', `/api/pages/${rowId}/row`)).json() as CollectionRowDTO
  } catch (err) {
    if (err instanceof ToolError && err.message.includes('NOT_A_ROW')) {
      throw new ToolError('That page is not a row of a collection; use read_page / update_page for documents')
    }
    throw err
  }
}

function conflictError(rowId: string, base: string, cur: CollectionRowDTO): ToolError {
  return new ToolError(
    `Version conflict: row ${rowId} changed since you read it (your baseVersion ${base}, current ${cur.row.version}). Nothing was written.\n` +
      `Current values:\n${rowLines(cur.columns, cur.row.cells)}\n` +
      `If your change still applies, retry update_row with baseVersion "${cur.row.version}".`,
  )
}

async function loadMembers(ctx: ToolCtx, workspaceId: string): Promise<Member[]> {
  const res = await call(ctx, 'GET', `/api/workspaces/${workspaceId}/members`)
  return (res.json() as { members: Member[] }).members
}

/**
 * Relation refs (row ids or exact titles, case-insensitive) → row ids of the target collection.
 * Titles are looked up with the relation picker route (visible rows only); one call per distinct title.
 */
async function resolveRelationRefs(ctx: ToolCtx, mapped: MappedWrite): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const errors: string[] = []
  for (const { field, refs } of mapped.relations) {
    const target = field.relation?.targetPageId
    if (!target) {
      errors.push(`"${field.name}" has no target collection configured`)
      continue
    }
    const ids: string[] = []
    for (const ref of [...new Set(refs)]) {
      if (UUID_RE.test(ref)) {
        ids.push(ref.toLowerCase())
        continue
      }
      const res = await call(ctx, 'GET', `/api/pages/${target}/collection/row-options`, { query: { q: ref, limit: '200' } })
      const rows = (res.json() as { rows: { id: string; title: string }[] }).rows
      const hits = rows.filter((r) => r.title.trim().toLowerCase() === ref.toLowerCase())
      if (hits.length === 1) ids.push(hits[0].id)
      else if (hits.length > 1) errors.push(`"${ref}" matches ${hits.length} rows in "${field.name}"; pass a row id: ${hits.map((h) => h.id).join(', ')}`)
      else errors.push(`No row titled "${ref}" in the target of "${field.name}"; use query_rows on that collection to find the row id`)
    }
    out[field.id] = ids
  }
  if (errors.length) throw new ToolError(errors.join('\n'))
  return out
}

/** Defensive: the values we send must survive the server's own sanitizer unchanged. */
function assertSanitized(fields: CollectionField[], props: Record<string, unknown>): void {
  const byId = new Map(fields.map((f) => [f.id, f]))
  const { set, del } = sanitizeBatchProps(byId, props)
  for (const [k, v] of Object.entries(props)) {
    // a person's agent next to a person cell: checked by the server (docs/adr/1864-*)
    if (k.startsWith('agent:')) continue
    const ok = v === null ? del.includes(k) : k in set
    if (!ok) throw new ToolError(`Value for "${byId.get(k)?.name ?? k}" was rejected; check its type with query_rows describe`)
  }
}

/** Relation links the server dropped (row not in the target collection or not visible). */
function droppedLinks(fields: CollectionField[], sent: Record<string, string[]>, stored: Record<string, unknown>): string[] {
  const notes: string[] = []
  for (const [fid, ids] of Object.entries(sent)) {
    const kept = new Set(Array.isArray(stored[fid]) ? (stored[fid] as string[]) : [])
    const lost = ids.filter((id) => !kept.has(id))
    if (lost.length) {
      const name = fields.find((f) => f.id === fid)?.name ?? fid
      notes.push(`Note: ${lost.length} link(s) in "${name}" were ignored (not a visible row of the target collection): ${lost.join(', ')}`)
    }
  }
  return notes
}

/**
 * Status of the people a write put in person cells (docs/adr/1846-*, 1870-*): the stored person of
 * each written person field (also when a person's agent connection was assigned: the cell holds its
 * person). The caller's own person is left out. null (no tokens, no statement) when nobody has one.
 */
async function assignedStatusLine(
  workspaceId: string,
  fields: CollectionField[],
  written: Record<string, unknown>,
  stored: Record<string, unknown>,
  self: string,
): Promise<string | null> {
  const ids = new Set<string>()
  for (const f of fields) {
    if (f.type !== 'person' || !(f.id in written || agentPropKey(f.id) in written)) continue
    const v = stored[f.id]
    if (typeof v === 'string' && v !== self) ids.add(v)
  }
  return ids.size ? peopleStatusLine(workspaceId, [...ids]) : null
}

async function loadRowTemplates(ctx: ToolCtx, collectionId: string): Promise<RowTemplateListDTO> {
  return (await call(ctx, 'GET', `/api/pages/${collectionId}/collection/row-templates`)).json() as RowTemplateListDTO
}

/** `template` argument → template id (null = empty row, undefined = the collection's default). */
function pickRowTemplate(list: RowTemplateListDTO, ref: string | undefined): string | null | undefined {
  if (ref === undefined) return undefined
  const r = ref.trim()
  if (r.toLowerCase() === 'none' || r === '') return null
  const byId = list.templates.find((t) => t.id === r.toLowerCase())
  if (byId) return byId.id
  const hits = list.templates.filter((t) => t.name.trim().toLowerCase() === r.toLowerCase())
  if (hits.length === 1) return hits[0].id
  const names = list.templates.map((t) => `"${cleanText(t.name)}" (${t.id})`).join(', ') || '(none)'
  if (hits.length > 1) throw new ToolError(`${hits.length} row templates are named "${cleanText(r)}"; pass an id: ${hits.map((h) => h.id).join(', ')}`)
  throw new ToolError(`No row template "${cleanText(r)}" in this collection. Templates: ${names}. Pass "none" for an empty row. Nothing was written.`)
}

/** One line per template for query_rows describe (ids outside, names are member-written). */
function templateLines(list: RowTemplateListDTO): string[] {
  if (list.templates.length === 0) return ['Row templates: (none; create_row makes empty rows)']
  return [
    'Row templates (create_row template=name or id; default applies when omitted, "none" = empty row):',
    ...list.templates.map(
      (t) =>
        `- ${cleanText(t.name)}${t.isDefault ? ' [default]' : ''} (${t.id})` +
        (t.inputs.length ? `; inputs: ${t.inputs.map((i) => cleanText(i.default ? `${i.name}|${i.default}` : i.name)).join('; ')}` : ''),
    ),
  ]
}

export function registerCollectionTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'query_rows',
    {
      title: 'Query collection rows',
      description:
        'Rows of a collection (database) filtered, sorted and paged on the server — much cheaper than read_page on large tables. ' +
        'Output: one line per row `rowId | version | Title | …` with only the requested fields, then `next cursor` if more rows match. ' +
        'Pass the version to update_row. ' +
        FILTER_HELP +
        ' Use describe=true for the field list (types, options) and the operators per type.',
      inputSchema: {
        collectionId: uuid().describe('Collection page id (kind "collection" in list_pages / search)'),
        filter: z.string().max(2000).optional().describe('e.g. Status = Done AND Due < today'),
        sort: z.string().max(300).optional().describe('e.g. "Due desc, Title" (max 3 keys; empty values last). Default: manual order'),
        fields: z
          .array(z.string().max(100))
          .max(200)
          .optional()
          .describe('Property names to show (Title is always first). ["*"] = all. Default: the first 4 fields + sort fields'),
        limit: z.number().int().min(1).max(200).optional().describe('Rows per page (default 25, max 200)'),
        cursor: z.string().max(8000).optional().describe('`next cursor` from the previous call (same filter and sort)'),
        describe: z.boolean().optional().describe('Only return the schema (fields, options, operators), no rows'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ collectionId, filter, sort, fields, limit, cursor, describe }) => {
      const query: Record<string, string> = {}
      if (describe) query.describe = '1'
      if (filter) query.filter = filter
      if (sort) query.sort = sort
      if (fields?.length) query.fields = JSON.stringify(fields)
      if (limit) query.limit = String(limit)
      if (cursor) query.cursor = cursor
      const res = await call(ctx, 'GET', `/api/pages/${collectionId}/collection/query`, { query })
      const r = res.json() as QueryRowsDTO
      const head = `Collection "${r.collection.title || 'Untitled'}" (${r.collection.id})`
      if (describe) {
        const tpls = await loadRowTemplates(ctx, r.collection.id)
        // Title, field names, option labels and template names are member-written: one data block
        // like the rows (docs/adr/0976-*, 1656-*); the fixed operator help stays outside it.
        return text(
          [
            wrapUntrusted(
              [
                head,
                'Fields:',
                '- Title (title)',
                ...r.fields.map((f) => `- ${describeField(f)}`),
                'Duplicate or reserved names: use #fieldId (ids: ' + r.fields.map((f) => `${f.name}=#${f.id}`).join(', ') + ')',
                ...templateLines(tpls),
              ].join('\n'),
              { source: 'rows', id: r.collection.id },
            ),
            'Operators:',
            OPS_SUMMARY,
          ].join('\n'),
        )
      }
      // Deterministic, prompt-cache friendly layout: the stable part (collection + schema) first,
      // then rows in SQL order (unique id tie-break), then the data-dependent footer. Nothing
      // time- or request-dependent is printed.
      // Member-written values (title, schema names, cells) sit inside one <untrusted_content> block
      // (docs/adr/0976-*); ids, counts and the cursor stay outside.
      const ac = await loadAgentContext(ctx, [r.collection.id], { read: true })
      const data = [head]
      if (!cursor) data.push(`Fields: ${r.fields.map((f) => describeField(f, 10)).join('; ') || '(none)'}`)
      data.push(['id', 'version', ...r.columns].join(' | '))
      for (const row of r.rows) data.push([row.id, row.version, ...row.cells].join(' | '))
      // statuses of the people in the shown person cells, once, last (docs/adr/1846-*); none = no line
      const others = (r.people ?? []).filter((id) => id !== ctx.user.id)
      const status = others.length ? await peopleStatusLine(r.workspaceId, others) : null
      const lines = [
        `collection ${r.collection.id}; can: ${pageFacts(ac, r.collection.id).can}`,
        wrapUntrusted(data.join('\n'), { source: 'rows', id: r.collection.id }),
        `${r.rows.length} row(s)${r.nextCursor ? ', more available' : ''}`,
        r.nextCursor ? `next cursor: ${r.nextCursor}` : '(end of results)',
        ...(status ? [status] : []),
      ]
      return text(withApplies(ac, lines.join('\n')))
    }),
  )

  server.registerTool(
    'update_row',
    {
      title: 'Update collection row',
      description:
        'Set properties of one collection row by property NAME: {"Status": "Done", "Due": "2026-12-01", "Tags": ["a","b"], ' +
        '"Owner": "me", "Project": ["Row title or id"], "Notes": null (clears)}. Select values are option names; relation values ' +
        'replace the links. baseVersion is the row version from query_rows: if the row changed since, nothing is written and the ' +
        'error shows the current values and version to retry with. Rollups are read-only; rename a row with rename_page.',
      inputSchema: {
        rowId: uuid().describe('Row id (first column of query_rows)'),
        properties: z.record(z.string().max(100), z.unknown()).describe('{ "Property name": value }'),
        baseVersion: z.string().min(1).max(64).describe('Row version from query_rows (second column)'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    wrapWrite(ctx, async ({ rowId, properties, baseVersion }) => {
      if (Object.keys(properties).length === 0) throw new ToolError('properties is empty; pass at least one { "Name": value }')
      const cur = await getRow(ctx, rowId)
      if (cur.row.version !== baseVersion) throw conflictError(rowId, baseVersion, cur)
      let mapped: MappedWrite
      try {
        const members = needsMembers(cur.fields, properties) ? await loadMembers(ctx, cur.workspaceId) : undefined
        mapped = mapWrite(cur.fields, properties, { userId: ctx.user.id, today: today(), members, connection: connectionKey(ctx.user) || null })
      } catch (err) {
        if (err instanceof ValueError) throw new ToolError(`${err.message}\nNothing was written.`)
        throw err
      }
      if (mapped.title !== undefined) throw new ToolError('update_row does not change the title; use rename_page. Nothing was written.')
      assertSanitized(cur.fields, mapped.props)
      const rel = await resolveRelationRefs(ctx, mapped)
      let res
      try {
        res = await call(ctx, 'PATCH', `/api/pages/${rowId}/props`, { json: { props: { ...mapped.props, ...rel }, baseVersion } })
      } catch (err) {
        if (err instanceof ToolError && err.message.includes('ROW_VERSION_CONFLICT')) {
          throw conflictError(rowId, baseVersion, await getRow(ctx, rowId))
        }
        throw err
      }
      const out = res.json() as { row: { props: Record<string, unknown> }; version: string }
      const changed = Object.entries(properties).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      const status = await assignedStatusLine(cur.workspaceId, cur.fields, mapped.props, out.row.props, ctx.user.id)
      return text(
        withApplies(await loadAgentContext(ctx, [rowId]), [
          `Updated row ${rowId} in "${cleanText(cur.collection.title || 'Untitled')}". New version: ${out.version}`,
          `Set: ${changed.join('; ')}`,
          ...droppedLinks(cur.fields, rel, out.row.props),
          ...(status ? [status] : []),
        ].join('\n')),
      )
    }),
  )

  server.registerTool(
    'create_row',
    {
      title: 'Create collection row',
      description:
        'Add a row to a collection. properties use property NAMES and the same value rules as update_row; they win over ' +
        'the template\'s defaults. template: a row template name or id (see query_rows describe=true); omitted = the ' +
        'collection\'s default template, "none" = an empty row. inputs answer the template\'s {{input:…}} prompts. ' +
        'Returns the new row id and version.',
      inputSchema: {
        collectionId: uuid().describe('Collection page id'),
        title: z.string().max(500).optional().describe('Row title (default: the template\'s title pattern)'),
        properties: z.record(z.string().max(100), z.unknown()).optional().describe('{ "Property name": value }'),
        template: z.string().max(100).optional().describe('Row template name or id; "none" = empty row; omitted = default template'),
        inputs: z.record(z.string().max(200), z.string().max(2000)).optional().describe('{ "Prompt": "answer" } for {{input:…}} prompts'),
      },
      annotations: { destructiveHint: false },
    },
    wrapWrite(ctx, async ({ collectionId, title, properties = {}, template, inputs }) => {
      const def = (
        await call(ctx, 'GET', `/api/pages/${collectionId}/collection/query`, { query: { describe: '1' } })
      ).json() as QueryRowsDTO
      const fields = def.definitions ?? []
      let mapped: MappedWrite
      try {
        const members = needsMembers(fields, properties) ? await loadMembers(ctx, def.workspaceId) : undefined
        mapped = mapWrite(fields, properties, { userId: ctx.user.id, today: today(), members, connection: connectionKey(ctx.user) || null })
      } catch (err) {
        if (err instanceof ValueError) throw new ToolError(`${err.message}\nNothing was written.`)
        throw err
      }
      const props = Object.fromEntries(Object.entries(mapped.props).filter(([, v]) => v !== null))
      assertSanitized(fields, props)
      const rel = await resolveRelationRefs(ctx, mapped)
      const relLinks = Object.fromEntries(Object.entries(rel).filter(([, ids]) => ids.length))
      const tpls = await loadRowTemplates(ctx, collectionId)
      const templateId = pickRowTemplate(tpls, template)
      const created = (
        await call(ctx, 'POST', `/api/pages/${collectionId}/collection/rows`, {
          json: {
            title: title ?? mapped.title ?? '',
            // relation links are written in the row's transaction (docs/adr/1524-*, AGENT-C2)
            props: { ...props, ...relLinks },
            ...(templateId !== undefined ? { template: templateId } : {}),
            ...(inputs ? { inputs } : {}),
          },
        })
      ).json() as CreateRowResultDTO
      const rowId = created.row?.id
      if (!rowId) throw new ToolError('The row was not created')
      // Agent assignments (docs/adr/1864-*) are checked by the props route, not by row creation.
      const agentProps = Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith('agent:')))
      let stored = (created.row.props ?? {}) as Record<string, unknown>
      if (Object.keys(agentProps).length) {
        stored = ((await call(ctx, 'PATCH', `/api/pages/${rowId}/props`, { json: { props: agentProps } })).json() as { row: { props: Record<string, unknown> } }).row.props
      }
      const status = await assignedStatusLine(def.workspaceId, fields, props, stored, ctx.user.id)
      const notes = droppedLinks(fields, relLinks, (created.row.props ?? {}) as Record<string, unknown>)
      const row = await getRow(ctx, rowId)
      const used = tpls.templates.find((t) => t.id === created.templateId)
      return text(
        withApplies(await loadAgentContext(ctx, [rowId]), [
          `Created row ${rowId} in "${cleanText(def.collection.title || 'Untitled')}". Version: ${row.row.version}`,
          used ? `Template: ${cleanText(used.name)} (${used.id})` : 'Template: none (empty row)',
          wrapUntrusted(rowLines(row.columns, row.row.cells), { source: 'rows', id: rowId }),
          ...notes,
          ...(status ? [status] : []),
        ].join('\n')),
      )
    }),
  )
}
