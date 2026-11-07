import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PageReviewDTO, ReviewDueItemDTO, ReviewPriorityDTO } from '@inkling/shared'
import { db } from './db/index'
import { pageReviewScores, pages, users, workspaces } from './db/schema'
import { env } from './env'
import { visibleTo } from './pageDto'
import { emitWebhookEvent, hasEnabledHook } from './webhooks'

/**
 * Document owner, review and review priority (docs/adr/0951-*, 0952-*, 0953-*).
 *
 * Priority = importance × probability of being out of date:
 *   importance = max(reads in the last 30 days, READ_FLOOR)
 *   p          = 1 − exp(−λ·t)              (Poisson drift, Cho & Garcia-Molina 2000)
 *   t          = whole days since the baseline: last review, else the later of creation and the
 *                last section edit (page_changes; pages.updated_at when the log has none)
 *   λ          = ln2 / interval                       prior: p = 0.5 exactly at the workspace interval
 *              + KAPPA_NEIGHBOR · neighbour change rate   linked pages (both directions) changing
 *              + KAPPA_SELF     · own change rate         the topic itself moving
 *   change rate = distinct days with section changes / window days (window = min(90, change-feed retention))
 * A page edited on ≥ LIVING_RATE of the last 30 days is a living document (logs, journals) and is
 * left out of the list; nobody reads it as a reference. An unread (90 days) page whose baseline is
 * ARCHIVE_AGE_DAYS old is an archive candidate instead. Stale = p ≥ 0.5 and not living.
 *
 * The numbers are computed once a day per workspace (housekeeping, or lazily on the first list
 * request of the day) into page_review_scores, so MCP output that carries them changes at most
 * once a day (docs/adr/0937-*). Dates are server-local calendar days.
 */

export const READ_FLOOR = 0.5
export const KAPPA_NEIGHBOR = 0.1
export const KAPPA_SELF = 0.05
export const LIVING_RATE = 0.4
export const ARCHIVE_AGE_DAYS = 180
export const STALE_P = 0.5
/** Reading speed for the review estimate: ~200 words a minute ≈ 1200 characters. */
export const CHARS_PER_MINUTE = 1200

const pad = (n: number): string => String(n).padStart(2, '0')

