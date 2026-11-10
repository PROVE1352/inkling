/**
 * Relation / rollup support for collections (docs/adr/0300, 0301).
 *
 * Storage: a relation value is a string[] of row (page) ids kept in the row's `props`, like every
 * other property. Rollups are never stored; they are computed per request from the linked rows.
 *
 * Read path cost is independent of the row count in query terms: one query for all linked rows
 * (chunked IN lists), one for the target collections' field definitions and, only when a
 * "show unique" rollup aggregates a person field, one for user names. Everything else is in-memory
 * aggregation, O(total links).
 *
 * Visibility: linked rows are loaded with `visibleTo(user)` + `deleted_at IS NULL` and must be a
 * child of the relation's target collection in the same workspace. Anything else is dropped from
 * the response, so a viewer never learns that a hidden/trashed row exists.
 */
import { actorFor, assertAllEditable, roleForPage } from './editLock'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { applyFormulas, compileFormulas, FORMULA_LIMITS, isAutoFieldType, renameFormulaProps } from '@inkling/shared'
import type {
  CollectionField,
  FormulaErrorCode,
  RollupConfig,
  RowRefDTO,
} from '@inkling/shared'
import { db } from './db/index'
import { collections, pages, users } from './db/schema'
import { visibleTo } from './pageDto'

type Exec = Pick<typeof db, 'select' | 'update' | 'execute'>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** max links kept in one relation cell */
export const RELATION_MAX_LINKS = 500
const IN_CHUNK = 5000

export function relationFields(fields: CollectionField[]): CollectionField[] {
  return fields.filter((f) => f.type === 'relation' && f.relation?.targetPageId)
}

export function isComputedField(f: CollectionField | undefined): boolean {
  return f?.type === 'rollup' || f?.type === 'formula' || isAutoFieldType(f?.type)
}

/** Normalize an arbitrary prop value to a deduplicated list of uuid strings. */
export function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of value) {
    if (typeof v !== 'string' || !UUID_RE.test(v)) continue
    const id = v.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= RELATION_MAX_LINKS) break
  }
  return out
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

type LinkedRow = RowRefDTO & { workspaceId: string; props: Record<string, unknown> }

/** Load linked rows visible to `userId` (chunked IN lists → a handful of queries at most). */
async function loadLinkedRows(
  ids: string[],
  userId: string,
  withProps: boolean,
): Promise<Map<string, LinkedRow>> {
  const out = new Map<string, LinkedRow>()
  for (const part of chunks(ids, IN_CHUNK)) {
    const rows = await db
      .select({
        id: pages.id,
        title: pages.title,
        icon: pages.icon,
        parentId: pages.parentId,
        workspaceId: pages.workspaceId,
        props: withProps ? pages.props : sql<unknown>`'{}'::jsonb`,
      })
      .from(pages)
      .where(and(inArray(pages.id, part), isNull(pages.deletedAt), visibleTo(userId)))
    for (const r of rows) {
      out.set(r.id, { ...r, props: (r.props ?? {}) as Record<string, unknown> })
    }
  }
  return out
}

export interface ResolvedRelations {
  /** visible linked rows referenced by any relation cell in the response */
  refs: Record<string, RowRefDTO>
  /** formula errors by row id, then field id (rows without errors are absent; docs/adr/1825-*) */
  formulaErrors: Map<string, Record<string, FormulaErrorCode>>
}

/**
 * Sanitize relation cells, compute rollups and then formulas for the rows of one collection, in
 * place. `rows[i].props` is mutated: relation arrays are filtered to visible links, rollup and
 * formula values set (formulas last: they may read rollups). Stored values under a formula's id are
 * always replaced (a formula is never stored).
 */
export async function resolveRelations(
  workspaceId: string,
  fields: CollectionField[],
  rows: { id: string; title?: string; props: Record<string, unknown> }[],
  userId: string,
  opts: { now?: Date } = {},
): Promise<ResolvedRelations> {
  const { refs } = await resolveLinks(workspaceId, fields, rows, userId)
  return { refs, formulaErrors: computeFormulas(fields, rows, opts.now) }
}

