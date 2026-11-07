import { assertPlacement, lockTree } from '../pageTree'
/**
 * Google Sheets read sync — EXPERIMENTAL (`EXPERIMENTAL_FEATURES=sheets-sync`).
 * docs/adr/0306-sheets-read-sync.md
 *
 * A collection is linked to a sheet's "Publish to the web" CSV URL. A scheduler pulls the CSV
 * every `intervalMinutes` (default 15, min 5) and upserts rows by a key column. Rows that
 * disappeared from the sheet are left untouched (never deleted by sync).
 *
 * Safety:
 *  - URL must start with https://docs.google.com/spreadsheets/; fetched with safeFetch
 *    (SSRF guard, redirects re-validated, host allowlist docs.google.com / *.googleusercontent.com),
 *    20 MB / 20 s caps.
 *  - Re-entry: a run is claimed with an atomic UPDATE (running_since IS NULL or stale), so the
 *    scheduler, a manual "Sync now" and a second server process can never run the same sync
 *    concurrently. The scheduler also runs syncs one at a time.
 *  - The sync acts as the user who configured it: their visibility (visibleTo) and membership
 *    are re-checked on every run; if they lost access the sync stops with an error.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  BATCH_MAX_ROWS,
  coerceCellValue,
  IMPORT_MAX_COLS,
  IMPORT_MAX_ROWS,
  inferColumnType,
  parseCsv,
  SHEETS_SYNC_DEFAULT_INTERVAL,
  sheetSyncSchema,
} from '@inkling/shared'
import type { CollectionField, SelectOption, SheetSyncDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { collections, collectionSheetSyncs, pages, workspaceMembers } from '../db/schema'
import { badRequest, conflict, notFound } from '../errors'
import { idParam } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { safeFetch, SafeFetchError } from '../safeFetch'
import { requireCollectionPage } from './collections'

const FETCH_MAX_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
/** a claim older than this is considered abandoned (crashed process) */
const STALE_RUN_MS = 10 * 60 * 1000
const TICK_MS = 60_000
const OPTION_COLORS: SelectOption['color'][] = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink']

type SyncRow = typeof collectionSheetSyncs.$inferSelect

function toDTO(r: SyncRow): SheetSyncDTO {
  return {
    pageId: r.pageId,
    url: r.url,
    keyColumn: r.keyColumn,
    titleColumn: r.titleColumn,
    intervalMinutes: r.intervalMinutes,
    enabled: r.enabled,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    lastStatus: r.runningSince ? 'running' : (r.lastStatus ?? null),
    lastError: r.lastError,
    lastStats: (r.lastStats as SheetSyncDTO['lastStats']) ?? null,
  }
}

async function loadSync(pageId: string): Promise<SyncRow | null> {
  return (
    (await db.select().from(collectionSheetSyncs).where(eq(collectionSheetSyncs.pageId, pageId)).limit(1))[0] ?? null
  )
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export class SyncError extends Error {}

export interface SyncStats {
  inserted: number
  updated: number
  unchanged: number
}

/** Stable comparison key for a stored value. */
function keyOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v.trim() : JSON.stringify(v)
}

/**
 * Pure part of a sync: given the CSV records, the current fields and the existing rows, compute
 * the new field list, the inserts and the updates. Exported for smoke checks.
 */