export function localISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Server-local date `days` days after `d`'s local date. */
export function addLocalDays(d: Date, days: number): string {
  return localISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

/** Whole server-local calendar days from `from` to `to` (≥ 0). */
export function localDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

const round2 = (x: number) => Math.round(x * 100) / 100

// --- the model (pure; unit-tested in review.test.ts) ---------------------------------------

export function estimateLambda(input: {
  intervalDays: number
  /** Distinct days the page itself changed in the window. */
  selfChangeDays: number
  /** Mean distinct change days of its linked pages in the window (0 without links). */
  neighborChangeDays: number
  windowDays: number
}): number {
  const w = Math.max(1, input.windowDays)
  return Math.LN2 / input.intervalDays + KAPPA_NEIGHBOR * (input.neighborChangeDays / w) + KAPPA_SELF * (input.selfChangeDays / w)
}

export function pStale(lambda: number, tDays: number): number {
  return 1 - Math.exp(-lambda * Math.max(0, tDays))
}

export function priorityScore(reads30: number, p: number): number {
  return round2(Math.max(reads30, READ_FLOOR) * p)
}

export function isLiving(override: boolean | null, changeDays30: number): boolean {
  return override ?? changeDays30 / 30 >= LIVING_RATE
}

export function isArchiveCandidate(reads90: number, tDays: number): boolean {
  return reads90 === 0 && tDays >= ARCHIVE_AGE_DAYS
}

export function estMinutes(chars: number): number {
  return Math.max(1, Math.round(chars / CHARS_PER_MINUTE))
}

/** The day p crosses 0.5: baseline + ceil(ln2 / λ) days. */
export function dueOnFor(baseline: Date, lambda: number): string {
  return addLocalDays(baseline, Math.ceil(Math.LN2 / lambda))
}

// --- batch ----------------------------------------------------------------------------------

interface ScoreInput {
  id: string
  createdAt: Date
  updatedAt: Date
  reviewedAt: Date | null
  livingOverride: boolean | null
}

/**
 * Compute and store the priority rows of a workspace (or only `pageIds`): live, non-template
 * documents that are not collection rows. Replaces the stored rows of the same set in one
 * transaction, under a per-workspace advisory lock.
 */
export async function computeReviewScores(workspaceId: string, now = new Date(), pageIds?: string[]): Promise<number> {
  const [ws] = await db
    .select({ intervalDays: workspaces.reviewIntervalDays })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
  if (!ws || ws.intervalDays == null) return 0
  const intervalDays = ws.intervalDays
  const today = localISODate(now)
  const windowDays = Math.min(90, env.changeFeedRetentionDays)
  const nowIso = now.toISOString()
  const only = pageIds ? sql`AND p.id IN (${sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``
  // Single pages: only the changes the score reads (the pages and their link neighbours) instead of
  // aggregating the whole workspace's change feed (page_changes_page_idx).
  const chgOnly = pageIds ? sql`AND c.page_id IN (SELECT id FROM cand UNION SELECT b FROM nb)` : sql``

  const rows = (await db.execute(sql`
    WITH cand AS (
      SELECT p.id, p.created_at, p.updated_at, p.reviewed_at, p.living_override, coalesce(length(t.text), 0) AS chars
        FROM pages p
        LEFT JOIN pages parent ON parent.id = p.parent_id
        LEFT JOIN page_texts t ON t.page_id = p.id
       WHERE p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL AND p.kind = 'doc'
         AND (parent.id IS NULL OR parent.kind <> 'collection') ${only}
    ),
    nb AS (
      SELECT l.source_page_id AS a, l.target_page_id AS b FROM page_links l JOIN cand ON cand.id = l.source_page_id
      UNION
      SELECT l.target_page_id AS a, l.source_page_id AS b FROM page_links l JOIN cand ON cand.id = l.target_page_id
    ),
    chg AS (
      SELECT c.page_id,
             count(DISTINCT (c.changed_at AT TIME ZONE 'UTC')::date)
               FILTER (WHERE c.changed_at > ${nowIso}::timestamptz - make_interval(days => ${windowDays})) AS dw,
             count(DISTINCT (c.changed_at AT TIME ZONE 'UTC')::date)
               FILTER (WHERE c.changed_at > ${nowIso}::timestamptz - interval '30 days') AS d30,
             max(c.changed_at) AS last_edit
        FROM page_changes c
       WHERE c.workspace_id = ${workspaceId} AND c.anchor IS NOT NULL ${chgOnly}
       GROUP BY c.page_id
    ),
    nbr AS (
      SELECT nb.a AS page_id, avg(coalesce(chg.dw, 0))::float8 AS nd
        FROM nb LEFT JOIN chg ON chg.page_id = nb.b
       WHERE nb.a <> nb.b
       GROUP BY nb.a
    ),
    rd AS (
      SELECT r.page_id,
             coalesce(sum(r.count) FILTER (WHERE r.day > (${today}::date - 30)), 0)::int AS r30,
             coalesce(sum(r.count), 0)::int AS r90
        FROM page_reads r JOIN cand ON cand.id = r.page_id
       WHERE r.day > (${today}::date - 90)
       GROUP BY r.page_id
    )
    SELECT cand.id, cand.created_at AS "createdAt", cand.updated_at AS "updatedAt", cand.reviewed_at AS "reviewedAt",
           cand.living_override AS "livingOverride", cand.chars::int AS chars,
           coalesce(chg.dw, 0)::int AS "selfDays", coalesce(chg.d30, 0)::int AS "days30", chg.last_edit AS "lastEdit",
           coalesce(nbr.nd, 0)::float8 AS "neighborDays",
           coalesce(rd.r30, 0)::int AS reads30, coalesce(rd.r90, 0)::int AS reads90
      FROM cand
      LEFT JOIN chg ON chg.page_id = cand.id
      LEFT JOIN nbr ON nbr.page_id = cand.id
      LEFT JOIN rd ON rd.page_id = cand.id
  `)) as unknown as (Omit<ScoreInput, 'createdAt' | 'updatedAt' | 'reviewedAt'> & {
    createdAt: string | Date
    updatedAt: string | Date
    reviewedAt: string | Date | null
    lastEdit: string | Date | null
    chars: number
    selfDays: number
    days30: number
    neighborDays: number
    reads30: number
    reads90: number
  })[]

  const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v))
  const values = rows.map((r) => {
    const created = toDate(r.createdAt)
    const lastEdit = r.lastEdit ? toDate(r.lastEdit) : toDate(r.updatedAt)
    const baseline = r.reviewedAt ? toDate(r.reviewedAt) : lastEdit > created ? lastEdit : created
    const t = localDaysBetween(baseline, now)
    const lambda = estimateLambda({ intervalDays, selfChangeDays: Number(r.selfDays), neighborChangeDays: Number(r.neighborDays), windowDays })
    const p = pStale(lambda, t)
    return {
      pageId: r.id,
      workspaceId,
      reads30: Number(r.reads30),
      lambda,
      pStale: round2(p),
      score: priorityScore(Number(r.reads30), p),
      dueOn: dueOnFor(baseline, lambda),
      estMinutes: estMinutes(Number(r.chars)),
      living: isLiving(r.livingOverride, Number(r.days30)),
      archiveCandidate: isArchiveCandidate(Number(r.reads90), t),
      computedOn: today,
    }
  })

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'review-score:' + workspaceId}))`)
    await tx
      .delete(pageReviewScores)
      .where(
        and(eq(pageReviewScores.workspaceId, workspaceId), pageIds ? inArray(pageReviewScores.pageId, pageIds) : undefined),
      )
    for (let i = 0; i < values.length; i += 500) await tx.insert(pageReviewScores).values(values.slice(i, i + 500))
    if (!pageIds) await tx.update(workspaces).set({ reviewScoredOn: today }).where(eq(workspaces.id, workspaceId))
  })
  return values.length
}