/** Formula values into `rows[i].props` (after relations and rollups); errors by row id. */
export function computeFormulas(
  fields: CollectionField[],
  rows: { id: string; title?: string; props: Record<string, unknown> }[],
  now: Date = new Date(),
): Map<string, Record<string, FormulaErrorCode>> {
  if (!fields.some((f) => f.type === 'formula')) return new Map()
  const compiled = compileFormulas(fields)
  // RowDTO-like rows carry a title; the rest read prop("Title") as empty
  const view = rows.map((r) => ({ id: r.id, title: r.title ?? '', props: r.props }))
  return applyFormulas(fields, view, { now }, compiled)
}

/** Whether a formula of this list reads a relation or a rollup (then rollups must be computed first). */
export function formulasNeedLinks(fields: CollectionField[]): boolean {
  if (!fields.some((f) => f.type === 'formula')) return false
  const compiled = compileFormulas(fields)
  const byId = new Map(fields.map((f) => [f.id, f]))
  return compiled.list.some((c) => c.deps.some((d) => byId.get(d)?.type === 'rollup'))
}

async function resolveLinks(
  workspaceId: string,
  fields: CollectionField[],
  rows: { id: string; props: Record<string, unknown> }[],
  userId: string,
): Promise<{ refs: Record<string, RowRefDTO> }> {
  const rels = relationFields(fields)
  const rollups = fields.filter((f) => f.type === 'rollup' && f.rollup)
  // Rollups whose relation is missing → null value; still strip any stale stored value.
  if (rels.length === 0) {
    for (const r of rows) for (const f of rollups) r.props[f.id] = null
    return { refs: {} }
  }

  const all = new Set<string>()
  for (const row of rows) {
    for (const f of rels) for (const id of idList(row.props[f.id])) all.add(id)
  }
  const linked = all.size
    ? await loadLinkedRows([...all], userId, rollups.length > 0)
    : new Map<string, LinkedRow>()

  // Target collection definitions (for rollup target field types / select option names).
  const targetIds = [...new Set(rels.map((f) => f.relation!.targetPageId))]
  const targetFields = new Map<string, CollectionField[]>()
  if (rollups.length && targetIds.length) {
    const defs = await db
      .select({ pageId: collections.pageId, fields: collections.fields })
      .from(collections)
      .where(inArray(collections.pageId, targetIds))
    for (const d of defs) targetFields.set(d.pageId, (d.fields ?? []) as CollectionField[])
  }

  const refs: Record<string, RowRefDTO> = {}
  const relById = new Map(rels.map((f) => [f.id, f]))
  for (const row of rows) {
    for (const f of rels) {
      const target = f.relation!.targetPageId
      const kept: string[] = []
      for (const id of idList(row.props[f.id])) {
        const t = linked.get(id)
        if (!t || t.parentId !== target || t.workspaceId !== workspaceId) continue
        kept.push(id)
        if (!refs[id]) refs[id] = { id: t.id, title: t.title, icon: t.icon, parentId: t.parentId }
      }
      if (row.props[f.id] !== undefined) row.props[f.id] = kept
    }
  }

  // person names for "show unique" over person fields — one query, only if needed
  let personNames: Map<string, string> | null = null
  const needsPeople = rollups.some((f) => {
    const rel = relById.get(f.rollup!.relationFieldId)
    if (!rel || f.rollup!.fn !== 'showUnique') return false
    const tf = targetFields.get(rel.relation!.targetPageId)?.find((x) => x.id === f.rollup!.targetFieldId)
    return tf?.type === 'person'
  })
  if (needsPeople) {
    const ids = new Set<string>()
    for (const t of linked.values()) for (const v of Object.values(t.props)) if (typeof v === 'string' && UUID_RE.test(v)) ids.add(v)
    personNames = new Map()
    for (const part of chunks([...ids], IN_CHUNK)) {
      // Names of workspace members only: a person cell holding any other user's id must not
      // reveal that user's name (C-L11).
      const us = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, part), isWorkspaceMember(workspaceId)))
      for (const u of us) personNames.set(u.id, u.name)
    }
  }

  for (const f of rollups) {
    const cfg = f.rollup!
    const rel = relById.get(cfg.relationFieldId)
    if (!rel) {
      for (const r of rows) r.props[f.id] = null
      continue
    }
    const tf =
      cfg.targetFieldId === 'title'
        ? ({ id: 'title', name: 'Title', type: 'text' } as CollectionField)
        : targetFields.get(rel.relation!.targetPageId)?.find((x) => x.id === cfg.targetFieldId)
    for (const row of rows) {
      const ids = Array.isArray(row.props[rel.id]) ? (row.props[rel.id] as string[]) : []
      const targets = ids.map((id) => linked.get(id)).filter((t): t is LinkedRow => !!t)
      row.props[f.id] = computeRollup(cfg, tf, targets, personNames)
    }
  }
  return { refs }
}

