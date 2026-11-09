/**
 * Collection structure tools (docs/adr/1523-*): create_collection and update_fields.
 *
 * Both write through the routes the web app uses: POST /api/pages (kind collection: default
 * fields + a table view) and PUT /api/pages/:id/collection/fields, whose validation is the only
 * one that decides (relation targets and the hidden-target rule of docs/adr/1353-*, rollups,
 * two-way pairing, the edit lock and the write gate). The tools only map agent-friendly field
 * specs (names, no ids) onto the shared `CollectionField` shape and check what they can before
 * the first write, so a bad spec writes nothing. Views are not created here (the default table
 * view comes with every collection).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { fieldTypeSchema, rollupFnSchema, selectOptionSchema, updateFieldsSchema } from '@inkling/shared'
import type { CollectionField, PageMetaDTO, SelectOption } from '@inkling/shared'
import { call, text, ToolError, uuid, wrapWrite } from './core'
import type { McpServer, ToolCtx } from './core'
import { loadAgentContext, withApplies } from './agentContext'
import { cleanText, wrapUntrusted } from './trust'

const COLORS = selectOptionSchema.shape.color.options
type Color = (typeof COLORS)[number]

const optionSpec = z.union([
  z.string().trim().min(1).max(60),
  z.object({ name: z.string().trim().min(1).max(60), color: selectOptionSchema.shape.color.optional() }),
])

export const fieldSpecSchema = z.object({
  name: z.string().trim().min(1).max(60).describe('Property name (unique in the collection)'),
  type: fieldTypeSchema.describe('text, number, select, multiSelect, date, checkbox, person, url, relation, rollup'),
  options: z.array(optionSpec).max(50).optional().describe('select/multiSelect: option names (or { name, color })'),
  target: uuid().optional().describe('relation: id of the collection whose rows can be linked'),
  twoWay: z.boolean().optional().describe('relation: also add a mirrored relation on the target collection'),
  relation: z.string().trim().min(1).max(60).optional().describe('rollup: name of a relation property of this collection'),
  property: z.string().trim().min(1).max(60).optional().describe('rollup: property of the linked rows to aggregate ("title" for the row title)'),
  fn: rollupFnSchema.optional().describe('rollup: count, sum, avg, min, max, earliest, latest, percentChecked, showUnique'),
})
export type FieldSpec = z.infer<typeof fieldSpecSchema>

const newId = () => randomBytes(4).toString('hex')

interface CollectionDef {
  pageId: string
  fields: CollectionField[]
}

async function loadDef(ctx: ToolCtx, collectionId: string): Promise<CollectionDef> {
  const res = await call(ctx, 'GET', `/api/pages/${collectionId}/collection`, { query: { rows: '0' } })
  const { collection } = res.json() as { collection: CollectionDef }
  return collection
}

/** Target definitions of relation specs (visible collections only; same answer for hidden and missing). */
async function loadTargets(ctx: ToolCtx, specs: FieldSpec[], self: string | null): Promise<Map<string, CollectionField[]>> {
  const out = new Map<string, CollectionField[]>()
  for (const s of specs) {
    if (s.type !== 'relation' || !s.target || s.target === self || out.has(s.target)) continue
    try {
      out.set(s.target, (await loadDef(ctx, s.target)).fields)
    } catch {
      throw new ToolError(`Relation "${cleanText(s.name)}": target collection ${s.target} not found (not a collection you can see). Nothing was written.`)
    }
  }
  return out
}

function toOptions(list: FieldSpec['options'], keep: SelectOption[] = []): SelectOption[] {
  const out: SelectOption[] = []
  const seen = new Set<string>()
  for (const [i, o] of (list ?? []).entries()) {
    const name = typeof o === 'string' ? o : o.name
    const k = name.toLowerCase()
    if (seen.has(k)) throw new ToolError(`Option "${cleanText(name)}" is listed twice. Nothing was written.`)
    seen.add(k)
    const old = keep.find((x) => x.name.toLowerCase() === k)
    const color: Color = (typeof o === 'string' ? undefined : o.color) ?? old?.color ?? COLORS[i % COLORS.length]
    out.push({ id: old?.id ?? newId(), name, color })
  }
  return out
}