/** Run the batch when this workspace has not been scored today (reminders on). */
export async function ensureReviewScores(workspaceId: string, now = new Date()): Promise<void> {
  const [ws] = await db
    .select({ on: workspaces.reviewScoredOn, interval: workspaces.reviewIntervalDays })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!ws || ws.interval == null || ws.on === localISODate(now)) return
  await computeReviewScores(workspaceId, now)
}

/** Housekeeping: score every workspace with reminders on that was not scored today. */
export async function scoreAllWorkspaces(now = new Date(), log: (msg: string) => void = () => {}): Promise<number> {
  const today = localISODate(now)
  const due = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.deletedAt),
        sql`${workspaces.reviewIntervalDays} IS NOT NULL`,
        sql`${workspaces.reviewScoredOn} IS DISTINCT FROM ${today}`,
      ),
    )
    .limit(200)
  let n = 0
  for (const w of due) {
    try {
      await computeReviewScores(w.id, now)
      n++
    } catch (err) {
      log(`[inkling] review scoring failed for ${w.id}: ${String(err)}`)
    }
  }
  return n
}

// --- reads ------------------------------------------------------------------------------------

const ownerUser = alias(users, 'owner_user')
const reviewerUser = alias(users, 'reviewer_user')

type ScoreRow = typeof pageReviewScores.$inferSelect

function toPriority(s: ScoreRow): ReviewPriorityDTO {
  return {
    reads30: s.reads30,
    pStale: s.pStale,
    score: s.score,
    estMinutes: s.estMinutes,
    living: s.living,
    archiveCandidate: s.archiveCandidate,
    computedOn: s.computedOn,
  }
}

