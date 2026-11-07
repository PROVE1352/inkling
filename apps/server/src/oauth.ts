import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { configuredPublicOrigin } from './origin'
import { db } from './db/index'
import { oauthClients, oauthCodes, oauthGrants, users } from './db/schema'
import { env } from './env'
import type { AuthUser } from './auth'

// ---------------------------------------------------------------------------
// Shared OAuth 2.1 helpers for the remote MCP connector (routes in routes/oauth.ts, MCP in mcp.ts)
// ---------------------------------------------------------------------------

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60 days
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000 // 5 minutes
/** Read-only access: every tool that only reads (docs/adr/0935-*). */
export const SCOPE_READ = 'read'
/** Write access (implies read): create, edit, comment, move, trash. */
export const SCOPE_WRITE = 'write'
/**
 * The single scope issued before read/write existed. Grants holding it (or a null scope) keep full
 * access so connections made before the split keep working; it is accepted but no longer advertised.
 */
export const LEGACY_SCOPE = 'notes'
/** Scopes advertised in the RFC 8414 / RFC 9728 metadata. */
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const
/** Stored scope strings — the only two values new codes/grants get. */
export const STORED_SCOPE_FULL = `${SCOPE_READ} ${SCOPE_WRITE}`
export const STORED_SCOPE_READ_ONLY = SCOPE_READ
/** Kept as an alias for the full-access scope string (token responses for legacy null grants). */
export const OAUTH_SCOPE = STORED_SCOPE_FULL

export type OAuthAccess = 'read' | 'write'

function scopeTokens(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean)
}

/**
 * The one decision function for "may this token change data?" — used by requireUser (REST, defense
 * in depth), the /mcp handler (ToolCtx.canWrite) and the grants list. Legacy grants (null, empty or
 * containing 'notes') and anything containing 'write' may write; a grant holding only 'read' (or
 * only unknown scopes, fail-closed) may not. `undefined` scope = not a bearer request (cookie) → true.
 */
export function canWriteFromScopes(scope: string | null | undefined): boolean {
  const tokens = scopeTokens(scope)
  if (tokens.length === 0) return true
  return tokens.includes(SCOPE_WRITE) || tokens.includes(LEGACY_SCOPE)
}

/**
 * What an authorization request asks for. No scope, 'notes', 'write' or only unknown scopes
 * (e.g. 'openid') → 'write' (what every pre-split client expects); only 'read' → 'read'.
 */
export function requestedAccess(scope: string | null | undefined): OAuthAccess {
  const tokens = scopeTokens(scope)
  if (tokens.includes(SCOPE_WRITE) || tokens.includes(LEGACY_SCOPE)) return 'write'
  if (tokens.includes(SCOPE_READ)) return 'read'
  return 'write'
}

/**
 * The scope string to store on the code (→ grant): the user's consent choice, never broader than
 * the request (a client asking only for 'read' cannot be upgraded on the consent screen).
 * `choice` undefined (an older SPA build) = what the client requested.
 */
export function grantedScope(requested: string | null | undefined, choice: OAuthAccess | undefined): string {
  const asked = requestedAccess(requested)
  const access = asked === 'read' ? 'read' : (choice ?? asked)
  return access === 'write' ? STORED_SCOPE_FULL : STORED_SCOPE_READ_ONLY
}

const MAX_CLIENT_NAME = 60

/**
 * Display form of a client-registered name for "<user> (via <client>)" labels: C0/C1 controls,
 * bidi overrides/isolates and zero-width characters removed, whitespace collapsed, capped at
 * 60 code points (never splitting a surrogate pair). Empty → null. The web renders it as text
 * (React escapes it); it is never interpreted as HTML.
 */
export function sanitizeClientName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  const chars = Array.from(cleaned)
  return chars.length > MAX_CLIENT_NAME ? `${chars.slice(0, MAX_CLIENT_NAME - 1).join('').trimEnd()}…` : cleaned
}

