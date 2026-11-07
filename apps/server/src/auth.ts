import { hash, verify } from '@node-rs/argon2'
import { eq, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from './db/index'
import { sessions, users } from './db/schema'
import { env } from './env'
import { forbidden, unauthorized } from './errors'
import { getBearerUser, MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET, readBearer } from './oauth'
import { newSessionToken } from './util'

export const SESSION_COOKIE = 'inkling_sid'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface AuthUser {
  id: string
  email: string
  name: string
  isAdmin: boolean
}

// Add the authenticated user to FastifyRequest (declaration merging)
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
    /** How the request authenticated: 'bearer' = MCP OAuth access token (no admin API) */
    authVia?: 'cookie' | 'bearer'
  }
}

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

export async function createSession(
  userId: string,
  opts: { expectPasswordHash?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  if (opts.expectPasswordHash === undefined) {
    await db.insert(sessions).values({ token, userId, expiresAt })
    return { token, expiresAt }
  }
  // Password login (A-M3): argon2 verification takes ~100 ms, and a password reset committing in
  // that window deletes every session — but not one inserted after it. Insert only while the
  // hash that was just verified is still the stored one; otherwise the login is rejected.
  const rows = (await db.execute(sql`
    INSERT INTO sessions (token, user_id, expires_at)
    SELECT ${token}, u.id, ${expiresAt.toISOString()}::timestamptz FROM users u
     WHERE u.id = ${userId} AND u.password_hash = ${opts.expectPasswordHash}
    RETURNING token
  `)) as unknown as { token: string }[]
  if (rows.length === 0) throw unauthorized('Your password was just changed. Sign in again.')
  return { token, expiresAt }
}

export async function getSessionUser(token: string): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  // Delete an expired session and treat the request as unauthenticated
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, token))
    return null
  }

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.isAdmin }
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token))
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
export async function requireUser(req: FastifyRequest): Promise<void> {
  const bearer = readBearer(req.headers.authorization)
  if (bearer !== null) {
    // The token is valid only in the /mcp handler's internal inject; direct REST use from outside is refused.
    if (req.headers[MCP_INTERNAL_HEADER] !== MCP_INTERNAL_SECRET) {
      throw unauthorized('MCP access tokens can only be used at /mcp')
    }
    const user = bearer ? await getBearerUser(bearer) : null
    if (!user) throw unauthorized('Invalid access token')
    req.user = user
    req.authVia = 'bearer'
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
