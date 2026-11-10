import { hash, verify } from '@node-rs/argon2'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify'
import { runAsAgent, runAsConnection } from './agentAccess'
import { db } from './db/index'
import { sessions, users } from './db/schema'
import { env } from './env'
import { forbidden, unauthorized } from './errors'
import {
  canWriteFromScopes,
  getBearerUser,
  MCP_INTERNAL_HEADER,
  MCP_INTERNAL_SECRET,
  readBearer,
} from './oauth'
import { hashSessionToken, mayBeLegacyToken } from './sessionTokens'
import { getApiTokenUser, isApiTokenShaped } from './apiTokens'
import { AGENT_TOKEN_PREFIX } from '@inkling/shared'
import { assertNotBanned, recordFailure } from './guard'
import { runInRange } from './tokenRange'
import { hasGrantsSql, peopleScopeFor, runAsGuest } from './pageGrants'
import { assertBearerRouteAllowed } from './tokenPolicy'
import type { RangeScope } from './tokenRange'
import { newSessionToken } from './util'

export const SESSION_COOKIE = 'inkling_sid'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface AuthUser {
  id: string
  email: string
  name: string
  isAdmin: boolean
  /**
   * Set only for MCP (OAuth bearer) requests: the OAuth client's display name, sanitized and
   * length-capped, so writes can be labelled "<user> (via <client>)" (docs/adr/0936-*).
   */
  via?: string | null
  /**
   * Set only for MCP (OAuth bearer) requests: the grant's stored scope string ('' = legacy/full).
   * Decide write access with canWriteFromScopes(scope) (docs/adr/0935-*).
   */
  scope?: string
  /** Set only for MCP (OAuth bearer) requests: the connection (grant) id (docs/adr/0947-*). */
  grantId?: string
  /** Set only for MCP (OAuth bearer) requests: the registered OAuth client id (docs/adr/0947-*). */
  clientId?: string
  /** Set only for personal API token requests (docs/adr/1201-*): the token's id. */
  tokenId?: string
  /**
   * Bearer requests only: the connection's range (docs/adr/1200-*); null or absent = everything the
   * user can see. requireUser runs the request inside it (tokenRange.ts).
   */
  range?: RangeScope | null
  /**
   * The account has rows in page_grants (docs/adr/1250-*), read in the user lookup statement.
   * requireUser then loads the guest scope (pageGrants.ts); false/absent = no extra statement.
   */
  hasGrants?: boolean
}

// Add the authenticated user to FastifyRequest (declaration merging)
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
    /**
     * How the request authenticated: 'bearer' = an MCP OAuth access token (through /mcp only) or a
     * personal API token (`user.tokenId` set). Both are refused by every browser-only route
     * (`authVia !== 'cookie'`) and by the admin API.
     */
    authVia?: 'cookie' | 'bearer'
  }
  interface FastifyContextConfig {
    /**
     * A non-GET route that never changes data (e.g. POST /workspaces/:id/query). Read-only MCP
     * tokens may call it; every other non-GET/HEAD route answers them 403 (docs/adr/0935-*).
     */
    bearerReadOnlyOk?: boolean
  }
}

/** The 403 a read-only MCP token gets on a write route (the MCP tools answer earlier, in wrapWrite). */
export const READ_ONLY_TOKEN_MESSAGE =
  "This connection is read-only (scope 'read'). Reconnect the Inkling connector and allow write access to edit notes"

/** The 403 a read-only personal API token gets on a write route (docs/adr/1201-*). */
export const READ_ONLY_API_TOKEN_MESSAGE =
  'This API token is read-only. Make a read and write token in Settings › Connections to change notes'

// ---------------------------------------------------------------------------
// Password hashing (@node-rs/argon2 default options)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export function verifyPassword(hashed: string, password: string): Promise<boolean> {
  return verify(hashed, password)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Issue a session. Returns the raw token for the cookie; the database keeps only its SHA-256
 * (C-L7, docs/adr/1060-*).
 */