/**
 * In-process secret attached only when the MCP handler calls REST routes via app.inject.
 * Bearer tokens are accepted only together with this header → using a token against REST directly
 * from outside gets 401, so a token can do no more than the MCP tool surface allows (no permanent
 * deletion, member management, etc.).
 */
export const MCP_INTERNAL_HEADER = 'x-inkling-mcp-internal'
export const MCP_INTERNAL_SECRET = randomBytes(32).toString('base64url')

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function newOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return computed === challenge
}

/** Externally visible origin — PUBLIC_URL first, else protocol + host (one trusted proxy hop). */
export function publicOrigin(req: FastifyRequest): string {
  // Configured value only (origin.ts, C-M1) — the issuer must not follow the Host header.
  return configuredPublicOrigin(req)
}

export function mcpResourceUrl(req: FastifyRequest): string {
  return `${publicOrigin(req)}/mcp`
}

// ---------------------------------------------------------------------------
// redirect_uri rules
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Registrable redirect_uri: https (any host) or loopback http (any port). No fragment. */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.hash) return false
  if (u.username || u.password) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return true
  return false
}

/**
 * Whether the requested redirect_uri matches a registered one: exact match, or for loopback http
 * a different port is allowed (RFC 8252 §7.3 — native apps open a random port each time).
 */
export function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true
  let r: URL
  try {
    r = new URL(requested)
  } catch {
    return false
  }
  if (r.protocol !== 'http:' || !LOOPBACK_HOSTS.has(r.hostname)) return false
  return registered.some((reg) => {
    try {
      const g = new URL(reg)
      return (
        g.protocol === 'http:' &&
        g.hostname === r.hostname &&
        g.pathname === r.pathname &&
        g.search === r.search
      )
    } catch {
      return false
    }
  })
}

export async function findClient(
  clientId: string,
): Promise<{ id: string; name: string; redirectUris: string[] } | null> {
  const row = (
    await db
      .select({ id: oauthClients.id, name: oauthClients.name, redirectUris: oauthClients.redirectUris })
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .limit(1)
  )[0]
  if (!row) return null
  const uris = Array.isArray(row.redirectUris)
    ? (row.redirectUris as unknown[]).filter((u): u is string => typeof u === 'string')
    : []
  return { id: row.id, name: row.name, redirectUris: uris }
}

// ---------------------------------------------------------------------------
// Bearer token → user
// ---------------------------------------------------------------------------

/**
 * Extracts the bearer token from the Authorization header.
 *   - no header / not Bearer → null (fall back to the cookie path)
 *   - Bearer but malformed → '' (the caller answers 401)
 */
export function readBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.*)$/i.exec(header.trim())
  if (!m) return null
  return m[1].trim()
}

/**
 * The user for a valid (unexpired) access token, with the grant's scope and the OAuth client's
 * sanitized name as `via` (provenance, docs/adr/0936-*). last_used_at is updated at most once a minute.
 */
export async function getBearerUser(token: string): Promise<AuthUser | null> {
  const rows = await db
    .select({
      grantId: oauthGrants.id,
      lastUsedAt: oauthGrants.lastUsedAt,
      scope: oauthGrants.scope,
      clientName: oauthClients.name,
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
    })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.accessHash, sha256(token)), gt(oauthGrants.accessExpiresAt, new Date())))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const now = Date.now()
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000) {
    await db
      .update(oauthGrants)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(oauthGrants.id, row.grantId))
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isAdmin: row.isAdmin,
    // '' would read as "legacy/full" in canWriteFromScopes, which is what a null grant means too.
    scope: row.scope ?? '',
    via: sanitizeClientName(row.clientName) ?? 'MCP client',
  }
}

/** Purges expired codes and grants — called by the hourly housekeeping. Returns the number deleted. */
export async function purgeExpiredOAuth(now: Date): Promise<number> {
  const c = await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.expiresAt, now))
    .returning({ h: oauthCodes.codeHash })
  const g = await db
    .delete(oauthGrants)
    .where(lt(oauthGrants.refreshExpiresAt, now))
    .returning({ id: oauthGrants.id })
  return c.length + g.length
}