/**
 * Field specs → CollectionField list. `existing` are the fields kept (for names and rollups over
 * an existing relation); `self` is the collection id (null before it exists: a relation to itself
 * is not possible in create_collection).
 */
export function mapSpecs(
  specs: FieldSpec[],
  existing: CollectionField[],
  targets: Map<string, CollectionField[]>,
  self: string | null,
): CollectionField[] {
  const names = new Set(existing.map((f) => f.name.toLowerCase()))
  const out: CollectionField[] = []
  for (const s of specs) {
    if (s.name.toLowerCase() === 'title') throw new ToolError('"Title" is the row title, not a property. Nothing was written.')
    if (names.has(s.name.toLowerCase())) throw new ToolError(`A property named "${cleanText(s.name)}" already exists. Nothing was written.`)
    names.add(s.name.toLowerCase())
    const f: CollectionField = { id: newId(), name: s.name, type: s.type }
    if (s.type === 'select' || s.type === 'multiSelect') f.options = toOptions(s.options)
    else if (s.options?.length) throw new ToolError(`"${cleanText(s.name)}": options are only for select and multiSelect. Nothing was written.`)
    if (s.type === 'relation') {
      if (!s.target) throw new ToolError(`Relation "${cleanText(s.name)}" needs target (a collection id). Nothing was written.`)
      f.relation = { targetPageId: s.target, ...(s.twoWay ? { twoWay: true } : {}) }
    }
    out.push(f)
  }
  // rollups after relations, so they may use a relation added in the same call
  const all = [...existing, ...out]
  for (const s of specs) {
    if (s.type !== 'rollup') continue
    const f = out.find((x) => x.name === s.name)!
    if (!s.relation || !s.fn) throw new ToolError(`Rollup "${cleanText(s.name)}" needs relation (a relation property name) and fn. Nothing was written.`)
    const rel = all.find((x) => x.type === 'relation' && x.name.toLowerCase() === s.relation!.toLowerCase())
    if (!rel?.relation) throw new ToolError(`Rollup "${cleanText(s.name)}": no relation property "${cleanText(s.relation)}" in this collection. Nothing was written.`)
    const prop = (s.property ?? 'title').trim()
    let targetFieldId = 'title'
    if (prop.toLowerCase() !== 'title') {
      const defs = rel.relation.targetPageId === self ? all : targets.get(rel.relation.targetPageId)
      const tf = defs?.find((x) => x.name.toLowerCase() === prop.toLowerCase())
      if (!tf) throw new ToolError(`Rollup "${cleanText(s.name)}": the target collection has no property "${cleanText(prop)}". Nothing was written.`)
      targetFieldId = tf.id
    }
    f.rollup = { relationFieldId: rel.id, targetFieldId, fn: s.fn }
  }
  return out
}

/** Compact field list (names are member-written: the caller wraps it). */
export function fieldLines(fields: CollectionField[]): string[] {
  return fields.map((f) => {
    if (f.type === 'select' || f.type === 'multiSelect') return `- ${f.name} (${f.type}: ${(f.options ?? []).map((o) => o.name).join(', ') || 'no options'}) #${f.id}`
    if (f.type === 'relation') return `- ${f.name} (relation → ${f.relation?.targetPageId ?? '?'}${f.relation?.twoWay ? ', two-way' : ''}) #${f.id}`
    if (f.type === 'rollup') {
      const rel = fields.find((x) => x.id === f.rollup?.relationFieldId)
      return `- ${f.name} (rollup ${f.rollup?.fn ?? '?'} of ${rel?.name ?? '?'}.${f.rollup?.targetFieldId ?? '?'}, read-only) #${f.id}`
    }
    return `- ${f.name} (${f.type}) #${f.id}`
  })
}

function validate(fields: CollectionField[]): CollectionField[] {
  const r = updateFieldsSchema.safeParse({ fields })
  if (!r.success) {
    const i = r.error.issues[0]
    throw new ToolError(`Invalid fields: ${i ? `${i.path.join('.')}: ${i.message}` : 'validation failed'}. Nothing was written.`)
  }
  return r.data.fields as CollectionField[]
}