function displayValues(
  tf: CollectionField,
  t: LinkedRow,
  personNames: Map<string, string> | null,
): string[] {
  const v = tf.id === 'title' ? t.title : t.props[tf.id]
  if (v === undefined || v === null || v === '') return []
  switch (tf.type) {
    case 'select':
      return [tf.options?.find((o) => o.id === v)?.name ?? ''].filter(Boolean)
    case 'multiSelect':
      return Array.isArray(v)
        ? v.map((id) => tf.options?.find((o) => o.id === id)?.name ?? '').filter(Boolean)
        : []
    case 'person':
      return [personNames?.get(String(v)) ?? ''].filter(Boolean)
    case 'checkbox':
      return [v ? 'Checked' : 'Unchecked']
    default:
      return Array.isArray(v) ? v.map(String) : [String(v)]
  }
}

/** Pure aggregation — exported for unit-style smoke checks. */
export function computeRollup(
  cfg: RollupConfig,
  tf: CollectionField | undefined,
  targets: LinkedRow[],
  personNames: Map<string, string> | null = null,
): number | string | string[] | null {
  if (cfg.fn === 'count') return targets.length
  // depth-1 rule: never aggregate another computed/relation field (cycle-free by construction);
  // a formula of the target is not computed for linked rows either (docs/adr/1824-*)
  if (!tf || tf.type === 'rollup' || tf.type === 'relation' || tf.type === 'formula' || isAutoFieldType(tf.type)) return null
  const raw = targets.map((t) => (tf.id === 'title' ? t.title : t.props[tf.id]))
  switch (cfg.fn) {
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      const nums = raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (nums.length === 0) return null
      if (cfg.fn === 'sum') return round(nums.reduce((a, b) => a + b, 0))
      if (cfg.fn === 'avg') return round(nums.reduce((a, b) => a + b, 0) / nums.length)
      // reduce (not Math.min(...spread)) — spreading thousands of args can overflow the stack
      return cfg.fn === 'min'
        ? nums.reduce((a, b) => (b < a ? b : a))
        : nums.reduce((a, b) => (b > a ? b : a))
    }
    case 'earliest':
    case 'latest': {
      const ds = raw.filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
      if (ds.length === 0) return null
      return ds.reduce((a, b) => (cfg.fn === 'earliest' ? (b < a ? b : a) : b > a ? b : a))
    }
    case 'percentChecked': {
      if (targets.length === 0) return null
      const on = raw.filter((v) => v === true).length
      return round((on / targets.length) * 100)
    }
    case 'showUnique': {
      const seen = new Set<string>()
      for (const t of targets) for (const s of displayValues(tf, t, personNames)) seen.add(s)
      return [...seen]
    }
    default:
      return null
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Normalize a relation write: keep only ids that are live, visible rows of the target collection
 * (silently dropping the rest) and PRESERVE existing links the writer cannot see (hidden or
 * trashed rows), so editing a cell never destroys links made by someone with more access.
 */
export async function normalizeRelationWrite(
  exec: Exec,
  field: CollectionField,
  oldValue: unknown,
  newValue: unknown,
  userId: string,
): Promise<string[]> {
  const target = field.relation!.targetPageId
  const submitted = idList(newValue)
  const old = idList(oldValue)
  const candidates = [...new Set([...submitted, ...old])]
  if (candidates.length === 0) return []
  const rows = await exec
    .select({
      id: pages.id,
      visible: sql<boolean>`(${pages.deletedAt} IS NULL AND ${visibleTo(userId)})`,
    })
    .from(pages)
    .where(and(inArray(pages.id, candidates), eq(pages.parentId, target)))
  const visible = new Set(rows.filter((r) => r.visible).map((r) => r.id))
  const existsHidden = new Set(rows.filter((r) => !r.visible).map((r) => r.id))
  const out = submitted.filter((id) => visible.has(id))
  for (const id of old) if (existsHidden.has(id) && !out.includes(id)) out.push(id)
  return out.slice(0, RELATION_MAX_LINKS)
}

/**
 * Two-way sync: mirror the diff of one relation cell onto the paired field of the target rows.
 * Two set-based UPDATEs (added / removed), independent of how many rows the collection has.
 */
export async function syncPairedLinks(
  exec: Exec,
  field: CollectionField,
  rowId: string,
  oldIds: string[],
  newIds: string[],
): Promise<void> {
  const rel = field.relation
  if (!rel?.twoWay || !rel.pairFieldId) return
  const pair = rel.pairFieldId
  const oldSet = new Set(oldIds)
  const newSet = new Set(newIds)
  const added = newIds.filter((id) => !oldSet.has(id))
  const removed = oldIds.filter((id) => !newSet.has(id))
  const path = sql`array[${pair}]::text[]`
  const me = sql`to_jsonb(${rowId}::text)`
  if (added.length) {
    await exec
      .update(pages)
      .set({
        props: sql`jsonb_set(${pages.props}, ${path}, (CASE WHEN jsonb_typeof(${pages.props}->${pair}) = 'array' THEN ${pages.props}->${pair} ELSE '[]'::jsonb END) || ${me})`,
      })
      .where(
        and(
          inArray(pages.id, added),
          eq(pages.parentId, rel.targetPageId),
          sql`NOT (CASE WHEN jsonb_typeof(${pages.props}->${pair}) = 'array' THEN (${pages.props}->${pair}) @> jsonb_build_array(${rowId}::text) ELSE false END)`,
        ),
      )
  }
  if (removed.length) {
    await exec
      .update(pages)
      .set({
        props: sql`jsonb_set(${pages.props}, ${path}, COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(${pages.props}->${pair}) e WHERE e <> ${me}), '[]'::jsonb))`,
      })
      .where(
        and(
          inArray(pages.id, removed),
          eq(pages.parentId, rel.targetPageId),
          sql`jsonb_typeof(${pages.props}->${pair}) = 'array'`,
        ),
      )
  }
}

// ---------------------------------------------------------------------------
// Field definition updates (validation + two-way pairing)
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function newFieldId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export class FieldConfigError extends Error {}

/**
 * Validate relation/rollup definitions and maintain two-way pairs. Runs inside the fields PUT
 * transaction. Returns the fields to store for this collection (pairFieldId filled in).
 *
 *  - relation target must be a live collection page in the same workspace visible to the user, for
 *    a relation that is new, re-targeted or switched to two-way; one left as it was passes even when
 *    its target is another member's private collection, so that member's field does not lock the
 *    schema for everyone else (docs/adr/1353-*). Hidden and missing targets get the same answer.
 *  - rollup must reference a relation field of this collection; its target field must not be a
 *    rollup or relation (depth-1 rule → rollup cycles are impossible by construction)
 *  - a new two-way relation creates the paired relation field on the target collection
 *  - removing a paired field (or turning two-way off) turns the partner into a one-way relation;
 *    its stored links are kept (non-destructive)
 */
export async function applyFieldsUpdate(
  tx: Tx,
  page: { id: string; workspaceId: string; title: string },
  oldFields: CollectionField[],
  input: CollectionField[],
  userId: string,
): Promise<CollectionField[]> {
  const fields: CollectionField[] = input.map((f) => {
    const out: CollectionField = { ...f }
    if (f.type !== 'relation') delete out.relation
    if (f.type !== 'rollup') delete out.rollup
    if (f.type !== 'formula') delete out.formula
    if (f.type !== 'select' && f.type !== 'multiSelect') delete out.options
    if (f.type !== 'uniqueId') delete out.uniqueId
    if (out.relation && !out.relation.subItems) {
      const { subItems: _drop, ...rest } = out.relation
      out.relation = rest
    }
    return out
  })

  // ---- 0.17 field types (docs/adr/2140-*, 2144-*) ----
  if (fields.filter((f) => f.type === 'uniqueId').length > 1) throw new FieldConfigError('A collection can have one ID property')
  const parentFields = fields.filter((f) => f.type === 'relation' && f.relation?.subItems)
  if (parentFields.length > 1) throw new FieldConfigError('A collection can have one Parent item (sub-items) property')
  for (const f of parentFields) {
    if (f.relation!.targetPageId !== page.id) throw new FieldConfigError(`"${f.name}": sub-items link rows of the same collection`)
    if (f.relation!.twoWay) throw new FieldConfigError(`"${f.name}": a Parent item property is one-way (sub-items are found from the parents)`)
  }

  // ---- relation targets ----
  const rels = fields.filter((f) => f.type === 'relation')
  for (const f of rels) if (!f.relation?.targetPageId) throw new FieldConfigError(`Relation "${f.name}" needs a target collection`)
  const oldById = new Map(oldFields.map((f) => [f.id, f]))
  // stored as it was: same id, still a relation to the same target, and not newly two-way or
  // re-paired (pairing writes to the target). The name may change.
  const unchangedRel = (f: CollectionField): boolean => {
    const old = oldById.get(f.id)
    return (
      old?.type === 'relation' &&
      old.relation?.targetPageId === f.relation?.targetPageId &&
      (!f.relation?.twoWay || (!!old.relation?.twoWay && old.relation.pairFieldId === f.relation.pairFieldId))
    )
  }
  const targetIds = [...new Set(rels.map((f) => f.relation!.targetPageId))]
  const targetDefs = new Map<string, { title: string; fields: CollectionField[] }>()
  if (targetIds.length) {
    const rows = await tx
      .select({ id: pages.id, title: pages.title, fields: collections.fields })
      .from(pages)
      .innerJoin(collections, eq(collections.pageId, pages.id))
      .where(
        and(
          inArray(pages.id, targetIds),
          eq(pages.workspaceId, page.workspaceId),
          eq(pages.kind, 'collection'),
          isNull(pages.deletedAt),
          visibleTo(userId),
        ),
      )
    for (const r of rows) targetDefs.set(r.id, { title: r.title, fields: (r.fields ?? []) as CollectionField[] })
    for (const f of rels) {
      const id = f.relation!.targetPageId
      if (id === page.id || targetDefs.has(id) || unchangedRel(f)) continue
      throw new FieldConfigError('Relation target collection not found')
    }
  }
  // the collection itself: use the incoming definition
  const defsOf = (id: string): CollectionField[] => (id === page.id ? fields : targetDefs.get(id)?.fields ?? [])

  // ---- rollups ----
  for (const f of fields.filter((x) => x.type === 'rollup')) {
    const cfg = f.rollup
    if (!cfg) throw new FieldConfigError(`Rollup "${f.name}" needs a configuration`)
    const rel = fields.find((x) => x.id === cfg.relationFieldId && x.type === 'relation')
    if (!rel) throw new FieldConfigError(`Rollup "${f.name}" must use a relation of this collection`)
    // over a relation whose target this editor cannot see: only a rollup stored as it was passes
    // (its target property cannot be checked here; the member who added it could)
    const target = rel.relation!.targetPageId
    if (target !== page.id && !targetDefs.has(target)) {
      const old = oldById.get(f.id)
      const same =
        old?.type === 'rollup' &&
        old.rollup?.relationFieldId === cfg.relationFieldId &&
        old.rollup?.targetFieldId === cfg.targetFieldId &&
        old.rollup?.fn === cfg.fn
      if (same) continue
      throw new FieldConfigError('Relation target collection not found')
    }
    if (cfg.targetFieldId !== 'title') {
      const tf = defsOf(rel.relation!.targetPageId).find((x) => x.id === cfg.targetFieldId)
      if (!tf) throw new FieldConfigError(`Rollup "${f.name}": target property not found`)
      if ((tf.type === 'rollup' || tf.type === 'relation' || tf.type === 'formula' || isAutoFieldType(tf.type)) && cfg.fn !== 'count')
        throw new FieldConfigError(`Rollup "${f.name}" cannot aggregate a relation, rollup, formula or automatic property (count only)`)
    }
  }

  // ---- formulas (docs/adr/1823-*) ----
  checkFormulaFields(oldFields, fields)

  // ---- two-way pairing ----
  const newById = new Map(fields.map((f) => [f.id, f]))
  // pending edits to OTHER collections' field lists: targetPageId -> mutator list
  const external = new Map<string, ((list: CollectionField[]) => CollectionField[])[]>()
  const editExternal = (target: string, fn: (list: CollectionField[]) => CollectionField[]) => {
    if (target === page.id) {
      const next = fn(fields)
      fields.splice(0, fields.length, ...next)
      return
    }
    const list = external.get(target) ?? []
    list.push(fn)
    external.set(target, list)
  }
  const unpair = (target: string, pairId: string) =>
    editExternal(target, (list) =>
      list.map((x) =>
        x.id === pairId && x.relation
          ? { ...x, relation: { targetPageId: x.relation.targetPageId, twoWay: false } }
          : x,
      ),
    )

  // removed or re-targeted / two-way switched off → unpair the old partner
  for (const old of oldFields) {
    if (old.type !== 'relation' || !old.relation?.pairFieldId) continue
    const cur = newById.get(old.id)
    const stillPaired =
      cur?.type === 'relation' &&
      cur.relation?.twoWay &&
      cur.relation.targetPageId === old.relation.targetPageId &&
      cur.relation.pairFieldId === old.relation.pairFieldId
    if (!stillPaired) {
      unpair(old.relation.targetPageId, old.relation.pairFieldId)
      if (cur?.relation) cur.relation = { targetPageId: cur.relation.targetPageId, twoWay: cur.relation.twoWay }
    }
  }

  // new two-way relations → create the partner field
  for (const f of [...fields]) {
    if (f.type !== 'relation' || !f.relation?.twoWay) continue
    const old = oldById.get(f.id)
    const alreadyPaired =
      !!f.relation.pairFieldId &&
      old?.relation?.pairFieldId === f.relation.pairFieldId &&
      old.relation.targetPageId === f.relation.targetPageId
    if (alreadyPaired) continue
    const target = f.relation.targetPageId
    const pairId = newFieldId()
    f.relation = { targetPageId: target, twoWay: true, pairFieldId: pairId }
    const name = (page.title.trim() || 'Related').slice(0, 60)
    editExternal(target, (list) => {
      if (list.length >= 200) throw new FieldConfigError('Target collection has too many properties')
      return [
        ...list,
        {
          id: pairId,
          name: target === page.id ? `${f.name} (back)`.slice(0, 60) : name,
          type: 'relation',
          relation: { targetPageId: page.id, twoWay: true, pairFieldId: f.id },
        },
      ]
    })
  }

  // Pairing edits another collection's schema: that collection must be editable too (docs/adr/0970-*).
  const others = [...external.keys()].filter((t) => t !== page.id)
  if (others.length) {
    await assertAllEditable(tx, others, actorFor(userId, await roleForPage(page.id, userId)))
  }
  // apply external edits (row-locked read-modify-write per target collection)
  for (const [target, fns] of external) {
    const locked = await tx.execute(
      sql`SELECT fields FROM collections WHERE page_id = ${target} FOR UPDATE`,
    )
    const first = (locked as unknown as { fields: unknown }[])[0]
    if (!first) continue
    let list = (first.fields ?? []) as CollectionField[]
    for (const fn of fns) list = fn(list)
    await tx
      .update(collections)
      .set({ fields: list, updatedAt: new Date() })
      .where(eq(collections.pageId, target))
  }
  return fields
}

/**
 * Formula fields of a fields PUT, in place: a formula whose text the editor did not touch follows
 * renamed properties (prop("Old") → prop("New"), same field id); a new or edited formula must parse,
 * name existing properties and not refer to itself through other formulas. A formula broken by some
 * other change (a property it reads was deleted) is kept and shows its error in the cells, so it
 * never blocks an unrelated schema edit.
 */
export function checkFormulaFields(oldFields: CollectionField[], fields: CollectionField[]): void {
  const oldById = new Map(oldFields.map((f) => [f.id, f]))
  const touched: CollectionField[] = []
  for (const f of fields) {
    if (f.type !== 'formula') continue
    if (!f.formula) throw new FieldConfigError(`Formula "${f.name}" needs an expression`)
    const old = oldById.get(f.id)
    const same = old?.type === 'formula' && old.formula?.expression === f.formula.expression
    if (same) {
      const renamed = renameFormulaProps(f.formula.expression, oldFields, fields)
      if (renamed !== f.formula.expression) {
        if (renamed.length > FORMULA_LIMITS.expression) throw new FieldConfigError(`Formula "${f.name}" would be too long after the rename`)
        f.formula = { ...f.formula, expression: renamed }
      }
    } else {
      touched.push(f)
    }
  }
  if (!touched.length) return
  const compiled = compileFormulas(fields)
  for (const f of touched) {
    const err = compiled.byId.get(f.id)?.error
    if (err) throw new FieldConfigError(`Formula "${f.name}": ${err.message}`)
  }
}

/** SQL: `users` row is a member of `workspaceId` (use with FROM users). */
export function isWorkspaceMember(workspaceId: string) {
  return sql`exists (select 1 from workspace_members m where m.user_id = ${users.id} and m.workspace_id = ${workspaceId})`
}

/**
 * Person cells may only reference members of the workspace (C-L11): any other UUID would make
 * exports and rollups resolve an arbitrary account's name. Throws FieldConfigError-free 400 via the
 * caller; returns the offending ids (empty = all fine).
 */
export async function nonMemberPersonIds(
  workspaceId: string,
  fields: CollectionField[],
  propsList: Record<string, unknown>[],
): Promise<string[]> {
  const personIds = new Set(fields.filter((f) => f.type === 'person').map((f) => f.id))
  if (personIds.size === 0) return []
  const wanted = new Set<string>()
  for (const props of propsList) {
    for (const [k, v] of Object.entries(props)) {
      if (personIds.has(k) && typeof v === 'string' && v) wanted.add(v)
    }
  }
  if (wanted.size === 0) return []
  const ids = [...wanted].filter((v) => UUID_RE.test(v))
  const bad = [...wanted].filter((v) => !UUID_RE.test(v))
  if (ids.length) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, ids), isWorkspaceMember(workspaceId)))
    const ok = new Set(rows.map((r) => r.id))
    for (const id of ids) if (!ok.has(id)) bad.push(id)
  }
  return bad
}