export async function createSession(
  userId: string,
  opts: { expectPasswordHash?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken()
  const tokenHash = hashSessionToken(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  if (opts.expectPasswordHash === undefined) {
    await db.insert(sessions).values({ token: tokenHash, userId, expiresAt })
    return { token, expiresAt }
  }
  // Password login (A-M3): argon2 verification takes ~100 ms, and a password reset committing in
  // that window deletes every session — but not one inserted after it. Insert only while the
  // hash that was just verified is still the stored one; otherwise the login is rejected.
  const rows = (await db.execute(sql`
    INSERT INTO sessions (token, user_id, expires_at)
    SELECT ${tokenHash}, u.id, ${expiresAt.toISOString()}::timestamptz FROM users u
     WHERE u.id = ${userId} AND u.password_hash = ${opts.expectPasswordHash}
    RETURNING token
  `)) as unknown as { token: string }[]
  if (rows.length === 0) throw unauthorized('Your password was just changed. Sign in again.')
  return { token, expiresAt }
}

/**
 * Cookie value → user. Looked up by the token's hash; the equality match on a SHA-256 of a
 * 256-bit random value leaks nothing useful through timing. A legacy plaintext row (inserted by an
 * older deploy/cli-token.sh after the boot pass) also matches once and is hashed in place.
 */
export async function getSessionUser(token: string): Promise<AuthUser | null> {
  const tokenHash = hashSessionToken(token)
  const keys = mayBeLegacyToken(token) ? [tokenHash, token] : [tokenHash]
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      expiresAt: sessions.expiresAt,
      stored: sessions.token,
      hasGrants: hasGrantsSql(users.id),
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(inArray(sessions.token, keys))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  // Delete an expired session and treat the request as unauthenticated
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, row.stored))
    return null
  }

  if (row.stored !== tokenHash) {
    await db.update(sessions).set({ token: tokenHash }).where(eq(sessions.token, row.stored))
  }

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.isAdmin, ...(row.hasGrants ? { hasGrants: true } : {}) }
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token)
  const keys = mayBeLegacyToken(token) ? [tokenHash, token] : [tokenHash]
  await db.delete(sessions).where(inArray(sessions.token, keys))
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env.cookieSecure,
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env.cookieSecure,
  })
}

// ---------------------------------------------------------------------------
// preHandler / helpers
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler: cookie → session → req.user, 401 on failure.
 * With `Authorization: Bearer <MCP OAuth access token>` only that token is used, not the cookie
 * (MCP tools call the existing REST routes via app.inject, so visibility/membership checks apply
 * unchanged). The cookie path is unchanged (browsers never attach a bearer token automatically,
 * so the CSRF surface does not grow).
 */