export function planSync(
  records: string[][],
  fields: CollectionField[],
  existing: { id: string; title: string; props: Record<string, unknown> }[],
  cfg: { keyColumn: string; titleColumn: string | null },
): {
  fields: CollectionField[]
  fieldsChanged: boolean
  inserts: { title: string; props: Record<string, unknown> }[]
  updates: { id: string; title: string; set: Record<string, unknown> }[]
  unchanged: number
} {
  if (records.length === 0) throw new SyncError('The sheet is empty')
  const header = records[0].map((h) => h.trim())
  if (header.length > IMPORT_MAX_COLS) throw new SyncError(`Too many columns (max ${IMPORT_MAX_COLS})`)
  const body = records.slice(1)
  const lower = header.map((h) => h.toLowerCase())
  const keyIdx = lower.indexOf(cfg.keyColumn.trim().toLowerCase())
  if (keyIdx < 0) throw new SyncError(`Key column "${cfg.keyColumn}" not found in the sheet`)
  const titleName = (cfg.titleColumn || cfg.keyColumn).trim().toLowerCase()
  const titleIdx = lower.indexOf(titleName)
  if (titleIdx < 0) throw new SyncError(`Title column "${cfg.titleColumn}" not found in the sheet`)

  // map columns → fields by (case-insensitive) name; create missing ones with an inferred type
  const next: CollectionField[] = fields.map((f) => (f.options ? { ...f, options: [...f.options] } : { ...f }))
  let fieldsChanged = false
  const colField: (CollectionField | null)[] = header.map((name, ci) => {
    if (ci === titleIdx || name === '') return null
    const found = next.find((f) => f.name.trim().toLowerCase() === name.toLowerCase())
    if (found) return found.type === 'relation' || found.type === 'rollup' ? null : found
    if (next.length >= 200) return null
    const type = inferColumnType(body.map((r) => r[ci] ?? ''))
    const f: CollectionField = {
      id: newId(),
      name: name.slice(0, 60),
      type,
      ...(type === 'select' ? { options: [] } : {}),
    }
    next.push(f)
    fieldsChanged = true
    return f
  })

  const resolveOption = (field: CollectionField, name: string): string | null => {
    const opts = field.options ?? (field.options = [])
    const hit = opts.find((o) => o.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    if (opts.length >= 50) return null
    const o: SelectOption = { id: newId(), name: name.slice(0, 60), color: OPTION_COLORS[opts.length % OPTION_COLORS.length] }
    opts.push(o)
    fieldsChanged = true
    return o.id
  }

  // existing rows indexed by key (first occurrence wins)
  const keyField = keyIdx === titleIdx ? null : colField[keyIdx]
  if (keyIdx !== titleIdx && !keyField) throw new SyncError('The key column cannot be a relation/rollup property')
  const byKey = new Map<string, { id: string; title: string; props: Record<string, unknown> }>()
  for (const r of existing) {
    const k = keyField ? keyOf(r.props[keyField.id]) : r.title.trim()
    if (k !== '' && !byKey.has(k)) byKey.set(k, r)
  }

  const inserts: { title: string; props: Record<string, unknown> }[] = []
  const updates: { id: string; title: string; set: Record<string, unknown> }[] = []
  let unchanged = 0
  const seen = new Set<string>()
  for (const rec of body) {
    const props: Record<string, unknown> = {}
    header.forEach((_, ci) => {
      const f = colField[ci]
      if (!f) return
      const v = coerceCellValue(f, rec[ci] ?? '', { resolveOption })
      if (v !== undefined) props[f.id] = v
    })
    const title = (rec[titleIdx] ?? '').trim().slice(0, 500)
    const key = keyField ? keyOf(props[keyField.id]) : title
    if (key === '' || seen.has(key)) continue // rows without a key / duplicate keys are skipped
    seen.add(key)
    const cur = byKey.get(key)
    if (!cur) {
      for (const k of Object.keys(props)) if (props[k] === null) delete props[k]
      inserts.push({ title, props })
      continue
    }
    const set: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (JSON.stringify(cur.props[k] ?? null) !== JSON.stringify(v)) set[k] = v
    }
    if (Object.keys(set).length === 0 && cur.title === title) unchanged++
    else updates.push({ id: cur.id, title, set })
  }
  return { fields: next, fieldsChanged, inserts, updates, unchanged }
}

/** Fetch the published CSV through the SSRF guard. */
async function fetchSheetCsv(url: string): Promise<string> {
  if (!url.startsWith('https://docs.google.com/spreadsheets/')) throw new SyncError('URL not allowed')
  try {
    const res = await safeFetch(url, {
      allowedHosts: ['docs.google.com', '*.googleusercontent.com'],
      maxRedirects: 3,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      allowedContentTypes: ['text/csv', 'text/plain', 'application/octet-stream'],
      headers: { Accept: 'text/csv' },
    })
    if (res.status !== 200) throw new SyncError(`The sheet responded with HTTP ${res.status}`)
    return res.body.toString('utf8')
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.code === 'content_type') throw new SyncError('The URL did not return CSV — use File › Share › Publish to web › CSV')
      if (err.code === 'too_large') throw new SyncError('The sheet is larger than 20 MB')
      if (err.code === 'timeout') throw new SyncError('The sheet did not respond in time')
      throw new SyncError(`Fetch blocked: ${err.code}`)
    }
    throw err
  }
}

/**
 * Run one sync now. Returns null when another run holds the claim (re-entry refused).
 */