/** Field by name (case-insensitive) or #id. */
function findField(fields: CollectionField[], ref: string): CollectionField {
  const r = ref.trim()
  if (r.startsWith('#')) {
    const f = fields.find((x) => x.id === r.slice(1))
    if (f) return f
  }
  const hits = fields.filter((x) => x.name.toLowerCase() === r.toLowerCase())
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new ToolError(`${hits.length} properties are named "${cleanText(r)}"; use #id (${hits.map((h) => `#${h.id}`).join(', ')}). Nothing was written.`)
  throw new ToolError(`No property "${cleanText(r)}". Properties: ${fields.map((f) => cleanText(f.name)).join(', ') || '(none)'}. Nothing was written.`)
}

const SIMPLE = new Set(['text', 'number', 'select', 'multiSelect', 'date', 'checkbox', 'person', 'url'])

const changeSpec = z.object({
  field: z.string().trim().min(1).max(60).describe('Property name or #id'),
  name: z.string().trim().min(1).max(60).optional().describe('New name'),
  type: fieldTypeSchema.optional().describe('New type (between text, number, select, multiSelect, date, checkbox, person, url only)'),
  options: z.array(optionSpec).max(50).optional().describe('select/multiSelect: the full option list (existing names keep their ids and colors)'),
  addOptions: z.array(optionSpec).max(50).optional().describe('select/multiSelect: options to add'),
  removeOptions: z.array(z.string().trim().min(1).max(60)).max(50).optional().describe('select/multiSelect: option names to remove'),
  twoWay: z.boolean().optional().describe('relation: turn two-way on or off'),
})

export function applyChanges(
  current: CollectionField[],
  ops: {
    add?: FieldSpec[]
    change?: z.infer<typeof changeSpec>[]
    remove?: string[]
    order?: string[]
  },
  targets: Map<string, CollectionField[]>,
  self: string,
): { fields: CollectionField[]; summary: string[] } {
  let fields = current.map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}), ...(f.relation ? { relation: { ...f.relation } } : {}) }))
  const summary: string[] = []
  for (const ref of ops.remove ?? []) {
    const f = findField(fields, ref)
    const users = fields.filter((x) => x.type === 'rollup' && x.rollup?.relationFieldId === f.id && !(ops.remove ?? []).some((r) => findField(current, r).id === x.id))
    if (users.length) throw new ToolError(`"${cleanText(f.name)}" is used by rollup ${users.map((u) => `"${cleanText(u.name)}"`).join(', ')}; remove those too. Nothing was written.`)
    fields = fields.filter((x) => x.id !== f.id)
    summary.push(`removed "${f.name}"`)
  }
  for (const c of ops.change ?? []) {
    const f = findField(fields, c.field)
    if (c.name && c.name !== f.name) {
      if (c.name.toLowerCase() === 'title' || fields.some((x) => x.id !== f.id && x.name.toLowerCase() === c.name!.toLowerCase())) {
        throw new ToolError(`Cannot rename "${cleanText(f.name)}" to "${cleanText(c.name)}": that name is taken. Nothing was written.`)
      }
      summary.push(`renamed "${f.name}" → "${c.name}"`)
      f.name = c.name
    }
    if (c.type && c.type !== f.type) {
      if (!SIMPLE.has(c.type) || !SIMPLE.has(f.type)) {
        throw new ToolError(`"${cleanText(f.name)}": relation and rollup types cannot be switched; remove the property and add a new one. Nothing was written.`)
      }
      summary.push(`"${f.name}" type ${f.type} → ${c.type} (stored values stay; values that do not fit the new type are not shown)`)
      f.type = c.type
      if (c.type !== 'select' && c.type !== 'multiSelect') delete f.options
      else f.options ??= []
    }
    const isSelect = f.type === 'select' || f.type === 'multiSelect'
    if ((c.options || c.addOptions || c.removeOptions) && !isSelect) {
      throw new ToolError(`"${cleanText(f.name)}" is not a select or multiSelect property: it has no options. Nothing was written.`)
    }
    if (c.options) {
      f.options = toOptions(c.options, f.options ?? [])
      summary.push(`"${f.name}" options set (${f.options.length})`)
    }
    if (c.addOptions?.length) {
      const have = f.options ?? []
      const added = toOptions(c.addOptions).map((o, i) => ({ ...o, color: o.color ?? COLORS[(have.length + i) % COLORS.length] }))
      for (const o of added) {
        if (have.some((x) => x.name.toLowerCase() === o.name.toLowerCase())) throw new ToolError(`"${cleanText(f.name)}" already has option "${cleanText(o.name)}". Nothing was written.`)
      }
      f.options = [...have, ...added]
      summary.push(`"${f.name}" options added: ${added.map((o) => o.name).join(', ')}`)
    }
    if (c.removeOptions?.length) {
      const drop = new Set(c.removeOptions.map((n) => n.toLowerCase()))
      const missing = c.removeOptions.filter((n) => !(f.options ?? []).some((o) => o.name.toLowerCase() === n.toLowerCase()))
      if (missing.length) throw new ToolError(`"${cleanText(f.name)}" has no option ${missing.map((m) => `"${cleanText(m)}"`).join(', ')}. Nothing was written.`)
      f.options = (f.options ?? []).filter((o) => !drop.has(o.name.toLowerCase()))
      summary.push(`"${f.name}" options removed: ${c.removeOptions.join(', ')} (rows keep the stored value but show it empty)`)
    }
    if (c.twoWay !== undefined) {
      if (f.type !== 'relation' || !f.relation) throw new ToolError(`"${cleanText(f.name)}" is not a relation. Nothing was written.`)
      if (!!f.relation.twoWay !== c.twoWay) {
        f.relation = c.twoWay ? { targetPageId: f.relation.targetPageId, twoWay: true } : { targetPageId: f.relation.targetPageId, twoWay: false }
        summary.push(`"${f.name}" two-way ${c.twoWay ? 'on' : 'off'}`)
      }
    }
  }
  if (ops.add?.length) {
    const added = mapSpecs(ops.add, fields, targets, self)
    fields = [...fields, ...added]
    summary.push(`added ${added.map((f) => `"${f.name}"`).join(', ')}`)
  }
  if (ops.order?.length) {
    const first = ops.order.map((r) => findField(fields, r))
    const ids = new Set(first.map((f) => f.id))
    fields = [...first, ...fields.filter((f) => !ids.has(f.id))]
    summary.push('reordered')
  }
  return { fields, summary }
}

