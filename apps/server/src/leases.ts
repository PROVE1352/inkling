import { sql } from 'drizzle-orm'
import { CLAIM_TTL_DEFAULT_S, CLAIM_TTL_MAX_S } from '@inkling/shared'
import type { SectionClaimDTO } from '@inkling/shared'
import type { AuthUser } from './auth'
import { findSection } from './context/chunker'
import { readOutline } from './context/sectionSource'
import type { OutlineSection } from './context/sectionSource'
import { db } from './db/index'
import { AppError, badRequest } from './errors'

/**
 * Section claims (docs/adr/1535-*, 1536-*): an agent connection says "I am working on this section
 * until …" so that other agents' patches of it are refused for a few minutes. People are never
 * blocked: the web app only shows the claim next to the heading.
 *
 * Stored in `section_leases` (one row per page + anchor) so that every server process sees the same
 * claims; an expired row counts as free everywhere (`expires_at > now()` from the database clock)
 * and housekeeping deletes it. A claim belongs to a connection ('grant:<id>' for OAuth/MCP,
 * 'token:<id>' for a personal API token); browser sessions do not claim.
 */

/** Live claims one connection may hold at once (a claim is a section, not a page). */
export const MAX_CLAIMS_PER_CONNECTION = 20

/** 'grant:<id>' / 'token:<id>' of a bearer request, '' for a browser session. */
export function connectionKey(user: Pick<AuthUser, 'grantId' | 'tokenId'>): string {
  return user.grantId ? `grant:${user.grantId}` : user.tokenId ? `token:${user.tokenId}` : ''
}

interface LeaseRow {
  pageId: string
  anchor: string
  blockId: string | null
  userId: string
  connection: string
  via: string | null
  name: string
  expiresAt: string
}

const toDto = (r: LeaseRow, mine: string): SectionClaimDTO => ({
  pageId: r.pageId,
  anchor: r.anchor,
  blockId: r.blockId,
  by: r.via || r.name,
  userId: r.userId,
  mine: mine !== '' && r.connection === mine,
  expiresAt: new Date(r.expiresAt).toISOString(),
})

/** Live claims on a page, by anchor (the caller has checked that the page is visible). */
export async function pageClaims(pageId: string, user: Pick<AuthUser, 'grantId' | 'tokenId'>): Promise<SectionClaimDTO[]> {
  const rows = (await db.execute(sql`
    SELECT l.page_id AS "pageId", l.anchor, l.block_id AS "blockId", l.user_id AS "userId", l.connection, l.via,
           u.name, l.expires_at AS "expiresAt"
      FROM section_leases l JOIN users u ON u.id = l.user_id
     WHERE l.page_id = ${pageId} AND l.expires_at > now()
     ORDER BY l.anchor
  `)) as unknown as LeaseRow[]
  const mine = connectionKey(user)
  return rows.map((r) => toDto(r, mine))
}

/** The live claim on `section` (matched by heading block id, else anchor), or null. */
export function claimOf(claims: SectionClaimDTO[], section: Pick<OutlineSection, 'anchor' | 'blockId'>): SectionClaimDTO | null {
  return claims.find((c) => (c.blockId && section.blockId ? c.blockId === section.blockId : c.anchor === section.anchor)) ?? null
}

/** "claimed by Claude Desktop until 2026-11-09T10:15Z" (minute precision, absolute: ADR 0937). */
export function claimLine(c: SectionClaimDTO): string {
  return `claimed by ${c.mine ? 'this connection' : c.by} until ${c.expiresAt.slice(0, 16)}Z`
}

/** Resolves `ref` (anchor, heading text, heading path or block id) on the page's outline. */
export async function sectionForClaim(pageId: string, ref: string): Promise<OutlineSection> {
  const outline = await readOutline(pageId)
  const s = findSection(outline, ref)
  if (!s) {
    const list = outline.slice(0, 30).map((x) => x.anchor).join(', ')
    throw new AppError(404, 'SECTION_NOT_FOUND', `Section "${ref}" not found. Available anchors: ${list || '(none: the page has no headings)'}`)
  }
  return s
}

/**
 * Claims (or extends) `section` for the request's connection. Fails with 409 SECTION_CLAIMED when
 * another connection holds a live claim; an expired claim is taken over.
 */