export async function runSheetSync(pageId: string): Promise<SyncStats | null> {
  // atomic claim (cross-process): only one runner may flip running_since
  const claimed = await db
    .update(collectionSheetSyncs)
    .set({ runningSince: new Date() })
    .where(
      and(
        eq(collectionSheetSyncs.pageId, pageId),
        or(
          isNull(collectionSheetSyncs.runningSince),
          sql`${collectionSheetSyncs.runningSince} < now() - (${STALE_RUN_MS} * interval '1 millisecond')`,
        ),
      ),
    )
    .returning()
  const sync = claimed[0]
  if (!sync) return null
  // Release only our own claim: a run that outlived STALE_RUN_MS may have been re-claimed by
  // another runner, whose running_since we must not clear (docs/adr/0757-*).
  const ownClaim = and(
    eq(collectionSheetSyncs.pageId, pageId),
    sync.runningSince ? eq(collectionSheetSyncs.runningSince, sync.runningSince) : undefined,
  )

  try {
    const ownerId = sync.createdBy
    if (!ownerId) throw new SyncError('The user who set up this sync no longer exists')
    const page = await findVisiblePage(pageId, ownerId)
    if (!page || page.kind !== 'collection') throw new SyncError('The collection is no longer accessible')
    const member = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, page.workspaceId), eq(workspaceMembers.userId, ownerId)))
      .limit(1)
    if (!member[0]) throw new SyncError('The sync owner is no longer a workspace member')

    const text = await fetchSheetCsv(sync.url)
    const parsed = parseCsv(text, { maxRows: IMPORT_MAX_ROWS + 1 })
    if (parsed.truncated) throw new SyncError(`The sheet has more than ${IMPORT_MAX_ROWS} rows`)

    const fields = (
      (await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, pageId)).limit(1))[0]
        ?.fields ?? []
    ) as CollectionField[]
    const existing = await db
      .select({ id: pages.id, title: pages.title, props: pages.props })
      .from(pages)
      .where(and(eq(pages.parentId, pageId), isNull(pages.deletedAt), visibleTo(ownerId)))
    const plan = planSync(
      parsed.rows,
      fields,
      existing.map((r) => ({ ...r, props: (r.props ?? {}) as Record<string, unknown> })),
      { keyColumn: sync.keyColumn, titleColumn: sync.titleColumn },
    )

    await db.transaction(async (tx) => {
      if (plan.inserts.length) {
        // New rows are a tree change: take the workspace tree lock first and make sure the
        // collection is still live (docs/adr/0800-*).
        await lockTree(tx, page.workspaceId)
        await assertPlacement(tx, {
          workspaceId: page.workspaceId,
          parentId: pageId,
          role: 'member',
          publicRule: false,
        })
      }
      if (plan.fieldsChanged) {
        await tx.update(collections).set({ fields: plan.fields, updatedAt: new Date() }).where(eq(collections.pageId, pageId))
      }
      if (plan.inserts.length) {
        const [{ maxSort }] = (await tx.execute(
          sql`SELECT COALESCE(MAX(sort_order), 0) AS "maxSort" FROM pages WHERE parent_id = ${pageId}`,
        )) as unknown as { maxSort: number }[]
        let sort = Number(maxSort) || 0
        for (let i = 0; i < plan.inserts.length; i += BATCH_MAX_ROWS) {
          const part = plan.inserts.slice(i, i + BATCH_MAX_ROWS)
          await tx.insert(pages).values(
            part.map((r) => ({
              workspaceId: page.workspaceId,
              parentId: pageId,
              kind: 'doc' as const,
              scope: page.scope,
              title: r.title,
              props: r.props,
              sortOrder: (sort += 1000),
              createdBy: ownerId,
            })),
          )
        }
      }
      for (let i = 0; i < plan.updates.length; i += BATCH_MAX_ROWS) {
        const part = plan.updates.slice(i, i + BATCH_MAX_ROWS).map((u) => ({
          id: u.id,
          title: u.title,
          set: Object.fromEntries(Object.entries(u.set).filter(([, v]) => v !== null)),
          del: Object.entries(u.set).filter(([, v]) => v === null).map(([k]) => k),
        }))
        await tx.execute(sql`
          UPDATE pages SET props = (pages.props || x.set) - x.del, title = x.title, updated_at = now()
          FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS x(id uuid, set jsonb, del text[], title text)
          WHERE pages.id = x.id AND pages.parent_id = ${pageId} AND pages.deleted_at IS NULL
        `)
      }
    })

    const stats: SyncStats = { inserted: plan.inserts.length, updated: plan.updates.length, unchanged: plan.unchanged }
    await db
      .update(collectionSheetSyncs)
      .set({ runningSince: null, lastSyncedAt: new Date(), lastStatus: 'ok', lastError: null, lastStats: stats })
      .where(ownClaim)
    return stats
  } catch (err) {
    const message = err instanceof SyncError ? err.message : 'Sync failed (internal error)'
    if (!(err instanceof SyncError)) console.error('[sheets-sync]', err)
    await db
      .update(collectionSheetSyncs)
      .set({ runningSince: null, lastSyncedAt: new Date(), lastStatus: 'error', lastError: message.slice(0, 500) })
      .where(ownClaim)
    throw err instanceof SyncError ? err : new SyncError(message)
  }
}

