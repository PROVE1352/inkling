import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { hasGrantsSql } from './pageGrants'
import { API_TOKEN_PREFIX } from '@inkling/shared'
import type { AccessRange, AdminApiTokenDTO, ApiTokenDTO } from '@inkling/shared'
import { db } from './db/index'
import { apiTokens, users } from './db/schema'
import type { AuthUser } from './auth'
import { sha256, STORED_SCOPE_FULL, STORED_SCOPE_READ_ONLY, canWriteFromScopes } from './oauth'
import { columnsToRange, rangeToColumns, rangeView, rootWorkspaceSql, scopeFromColumns } from './tokenRange'

/**
 * Personal API tokens (docs/adr/1201-*).
 *
 *   ink_pat_<43 base64url characters>   (32 random bytes)
 *
 * Only `sha256(token)` is stored (like sessions, docs/adr/1060-*); the lookup is an equality match on
 * the hash of a 256-bit random value, so no constant-time compare is needed. The fixed prefix lets a
 * person, a log scrubber or a secret scanner recognise a leaked token, and lets `requireUser` tell it
 * from an OAuth access token (`ink_at_`, valid only inside /mcp) without a lookup.
 */

const TOKEN_RE = /^ink_pat_[A-Za-z0-9_-]{43}$/
/** last_used_at / last_used_ip are written at most this often per token (like oauth_grants). */
const TOUCH_INTERVAL_MS = 60_000

export function isApiTokenShaped(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX)
}

export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Display prefix kept in the database: `ink_pat_` + 4 characters. */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, API_TOKEN_PREFIX.length + 4)
}

export async function createApiToken(
  userId: string,
  input: { name: string; expiresInDays: number | null; access: 'read' | 'write'; range: AccessRange },
): Promise<{ id: string; secret: string }> {
  const secret = newApiToken()
  const expiresAt = input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000)
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      name: input.name,
      tokenHash: sha256(secret),
      prefix: tokenDisplayPrefix(secret),
      scope: input.access === 'write' ? STORED_SCOPE_FULL : STORED_SCOPE_READ_ONLY,
      ...rangeToColumns(input.range),
      expiresAt,
    })
    .returning({ id: apiTokens.id })
  return { id: row.id, secret }
}

/**
 * The user for a valid, unexpired API token, with its scope and range; null otherwise. The root
 * page's workspace of a subtree range is read in the same statement. last_used_at / last_used_ip
 * are updated at most once a minute.
 */
export async function getApiTokenUser(token: string, ip: string | null): Promise<AuthUser | null> {
  if (!TOKEN_RE.test(token)) return null
  const rows = await db
    .select({
      tokenId: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      rangeKind: apiTokens.rangeKind,
      rangeWorkspaceIds: apiTokens.rangeWorkspaceIds,
      rangePageId: apiTokens.rangePageId,
      rootWorkspaceId: rootWorkspaceSql(apiTokens.rangePageId),
      lastUsedAt: apiTokens.lastUsedAt,
      lastUsedIp: apiTokens.lastUsedIp,
      id: users.id,
      email: users.email,
      name_: users.name,
      isAdmin: users.isAdmin,
      hasGrants: hasGrantsSql(users.id),
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, sha256(token)),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const now = Date.now()
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS || (ip && ip !== row.lastUsedIp)) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now), lastUsedIp: ip })
      .where(eq(apiTokens.id, row.tokenId))
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name_,
    isAdmin: row.isAdmin,
    scope: row.scope,
    tokenId: row.tokenId,
    range: scopeFromColumns(row.id, row, row.rootWorkspaceId),
    // page rows (docs/adr/1253-*): guest workspaces are hidden from tokens
    ...(row.hasGrants ? { hasGrants: true } : {}),
  }
}

function access(scope: string): 'read' | 'write' {
  return canWriteFromScopes(scope) ? 'write' : 'read'
}

export async function listApiTokens(userId: string): Promise<ApiTokenDTO[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))
  const out: ApiTokenDTO[] = []
  for (const r of rows) out.push(await toDto(userId, r))
  return out
}

export async function getApiToken(userId: string, id: string): Promise<ApiTokenDTO | null> {
  const [r] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .limit(1)
  return r ? toDto(userId, r) : null
}

async function toDto(userId: string, r: typeof apiTokens.$inferSelect): Promise<ApiTokenDTO> {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    access: access(r.scope),
    range: await rangeView(userId, r),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    lastUsedIp: r.lastUsedIp,
  }
}

export async function countApiTokens(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
  return r?.n ?? 0
}

/** Instance admin view: a user's tokens without range details. */
export async function adminListApiTokens(userId: string): Promise<AdminApiTokenDTO[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    access: access(r.scope),
    rangeKind: columnsToRange(r).kind,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  }))
}

/** Revokes every token of `userId` (password reset, admin action). Returns how many. */
export async function revokeAllApiTokens(userId: string, exec: Pick<typeof db, 'delete'> = db): Promise<number> {
  const rows = await exec.delete(apiTokens).where(eq(apiTokens.userId, userId)).returning({ id: apiTokens.id })
  return rows.length
}

/** Expired tokens are removed by the hourly housekeeping (a token without expiry stays). */
export async function purgeExpiredApiTokens(now: Date): Promise<number> {
  const rows = await db.delete(apiTokens).where(lt(apiTokens.expiresAt, now)).returning({ id: apiTokens.id })
  return rows.length
}