const isStale = (s: ScoreRow | null) => !!s && !s.living && s.pStale >= STALE_P

/** PageReviewDTO for a page the caller already passed the visibility/membership guards for. */
export async function pageReview(pageId: string): Promise<PageReviewDTO | null> {
  const [r] = await db
    .select({
      id: pages.id,
      ownerId: pages.ownerId,
      ownerName: ownerUser.name,
      reviewedAt: pages.reviewedAt,
      reviewedBy: pages.reviewedBy,
      reviewerName: reviewerUser.name,
      livingOverride: pages.livingOverride,
      intervalDays: workspaces.reviewIntervalDays,
      score: pageReviewScores,
    })
    .from(pages)
    .innerJoin(workspaces, eq(workspaces.id, pages.workspaceId))
    .leftJoin(ownerUser, eq(ownerUser.id, pages.ownerId))
    .leftJoin(reviewerUser, eq(reviewerUser.id, pages.reviewedBy))
    .leftJoin(pageReviewScores, eq(pageReviewScores.pageId, pages.id))
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!r) return null
  const s = r.intervalDays == null ? null : r.score
  return {
    pageId: r.id,
    owner: r.ownerId ? { id: r.ownerId, name: r.ownerName ?? '' } : null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    reviewedBy: r.reviewedBy ? { id: r.reviewedBy, name: r.reviewerName ?? '' } : null,
    intervalDays: r.intervalDays,
    dueOn: s?.dueOn ?? null,
    stale: isStale(s),
    livingOverride: r.livingOverride,
    priority: s ? toPriority(s) : null,
  }
}

/** Review facts for MCP output (find_context / read_page), keyed by page id. */
export interface ReviewFacts {
  owner: string | null
  /** 'YYYY-MM-DD' (server-local) of the last review, or null. */
  reviewedOn: string | null
  dueOn: string | null
  stale: boolean
  /** pStale rounded to 2 decimals (from the daily batch), null before the first batch. */
  p: number | null
  living: boolean
}

/**
 * Only pages with something to say appear (an owner, a review, or a priority row while reminders
 * are on). Values come from stored columns and the daily batch, never from "now".
 */
export async function reviewFactsFor(pageIds: string[]): Promise<Map<string, ReviewFacts>> {
  const out = new Map<string, ReviewFacts>()
  if (pageIds.length === 0) return out
  const rows = await db
    .select({
      id: pages.id,
      ownerId: pages.ownerId,
      ownerName: ownerUser.name,
      reviewedAt: pages.reviewedAt,
      intervalDays: workspaces.reviewIntervalDays,
      score: pageReviewScores,
    })
    .from(pages)
    .innerJoin(workspaces, eq(workspaces.id, pages.workspaceId))
    .leftJoin(ownerUser, eq(ownerUser.id, pages.ownerId))
    .leftJoin(pageReviewScores, eq(pageReviewScores.pageId, pages.id))
    .where(inArray(pages.id, [...new Set(pageIds)].slice(0, 200)))
  for (const r of rows) {
    const s = r.intervalDays == null ? null : r.score
    if (!r.ownerId && !r.reviewedAt && !s) continue
    out.set(r.id, {
      owner: r.ownerId ? (r.ownerName ?? null) : null,
      reviewedOn: r.reviewedAt ? localISODate(r.reviewedAt) : null,
      dueOn: s && !s.living ? s.dueOn : null,
      stale: isStale(s),
      p: s ? s.pStale : null,
      living: !!s?.living,
    })
  }
  return out
}

const REVIEW_LIST_LIMIT = 200

export type ReviewBucket = 'stale' | 'archive' | 'living'

/**
 * Pages of a workspace in one bucket, visible to `viewerId` (or shared only, for webhooks):
 *   stale   - p ≥ 0.5, not living, not an archive candidate; by score desc (greedy: most value first)
 *   archive - archive candidates, oldest due first
 *   living  - living documents (auto or by hand)
 */