export async function claimSection(
  user: AuthUser,
  page: { id: string; workspaceId: string },
  section: OutlineSection,
  ttlSeconds = CLAIM_TTL_DEFAULT_S,
): Promise<SectionClaimDTO> {
  const conn = connectionKey(user)
  if (!conn) throw badRequest('Section claims belong to an agent connection (MCP or API token); people are never blocked')
  const ttl = Math.min(Math.max(Math.round(ttlSeconds), 30), CLAIM_TTL_MAX_S)
  const [count] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM section_leases
     WHERE connection = ${conn} AND expires_at > now() AND NOT (page_id = ${page.id} AND anchor = ${section.anchor})
  `)) as unknown as { n: number }[]
  if ((count?.n ?? 0) >= MAX_CLAIMS_PER_CONNECTION) {
    throw new AppError(429, 'TOO_MANY_CLAIMS', `This connection already holds ${MAX_CLAIMS_PER_CONNECTION} section claims; release_section the ones you are done with`)
  }
  const rows = (await db.execute(sql`
    INSERT INTO section_leases (page_id, anchor, block_id, workspace_id, user_id, connection, via, expires_at)
    VALUES (${page.id}, ${section.anchor}, ${section.blockId}, ${page.workspaceId}, ${user.id}, ${conn}, ${user.via ?? null},
            now() + make_interval(secs => ${ttl}))
    ON CONFLICT (page_id, anchor) DO UPDATE
       SET block_id = EXCLUDED.block_id, user_id = EXCLUDED.user_id, connection = EXCLUDED.connection, via = EXCLUDED.via,
           expires_at = EXCLUDED.expires_at, created_at = CASE WHEN section_leases.connection = EXCLUDED.connection
                                                              THEN section_leases.created_at ELSE now() END
     WHERE section_leases.connection = EXCLUDED.connection OR section_leases.expires_at <= now()
    RETURNING page_id AS "pageId", anchor, block_id AS "blockId", user_id AS "userId", connection, via, expires_at AS "expiresAt"
  `)) as unknown as Omit<LeaseRow, 'name'>[]
  if (!rows[0]) {
    const held = claimOf(await pageClaims(page.id, user), section)
    throw claimedError(section.anchor, held)
  }
  return toDto({ ...rows[0], name: user.name }, conn)
}

/** Releases the connection's claim on `anchor` (no-op when it holds none). Returns whether one was released. */
export async function releaseSection(user: AuthUser, pageId: string, anchor: string): Promise<boolean> {
  const conn = connectionKey(user)
  if (!conn) return false
  const rows = (await db.execute(sql`
    DELETE FROM section_leases WHERE page_id = ${pageId} AND anchor = ${anchor} AND connection = ${conn} RETURNING 1 AS x
  `)) as unknown as unknown[]
  return rows.length > 0
}

export function claimedError(anchor: string, held: SectionClaimDTO | null): AppError {
  const who = held ? `${held.by} until ${held.expiresAt.slice(0, 16)}Z` : 'another connection'
  return new AppError(
    409,
    'SECTION_CLAIMED',
    `Section "${anchor}" is claimed by ${who}; nothing was written. Work on another section, wait for the claim to end, ` +
      'or pass suggest=true to leave your change as a suggestion for a person to accept.',
    undefined,
    held ? { claim: held } : undefined,
  )
}

/**
 * Write check for agent connections (docs/adr/1536-*): throws SECTION_CLAIMED when another
 * connection holds a live claim on `ref`'s section (or, with `wholePage`, on any section of the page).
 * Browser sessions are never checked. One indexed lookup when the page has no live claim.
 */
export async function assertNotClaimed(user: AuthUser, pageId: string, ref: string | null): Promise<void> {
  const conn = connectionKey(user)
  if (!conn) return
  const claims = (await pageClaims(pageId, user)).filter((c) => !c.mine)
  if (!claims.length) return
  if (ref === null) {
    const c = claims[0]
    throw new AppError(
      409,
      'SECTION_CLAIMED',
      `Section "${c.anchor}" of this page is claimed by ${c.by} until ${c.expiresAt.slice(0, 16)}Z, so the whole body cannot be ` +
        'replaced now; nothing was written. Use patch_section on other sections, wait, or pass the change as a suggestion.',
      undefined,
      { claim: c },
    )
  }
  const outline = await readOutline(pageId)
  const s = findSection(outline, ref)
  if (!s) return // the patch itself reports the missing section (or follows a rename, then checks again)
  const held = claimOf(claims, s)
  if (held) throw claimedError(s.anchor, held)
}

/** Housekeeping: deletes claims that ended more than a minute ago. */
export async function sweepExpiredLeases(): Promise<number> {
  const rows = (await db.execute(sql`
    DELETE FROM section_leases WHERE expires_at < now() - interval '1 minute' RETURNING 1 AS x
  `)) as unknown as unknown[]
  return rows.length
}