export function registerStructureTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'create_collection',
    {
      title: 'Create collection',
      description:
        'Create a collection (database) page with the given properties, in one call: ' +
        '{"name": "Status", "type": "select", "options": ["Todo", "Doing", "Done"]}, {"name": "Due", "type": "date"}, ' +
        '{"name": "Owner", "type": "person"}, {"name": "Project", "type": "relation", "target": "<collection id>", "twoWay": true}, ' +
        '{"name": "Tasks done", "type": "rollup", "relation": "Project", "property": "Done", "fn": "percentChecked"}. ' +
        'Rows always have a Title. Empty fields = the default Status/Assignee/Due properties. The collection gets a table view; ' +
        'views are edited in the app. With parentId it goes under that page (inheriting its section).',
      inputSchema: {
        workspaceId: uuid().describe('Workspace id'),
        title: z.string().trim().min(1).max(300).describe('Collection title'),
        fields: z.array(fieldSpecSchema).max(100).describe('Properties, in order (no Title: every row has one)'),
        parentId: uuid().optional().describe('Parent page id'),
        private: z.boolean().optional().describe('Create at the top level of the private (🔒) section (only without parentId)'),
      },
    },
    wrapWrite(ctx, async ({ workspaceId, title, fields, parentId, private: isPrivate }) => {
      if (isPrivate && parentId) throw new ToolError('private can only be used without parentId (child pages follow their parent section)')
      // Map and check everything before the first write.
      const targets = await loadTargets(ctx, fields, null)
      const mapped = fields.length ? validate(mapSpecs(fields, [], targets, null)) : null
      const created = (
        await call(ctx, 'POST', '/api/pages', {
          json: { workspaceId, kind: 'collection', title, ...(parentId ? { parentId } : {}), ...(isPrivate ? { scope: 'private' } : {}) },
        })
      ).json() as { page: PageMetaDTO }
      const id = created.page.id
      let stored: CollectionField[]
      if (mapped) {
        try {
          const res = await call(ctx, 'PUT', `/api/pages/${id}/collection/fields`, { json: { fields: mapped } })
          stored = (res.json() as { collection: CollectionDef }).collection.fields
        } catch (err) {
          // The page exists with default fields only: move it to the trash so nothing half-made stays in the tree.
          let trashed = true
          try {
            await call(ctx, 'DELETE', `/api/pages/${id}`)
          } catch {
            trashed = false
          }
          const msg = err instanceof ToolError ? err.message : 'internal error'
          throw new ToolError(
            `The properties were refused (${msg}). ` +
              (trashed
                ? `The new collection ${id} was moved to the trash; fix the fields and call create_collection again.`
                : `The new collection ${id} exists with default properties only; fix it with update_fields or trash it.`),
          )
        }
      } else {
        stored = (await loadDef(ctx, id)).fields
      }
      const ac = await loadAgentContext(ctx, [id])
      return text(
        withApplies(
          ac,
          [
            `Created collection ${id} (workspace ${created.page.workspaceId}${created.page.parentId ? `, under ${created.page.parentId}` : ''}) with ${stored.length} propert${stored.length === 1 ? 'y' : 'ies'} and a table view.`,
            wrapUntrusted([`Collection "${created.page.title || 'Untitled'}"`, '- Title (title)', ...fieldLines(stored)].join('\n'), { source: 'rows', id }),
            'Add rows with create_row; query_rows describe=true shows the schema.',
          ].join('\n'),
        ),
      )
    }),
  )

  server.registerTool(
    'update_fields',
    {
      title: 'Update collection properties',
      description:
        "Change a collection's properties: add (same specs as create_collection), change (rename, switch between simple " +
        'types, set/add/remove select options, two-way on/off), remove (property names or #id; the values stay stored in the ' +
        'rows but are no longer shown), order (names to put first). Applied together in one write; on any error nothing is ' +
        'written. Existing option names keep their ids, so row values survive renames of other options.',
      inputSchema: {
        collectionId: uuid().describe('Collection page id'),
        add: z.array(fieldSpecSchema).max(100).optional().describe('New properties'),
        change: z.array(changeSpec).max(100).optional().describe('Changes to existing properties'),
        remove: z.array(z.string().trim().min(1).max(60)).max(100).optional().describe('Property names (or #id) to remove'),
        order: z.array(z.string().trim().min(1).max(60)).max(200).optional().describe('Property names to put first, in this order'),
      },
      annotations: { destructiveHint: true },
    },
    wrapWrite(ctx, async ({ collectionId, add, change, remove, order }) => {
      if (!add?.length && !change?.length && !remove?.length && !order?.length) {
        throw new ToolError('Nothing to do: pass add, change, remove or order')
      }
      const def = await loadDef(ctx, collectionId)
      const targets = await loadTargets(ctx, add ?? [], collectionId)
      const { fields, summary } = applyChanges(def.fields, { add, change, remove, order }, targets, collectionId)
      const res = await call(ctx, 'PUT', `/api/pages/${collectionId}/collection/fields`, { json: { fields: validate(fields) } })
      const stored = (res.json() as { collection: CollectionDef }).collection.fields
      const ac = await loadAgentContext(ctx, [collectionId])
      return text(
        withApplies(
          ac,
          [
            `Updated the properties of collection ${collectionId}.`,
            wrapUntrusted([`Changes: ${summary.join('; ')}`, '- Title (title)', ...fieldLines(stored)].join('\n'), { source: 'rows', id: collectionId }),
          ].join('\n'),
        ),
      )
    }),
  )
}