export async function listReviewBucket(
  workspaceId: string,
  viewerId: string,
  bucket: ReviewBucket,
  opts: { ownerId?: string; sharedOnly?: boolean; limit?: number } = {},
): Promise<ReviewDueItemDTO[]> {
  const where =
    bucket === 'stale'
      ? and(eq(pageReviewScores.living, false), eq(pageReviewScores.archiveCandidate, false), sql`${pageReviewScores.pStale} >= ${STALE_P}`)
      : bucket === 'archive'
        ? and(eq(pageReviewScores.living, false), eq(pageReviewScores.archiveCandidate, true))
        : eq(pageReviewScores.living, true)
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      icon: pages.icon,
      ownerId: pages.ownerId,
      ownerName: ownerUser.name,
      reviewedAt: pages.reviewedAt,
      livingOverride: pages.livingOverride,
      s: pageReviewScores,
    })
    .from(pageReviewScores)
    .innerJoin(pages, eq(pages.id, pageReviewScores.pageId))
    .leftJoin(ownerUser, eq(ownerUser.id, pages.ownerId))
    .where(
      and(
        eq(pageReviewScores.workspaceId, workspaceId),
        isNull(pages.deletedAt),
        opts.sharedOnly ? eq(pages.scope, 'shared') : visibleTo(viewerId),
        opts.ownerId ? eq(pages.ownerId, opts.ownerId) : undefined,
        where,
      ),
    )
    .orderBy(
      ...(bucket === 'stale'
        ? [desc(pageReviewScores.score), desc(pageReviewScores.pStale)]
        : [pageReviewScores.dueOn]),
      pages.id,
    )
    .limit(opts.limit ?? REVIEW_LIST_LIMIT)
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    owner: r.ownerId ? { id: r.ownerId, name: r.ownerName ?? '' } : null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    dueOn: r.s.dueOn,
    reads30: r.s.reads30,
    pStale: r.s.pStale,
    score: r.s.score,
    estMinutes: r.s.estMinutes,
    livingOverride: r.livingOverride,
  }))
}

const DIGEST_MAX_PAGES = 50

/**
 * Once a day per workspace (housekeeping tick): emit one `review_due` webhook event listing the
 * shared stale documents by priority. The day is claimed with a conditional UPDATE first, so a
 * restart or an overlapping tick cannot send it twice. Nothing is stored in the app inbox
 * (docs/adr/0952-*). Returns the number of digests emitted.
 */
export async function scanReviewDigests(now = new Date(), log: (msg: string) => void = () => {}): Promise<number> {
  const today = localISODate(now)
  const candidates = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.deletedAt),
        sql`${workspaces.reviewIntervalDays} IS NOT NULL`,
        sql`${workspaces.reviewDigestSentOn} is distinct from ${today}`,
      ),
    )
    .limit(500)
  let sent = 0
  for (const ws of candidates) {
    try {
      if (!(await hasEnabledHook(ws.id, 'review_due'))) continue
      await ensureReviewScores(ws.id, now)
      const claimed = await db
        .update(workspaces)
        .set({ reviewDigestSentOn: today })
        .where(and(eq(workspaces.id, ws.id), sql`${workspaces.reviewDigestSentOn} is distinct from ${today}`))
        .returning({ id: workspaces.id })
      if (claimed.length === 0) continue
      const items = await listReviewBucket(ws.id, '', 'stale', { sharedOnly: true, limit: DIGEST_MAX_PAGES })
      if (items.length === 0) continue
      emitWebhookEvent({ type: 'review_due', workspaceId: ws.id, pageId: items[0].id, pageIds: items.map((i) => i.id) })
      sent++
    } catch (err) {
      log(`[inkling] review digest failed for ${ws.id}: ${String(err)}`)
    }
  }
  return sent
}
