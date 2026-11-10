import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PageVerificationDTO, VerifiedListDTO, VerifiedPageItemDTO } from '@inkling/shared'
import { VERIFY_CHANGED_MANY, VERIFY_EXPIRING_DAYS } from '@inkling/shared'
import { db } from './db/index'
import { pageVerifications, pages, users } from './db/schema'
import { visibleTo } from './pageDto'
import { localISODate } from './review'
import { liveWorkspace } from './workspaceLive'

/**
 * Page verification (docs/adr/1840-*, 1841-*, 1842-*).
 *
 * A person who may edit a page says "this is correct" until a date. Past it the page reads as
 * "needs verification again"; the state is computed at read time with the server clock, nothing
 * rewrites rows. "Changed since verification" counts the sections the change feed logged for the
 * page after the verification (`base_seq`): edits, additions, removals and renames, each section
 * once. The verifier's own changes logged within VERIFY_SELF_GRACE_MS of the verification are the
 * edits they just verified (the document store and the change log run a little behind the editor),
 * so they do not count.
 */

const DAY_MS = 86_400_000
/** The verifier's own edits logged this long after verifying belong to what was verified. */
export const VERIFY_SELF_GRACE_MS = 5 * 60_000
/** Section-level change kinds that count as "content changed" (page-level events have no anchor). */
const SECTION_KINDS = ['added', 'modified', 'removed', 'renamed'] as const
const verifierUser = alias(users, 'verifier')

interface VerificationRow {
  pageId: string
  verifiedAt: Date
  expiresAt: Date
  baseSeq: number
  note: string | null
  verifiedBy: string | null
  verifierName: string | null
}

/** Changed sections (distinct anchors) and whether a change too large to diff was logged, per page. */
async function changesSince(rows: VerificationRow[]): Promise<Map<string, { sections: number; large: boolean }>> {
  const out = new Map<string, { sections: number; large: boolean }>()
  if (rows.length === 0) return out
  const ids = rows.map((r) => r.pageId)
  const res = (await db.execute(sql`
    SELECT v.page_id AS "pageId",
           count(DISTINCT c.anchor)::int AS "sections",
           coalesce(bool_or(c.large), false) AS "large"
    FROM page_verifications v
    JOIN page_changes c
      ON c.page_id = v.page_id
     AND c.seq > v.base_seq
     AND c.anchor IS NOT NULL
     AND c.kind IN (${sql.join(SECTION_KINDS.map((k) => sql`${k}`), sql`, `)})
     AND NOT (
       v.verified_by IS NOT NULL AND c.actor_id = v.verified_by
       AND c.changed_at <= v.verified_at + make_interval(secs => ${VERIFY_SELF_GRACE_MS / 1000})
     )
    WHERE v.page_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY v.page_id
  `)) as unknown as { pageId: string; sections: number; large: boolean }[]
  for (const r of res) out.set(r.pageId, { sections: Number(r.sections), large: !!r.large })
  return out
}

function toDTO(
  r: VerificationRow,
  changed: { sections: number; large: boolean } | undefined,
  now: number,
  expiringDays: number,
): PageVerificationDTO {
  const expired = r.expiresAt.getTime() <= now
  const sections = changed?.sections ?? 0
  return {
    state: expired ? 'expired' : 'verified',
    expiringSoon: !expired && r.expiresAt.getTime() - now <= expiringDays * DAY_MS,
    verifiedAt: r.verifiedAt.toISOString(),
    verifiedBy: r.verifiedBy ? { id: r.verifiedBy, name: r.verifierName ?? '' } : null,
    expiresAt: r.expiresAt.toISOString(),
    note: r.note,
    changedSections: sections,
    changedMuch: sections >= VERIFY_CHANGED_MANY || !!changed?.large,
  }
}

const rowColumns = {
  pageId: pageVerifications.pageId,
  verifiedAt: pageVerifications.verifiedAt,
  expiresAt: pageVerifications.expiresAt,
  baseSeq: pageVerifications.baseSeq,
  note: pageVerifications.note,
  verifiedBy: pageVerifications.verifiedBy,
  verifierName: verifierUser.name,
}

