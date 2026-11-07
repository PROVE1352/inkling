import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { CollectionField, DateItemDTO, PageProperty } from '@inkling/shared'
import { db } from '../db/index'
import { collections, pageTasks, pages } from '../db/schema'
import { visibleTo } from '../pageDto'

/**
 * Unified date items — the global calendar (/calendar) and the due view (/due) share these rules.
 *
 *   row   : values of *every* date field of every collection in the workspace (one row can yield several items).
 *           done = the row has a checked checkbox field, or a select value (option name) of done/complete (or Korean 완료/끝).
 *   page  : type='date' values among page properties (template withDate · "new page on this date").
 *           done = the 'done' checkbox property (PATCH /pages/:id { done }).
 *   daily : pages whose title is exactly YYYY-MM-DD (daily notes).
 *   task  : page_tasks (dated checklists inside documents). done = checked.
 *
 * Everything is workspace-scoped + visibleTo(user) + excludes trash. Dates compare as local 'YYYY-MM-DD' strings.
 * Membership checks are the caller's (route's) job.
 */

// The Korean alternatives below are field/option names users already have in their data
// ('완료' / '끝' = done, '마감' / '기한' = due); they stay so existing collections keep matching.
/** Select option names that count as done */
const DONE_RE = /완료|done|끝|complete/i
/** Date field names preferred as the due field */
const DUE_NAME_RE = /마감|due|deadline|기한/i
const DAILY_RE = /^\d{4}-\d{2}-\d{2}$/

export type DateItemsOptions = {
  from: string
  to: string
  /** Default: all. The due view calls it without daily. */
  kinds?: DateItemDTO['kind'][]
  /**
   * 'all' (calendar) = each date field of a row becomes its own item.
   * 'due' (due view) = one item per row — a due-named field's value first, else the first date field with a value.
   */
  rowFields?: 'all' | 'due'
}

type PathIndex = Map<string, { parentId: string | null; title: string; kind: string }>

/** Ancestor path "A / B" (excluding the page itself, at most 4 levels). */
function pathOf(index: PathIndex, parentId: string | null): string | undefined {
  const parts: string[] = []
  let cur = parentId
  let guard = 0
  while (cur && guard++ < 20) {
    const p = index.get(cur)
    if (!p) break
    parts.unshift(p.title || 'Untitled')
    cur = p.parentId
  }
  if (parts.length === 0) return undefined
  return parts.length > 4 ? ['…', ...parts.slice(-3)].join(' / ') : parts.join(' / ')
}

/** Whether a row is done: a checked checkbox field or a done-named select value. */
function rowDone(fields: CollectionField[], props: Record<string, unknown>): boolean {
  for (const f of fields) {
    const v = props[f.id]
    if (f.type === 'checkbox' && v === true) return true
    if (f.type === 'select' && typeof v === 'string' && v) {
      // The value is usually an option id — resolve it to the name (old data that stored the name directly is accepted too).
      const name = f.options?.find((o) => o.id === v)?.name ?? v
      if (DONE_RE.test(name)) return true
    }
  }
  return false
}

/** Checkbox field used for the done toggle — a done-named one first, else the first checkbox. */
function doneCheckbox(fields: CollectionField[]): string | undefined {
  const boxes = fields.filter((f) => f.type === 'checkbox')
  return (boxes.find((f) => DONE_RE.test(f.name)) ?? boxes[0])?.id
}