export function requireUser(req: FastifyRequest): Promise<void>
export function requireUser(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void
export function requireUser(
  req: FastifyRequest,
  _reply?: FastifyReply,
  done?: HookHandlerDoneFunction,
): Promise<void> | void {
  const auth = authenticate(req)
  // Called directly (`await requireUser(req)`): no agent scope is needed by the caller.
  if (!done) return auth
  // As a preHandler: continue the request inside the agent scope for bearer requests, so
  // requireMembership / findVisiblePage can enforce per-workspace agent blocks (docs/adr/0947-*).
  // The scope has to be entered here, around `done`: the handler runs from inside that call.
  // A limited connection (docs/adr/1200-*) also runs inside its range, for OAuth grants and API
  // tokens alike; the access checks (requireMembership, visibleTo, agentAllowedSql) read it.
  auth
    // Page rows of the account (docs/adr/1252-*), read in the user lookup: with rows, continue inside
    // its guest scope, so visibleTo / pageInRangeSql narrow the workspaces where it is not a member
    // (for tokens: hide them, docs/adr/1253-*). Without rows the scope only says so (no statement).
    .then(() => (req.user ? peopleScopeFor(req.user.id, !!req.user.hasGrants, req.authVia !== 'cookie') : null))
    .then(
    (guest) => {
      const u = req.user
      const inner = u?.range ? () => runInRange(u.range!, () => done()) : () => done()
      const viaGuest = guest ? () => runAsGuest(guest, inner) : inner
      // Every bearer connection (grant or API token) runs in its connection scope: the suggest-only
      // rule after flagged content reads it (docs/adr/2040-*).
      const conn = req.authVia === 'bearer' && u ? (u.grantId ? `grant:${u.grantId}` : u.tokenId ? `token:${u.tokenId}` : null) : null
      const next = conn
        ? () =>
            runAsConnection(
              {
                key: conn,
                userId: u!.id,
                writes: req.method !== 'GET' && req.method !== 'HEAD' && req.routeOptions?.config?.bearerReadOnlyOk !== true,
                route: req.routeOptions?.url ?? '',
                memo: new Map(),
              },
              viaGuest,
            )
        : viaGuest
      if (req.authVia === 'bearer' && u?.grantId && u.clientId) {
        runAsAgent({ userId: u.id, grantId: u.grantId, clientId: u.clientId, clientName: u.via ?? null }, next)
      } else {
        next()
      }
    },
    (err: Error) => done(err),
  )
}

async function authenticate(req: FastifyRequest): Promise<void> {
  const bearer = readBearer(req.headers.authorization)
  if (bearer !== null && isApiTokenShaped(bearer)) {
    // Personal API token (docs/adr/1201-*): the REST API from outside, as its owner, within its
    // scope and range. Not an agent connection: agent blocks, agent lock rules and "via" labels are
    // for OAuth clients (docs/adr/0947-*, 0971-*), so writes read as the person's own.
    assertNotBanned(req)
    const user = await getApiTokenUser(bearer, req.ip)
    if (!user) {
      await recordFailure(req, 'api-token')
      throw unauthorized('Invalid or expired API token')
    }
    req.user = user
    req.authVia = 'bearer'
    if (
      !canWriteFromScopes(user.scope) &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.routeOptions?.config?.bearerReadOnlyOk !== true
    ) {
      throw forbidden(READ_ONLY_API_TOKEN_MESSAGE)
    }
    // Browser-only routes and routes that reach past the token's range (tokenPolicy.ts).
    assertBearerRouteAllowed(req, user.range)
    return
  }
  if (bearer !== null) {
    // The token is valid only in the /mcp handler's internal inject; direct REST use from outside is refused.
    // Agent connection tokens (`ink_agt_`, docs/adr/2060-*) are OAuth grants of kind 'token': the same rule.
    if (req.headers[MCP_INTERNAL_HEADER] !== MCP_INTERNAL_SECRET) {
      throw unauthorized(
        bearer.startsWith(AGENT_TOKEN_PREFIX)
          ? 'Agent connection tokens can only be used at /mcp; use a personal API token for the REST API'
          : 'MCP access tokens can only be used at /mcp',
      )
    }
    const user = bearer ? await getBearerUser(bearer) : null
    if (!user) throw unauthorized('Invalid access token')
    req.user = user
    req.authVia = 'bearer'
    // Defense in depth for read-only tokens: wrapWrite already refuses write tools, but any write
    // that reaches REST through inject (a future tool forgetting wrapWrite) is refused here too.
    if (
      !canWriteFromScopes(user.scope) &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      req.routeOptions?.config?.bearerReadOnlyOk !== true
    ) {
      throw forbidden(READ_ONLY_TOKEN_MESSAGE)
    }
    // Same route rules as API tokens (no MCP tool calls these; this is the backstop).
    assertBearerRouteAllowed(req, user.range)
    return
  }
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) throw unauthorized()
  const user = await getSessionUser(token)
  if (!user) throw unauthorized()
  req.user = user
  req.authVia = 'cookie'
}

/** requireUser + admin check: preHandler for operator endpoints such as signup-key management */
export async function requireAdmin(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  // MCP tokens never open the operator (admin) API: browser sessions only.
  if (req.authVia !== 'cookie') throw forbidden('Admins only')
  if (!req.user?.isAdmin) throw forbidden('Admins only')
}

/** Safely take req.user after requireUser. */
export function getUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized()
  return req.user
}