/** Verification of each page that has one (callers have already checked visibility). */
export async function verificationsFor(
  pageIds: string[],
  opts: { now?: number; expiringDays?: number } = {},
): Promise<Map<string, PageVerificationDTO>> {
  const out = new Map<string, PageVerificationDTO>()
  const ids = [...new Set(pageIds)].slice(0, 500)
  if (ids.length === 0) return out
  const rows = await db
    .select(rowColumns)
    .from(pageVerifications)
    .leftJoin(verifierUser, eq(verifierUser.id, pageVerifications.verifiedBy))
    .where(inArray(pageVerifications.pageId, ids))
  const changed = await changesSince(rows)
  const now = opts.now ?? Date.now()
  for (const r of rows) out.set(r.pageId, toDTO(r, changed.get(r.pageId), now, opts.expiringDays ?? VERIFY_EXPIRING_DAYS))
  return out
}

/** The page's change-feed high-water mark: later rows are "changed since verification". */
export async function pageChangeHighWater(pageId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT coalesce(max(seq), 0)::text AS s FROM page_changes WHERE page_id = ${pageId}::uuid
  `)) as unknown as { s: string }[]
  return Number(rows[0]?.s ?? 0)
}

/**
 * Verified pages of a workspace that `viewerId` can see (live pages only), soonest expiry first,
 * split into expired / expiring within `expiringDays` / the rest. `mine` = verified by the viewer.
 */
export async function listVerified(
  workspaceId: string,
  viewerId: string,
  opts: { expiringDays?: number; mine?: boolean; now?: number } = {},
): Promise<VerifiedListDTO> {
  const expiringDays = opts.expiringDays ?? VERIFY_EXPIRING_DAYS
  const now = opts.now ?? Date.now()
  const rows = await db
    .select({ ...rowColumns, title: pages.title, icon: pages.icon, kind: pages.kind })
    .from(pageVerifications)
    .innerJoin(pages, eq(pages.id, pageVerifications.pageId))
    .leftJoin(verifierUser, eq(verifierUser.id, pageVerifications.verifiedBy))
    .where(
      and(
        eq(pageVerifications.workspaceId, workspaceId),
        eq(pages.workspaceId, workspaceId),
        isNull(pages.deletedAt),
        visibleTo(viewerId),
        liveWorkspace(pages.workspaceId),
        opts.mine ? eq(pageVerifications.verifiedBy, viewerId) : undefined,
      ),
    )
    .orderBy(asc(pageVerifications.expiresAt), asc(pages.title))
    .limit(500)
  const changed = await changesSince(rows)
  const res: VerifiedListDTO = { expiringDays, expired: [], expiring: [], verified: [] }
  for (const r of rows) {
    const verification = toDTO(r, changed.get(r.pageId), now, expiringDays)
    const item: VerifiedPageItemDTO = { pageId: r.pageId, title: r.title, icon: r.icon, kind: r.kind, verification }
    if (verification.state === 'expired') res.expired.push(item)
    else if (verification.expiringSoon) res.expiring.push(item)
    else res.verified.push(item)
  }
  return res
}

// ---------------------------------------------------------------------------
// Agent output (docs/adr/1842-*): dates only, never "N days ago" (docs/adr/0937-*).
// ---------------------------------------------------------------------------

export interface VerificationFacts {
  state: 'verified' | 'stale'
  /** Server-local date the verification lapses (stale: lapsed). */
  until: string
  changedSections: number
  changedMuch: boolean
}

export async function verificationFactsFor(pageIds: string[]): Promise<Map<string, VerificationFacts>> {
  const out = new Map<string, VerificationFacts>()
  for (const [id, v] of await verificationsFor(pageIds)) {
    out.set(id, {
      state: v.state === 'expired' ? 'stale' : 'verified',
      until: localISODate(new Date(v.expiresAt)),
      changedSections: v.changedSections,
      changedMuch: v.changedMuch,
    })
  }
  return out
}

/**
 * read_page header line: `- verified: until 2026-12-10` / `- stale: verification lapsed 2026-11-01`,
 * plus `, 3 sections changed since` when the change feed has some.
 */
export function verificationLine(f: VerificationFacts | undefined): string | null {
  if (!f) return null
  const changed = f.changedSections > 0 ? `, ${f.changedSections} section${f.changedSections === 1 ? '' : 's'} changed since` : ''
  return f.state === 'verified' ? `verified: until ${f.until}${changed}` : `stale: verification lapsed ${f.until}${changed}`
}

/** find_context fragment note: `; verified` / `; verified, changed since` / `; stale: verification lapsed`. */
export function verificationNote(f: VerificationFacts | undefined): string {
  if (!f) return ''
  if (f.state === 'stale') return '; stale: verification lapsed'
  return f.changedMuch ? '; verified, changed since' : '; verified'
}