export async function collectDateItems(
  workspaceId: string,
  userId: string,
  opts: DateItemsOptions,
): Promise<DateItemDTO[]> {
  const { from, to } = opts
  const kinds = new Set(opts.kinds ?? ['row', 'page', 'daily', 'task'])
  const items: DateItemDTO[] = []

  // For path building — id/parent/title of the workspace's live, visible pages (light columns only).
  let pathIndex: PathIndex | null = null
  const getPathIndex = async (): Promise<PathIndex> => {
    if (pathIndex) return pathIndex
    const rows = await db
      .select({ id: pages.id, parentId: pages.parentId, title: pages.title, kind: pages.kind })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
    pathIndex = new Map(rows.map((r) => [r.id, { parentId: r.parentId, title: r.title, kind: r.kind }]))
    return pathIndex
  }

  // (1) Collection rows
  if (kinds.has('row')) {
    const cols = await db
      .select({ pageId: collections.pageId, title: pages.title, fields: collections.fields })
      .from(collections)
      .innerJoin(pages, eq(pages.id, collections.pageId))
      .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))

    const meta = new Map<
      string,
      { title: string; fields: CollectionField[]; dateFields: CollectionField[]; doneFieldId?: string }
    >()
    for (const c of cols) {
      const fields = (c.fields ?? []) as CollectionField[]
      const dateFields = fields.filter((f) => f.type === 'date')
      if (dateFields.length === 0) continue
      // Due mode: due-named fields first (if the row has a value there, only that field is used).
      if (opts.rowFields === 'due') {
        dateFields.sort((a, b) => Number(DUE_NAME_RE.test(b.name)) - Number(DUE_NAME_RE.test(a.name)))
      }
      meta.set(c.pageId, { title: c.title, fields, dateFields, doneFieldId: doneCheckbox(fields) })
    }

    const colIds = [...meta.keys()]
    if (colIds.length > 0) {
      const rows = await db
        .select({
          id: pages.id,
          parentId: pages.parentId,
          title: pages.title,
          icon: pages.icon,
          props: pages.props,
        })
        .from(pages)
        .where(and(inArray(pages.parentId, colIds), isNull(pages.deletedAt), visibleTo(userId)))

      for (const row of rows) {
        const m = row.parentId ? meta.get(row.parentId) : undefined
        if (!m) continue
        const props = (row.props ?? {}) as Record<string, unknown>
        const done = rowDone(m.fields, props)
        for (const f of m.dateFields) {
          const value = props[f.id]
          if (typeof value !== 'string' || !DAILY_RE.test(value)) continue
          // Due mode takes only the row's *first* value (it represents the row even when out of range — no leaking to other fields).
          const inRange = value >= from && value <= to
          if (inRange) {
            items.push({
              kind: 'row',
              pageId: row.id,
              title: row.title,
              icon: row.icon,
              date: value,
              done,
              collectionTitle: m.title,
              fieldId: f.id,
              ...(m.doneFieldId ? { doneFieldId: m.doneFieldId } : {}),
            })
          }
          if (opts.rowFields === 'due') break
        }
      }
    }
  }

  // (2) Daily notes — coarse prefilter by title range, then the exact regex.
  if (kinds.has('daily')) {
    const daily = await db
      .select({ id: pages.id, title: pages.title, icon: pages.icon })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          isNull(pages.deletedAt),
          visibleTo(userId),
          gte(pages.title, from),
          lte(pages.title, to),
        ),
      )
    for (const p of daily) {
      if (!DAILY_RE.test(p.title)) continue
      items.push({ kind: 'daily', pageId: p.id, title: p.title, icon: p.icon, date: p.title, done: false })
    }
  }

  // (3) Page date properties
  if (kinds.has('page')) {
    const cands = await db
      .select({
        id: pages.id,
        parentId: pages.parentId,
        title: pages.title,
        icon: pages.icon,
        properties: pages.properties,
      })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          isNull(pages.deletedAt),
          visibleTo(userId),
          sql`jsonb_typeof(${pages.properties}) = 'array' AND jsonb_array_length(${pages.properties}) > 0`,
          // Only pages with at least one date property (excludes pages with just fullWidth)
          sql`${pages.properties} @> '[{"type":"date"}]'::jsonb`,
        ),
      )
    const idx = cands.length > 0 ? await getPathIndex() : null
    for (const p of cands) {
      const props = Array.isArray(p.properties) ? (p.properties as PageProperty[]) : []
      // done = the 'done' checkbox property (due-view toggle) or a checked checkbox property with a done-like name
      const done = props.some(
        (q) => q?.type === 'checkbox' && q.value === true && (q.id === 'done' || DONE_RE.test(q.name)),
      )
      const seen = new Set<string>()
      for (const prop of props) {
        if (!prop || prop.type !== 'date') continue
        const value = prop.value
        if (typeof value !== 'string' || value < from || value > to) continue
        if (seen.has(value)) continue // avoid duplicate dates on the same page
        seen.add(value)
        items.push({
          kind: 'page',
          pageId: p.id,
          title: p.title,
          icon: p.icon,
          date: value,
          done,
          fieldId: prop.id,
          doneFieldId: 'done',
          parentPath: idx ? pathOf(idx, p.parentId) : undefined,
        })
      }
    }
  }

  // (4) Tasks inside documents
  if (kinds.has('task')) {
    const tasks = await db
      .select({
        pageId: pageTasks.pageId,
        blockId: pageTasks.blockId,
        text: pageTasks.text,
        due: pageTasks.due,
        checked: pageTasks.checked,
        pageTitle: pages.title,
        icon: pages.icon,
        parentId: pages.parentId,
      })
      .from(pageTasks)
      .innerJoin(pages, eq(pages.id, pageTasks.pageId))
      .where(
        and(
          eq(pageTasks.workspaceId, workspaceId),
          gte(pageTasks.due, from),
          lte(pageTasks.due, to),
          isNull(pages.deletedAt),
          visibleTo(userId),
        ),
      )
      .limit(5000)
    const idx = tasks.length > 0 ? await getPathIndex() : null
    for (const t of tasks) {
      const parent = idx ? pathOf(idx, t.parentId) : undefined
      items.push({
        kind: 'task',
        pageId: t.pageId,
        title: t.text || '(empty)',
        icon: t.icon,
        date: t.due,
        done: t.checked,
        blockId: t.blockId,
        pageTitle: t.pageTitle,
        parentPath: parent ? `${parent} / ${t.pageTitle || 'Untitled'}` : t.pageTitle || 'Untitled',
      })
    }
  }

  // date asc → unfinished first → title asc (deterministic rendering/smoke tests)
  items.sort((a, b) =>
    a.date !== b.date
      ? a.date < b.date
        ? -1
        : 1
      : a.done !== b.done
        ? Number(a.done) - Number(b.done)
        : a.title.localeCompare(b.title),
  )
  return items
}