let schedulerStarted = false

/** Background puller: every minute, run due syncs one at a time (never overlapping ticks). */
export function startSheetSyncScheduler(log: (msg: string) => void): () => void {
  if (schedulerStarted) return () => {}
  schedulerStarted = true
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      const due = await db
        .select({ pageId: collectionSheetSyncs.pageId })
        .from(collectionSheetSyncs)
        .where(
          and(
            eq(collectionSheetSyncs.enabled, true),
            isNull(collectionSheetSyncs.runningSince),
            // paused while the workspace is soft-deleted, resumes on restore (ADR 0910)
            liveWorkspace(collectionSheetSyncs.workspaceId),
            or(
              isNull(collectionSheetSyncs.lastSyncedAt),
              sql`${collectionSheetSyncs.lastSyncedAt} + (${collectionSheetSyncs.intervalMinutes} * interval '1 minute') <= now()`,
            ),
          ),
        )
        .limit(20)
      for (const d of due) {
        try {
          const stats = await runSheetSync(d.pageId)
          if (stats) log(`[sheets-sync] ${d.pageId}: +${stats.inserted} ~${stats.updated} =${stats.unchanged}`)
        } catch (err) {
          log(`[sheets-sync] ${d.pageId}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      log(`[sheets-sync] tick failed: ${(err as Error).message}`)
    } finally {
      ticking = false
    }
  }
  const boot = setTimeout(() => void tick(), 30_000)
  const timer = setInterval(() => void tick(), TICK_MS)
  boot.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(boot)
    clearInterval(timer)
    schedulerStarted = false
  }
}

export async function registerSheetSyncRoutes(app: FastifyInstance): Promise<void> {
  const stop = startSheetSyncScheduler((msg) => app.log.info(msg))
  app.addHook('onClose', async () => stop())

  app.get('/pages/:id/collection/sheet-sync', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)
    const row = await loadSync(id)
    return { sync: row ? toDTO(row) : null }
  })

  app.put('/pages/:id/collection/sheet-sync', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)
    const body = sheetSyncSchema.parse(req.body)
    const values = {
      url: body.url,
      keyColumn: body.keyColumn,
      titleColumn: body.titleColumn?.trim() || null,
      intervalMinutes: body.intervalMinutes ?? SHEETS_SYNC_DEFAULT_INTERVAL,
      enabled: body.enabled ?? true,
      createdBy: user.id,
    }
    await db
      .insert(collectionSheetSyncs)
      .values({ pageId: id, workspaceId: page.workspaceId, ...values })
      .onConflictDoUpdate({ target: collectionSheetSyncs.pageId, set: { ...values, lastError: null } })
    const row = await loadSync(id)
    return { sync: row ? toDTO(row) : null }
  })

  app.delete('/pages/:id/collection/sheet-sync', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)
    await db.delete(collectionSheetSyncs).where(eq(collectionSheetSyncs.pageId, id))
    return reply.code(204).send()
  })

  app.post(
    '/pages/:id/collection/sheet-sync/run',
    { preHandler: requireUser, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      await requireCollectionPage(id, user.id)
      if (!(await loadSync(id))) throw notFound()
      let stats: SyncStats | null
      try {
        stats = await runSheetSync(id)
      } catch (err) {
        if (err instanceof SyncError) throw badRequest(err.message)
        throw err
      }
      if (!stats) throw conflict('SYNC_RUNNING', 'A sync is already running for this collection')
      const row = await loadSync(id)
      return { sync: row ? toDTO(row) : null, stats }
    },
  )
}
