import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from './db/index'

/**
 * Session tokens at rest (C-L7, docs/adr/1060-*).
 *
 * The browser keeps the raw token (cookie `inkling_sid`, 32 random bytes as 43 base64url
 * characters); `sessions.token` keeps only its SHA-256 as 64 lowercase hex characters. A leaked
 * database or backup then holds no usable session. The column keeps its name, so this needs no
 * schema migration — only the one-time data pass below. Both forms are easy to tell apart: a raw
 * token is never 64 hex characters.
 */

const HASH_RE = /^[0-9a-f]{64}$/

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * True when a presented cookie value may also be looked up as a legacy plaintext row. A value that
 * already looks like a stored hash never is: otherwise someone holding a leaked hash could present
 * it as the cookie and match the hashed row directly.
 */
export function mayBeLegacyToken(token: string): boolean {
  return !HASH_RE.test(token)
}

/**
 * The SQL of the one-time pass (also handed to operators who run it by hand). Idempotent: rows that
 * already hold a hash are left alone. pgcrypto is not needed; `sha256(bytea)` is built in (PG 11+).
 */
export const HASH_LEGACY_SESSIONS_SQL = `UPDATE sessions
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token !~ '^[0-9a-f]{64}$'`

/**
 * Boot-time data migration: hash every session row still stored in plaintext. Runs after the
 * schema migrations and before the server listens, so nobody is signed out. Rows inserted raw
 * later (an older deploy/cli-token.sh) still sign in and are hashed on first use (getSessionUser).
 */
export async function hashLegacySessionTokens(): Promise<number> {
  const rows = (await db.execute(sql.raw(`${HASH_LEGACY_SESSIONS_SQL} RETURNING 1`))) as unknown as unknown[]
  return rows.length
}
