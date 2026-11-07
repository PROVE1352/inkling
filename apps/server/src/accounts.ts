import { randomBytes } from 'node:crypto'
import { and, eq, lt, ne, sql } from 'drizzle-orm'
import { hashPassword } from './auth'
import { db } from './db/index'
import {
  icalTokens,
  oauthGrants,
  emailVerifications,
  passwordResetCodes,
  passwordResetRequests,
  sessions,
  users,
} from './db/schema'
import { env, mailEnabled } from './env'
import { sha256 } from './oauth'
import { closeUserConnections } from './liveConnections'
import { hashSessionToken } from './sessionTokens'
import { newSignupKey } from './util'

/**
 * Shared account-management helpers: password reset/change, reset codes, email verification,
 * admin protection. Kept here so the routes (routes/auth.ts, routes/admin.ts) and ops scripts
 * follow the same rules.
 */

export const RESET_CODE_TTL_MS = 24 * 60 * 60 * 1000
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Email suffix of delegated-account mirrors (e.g. '@delegated.local') */
export const DELEGATED_EMAIL_SUFFIX = `@${env.delegatedEmailDomain}`

export const isDelegatedEmail = (email: string) =>
  email.toLowerCase().endsWith(DELEGATED_EMAIL_SUFFIX)

/** Does REQUIRE_EMAIL_VERIFICATION actually apply? (With mail off there is no way to verify.) */
export const verificationEnforced = () => env.requireEmailVerification && mailEnabled

/**
 * Transaction advisory lock that serializes changes to the set of admins (delete, demote,
 * bootstrap promotion), so two admins deleting each other at once cannot leave zero admins.
 */
const ADMIN_LOCK_KEY = 4_651_201

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function withAdminLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
    return fn(tx)
  })
}

/**
 * New-install bootstrap: if there is no admin at all, promote this user to admin.
 * Does nothing when an admin already exists. true when promoted.
 */
export async function promoteIfNoAdmin(userId: string): Promise<boolean> {
  // Fast path: if an admin exists, finish without locking (this runs on every login).
  const any = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1)
  if (any.length > 0) return false
  return withAdminLock(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ isAdmin: true })
      .where(
        and(
          eq(users.id, userId),
          sql`not exists (select 1 from ${users} where ${users.isAdmin} = true)`,
        ),
      )
      .returning({ id: users.id })
    return updated.length > 0
  })
}

/** Mark pending reset requests as resolved */
export async function resolvePendingRequests(userId: string, by: string | null): Promise<void> {
  await db
    .update(passwordResetRequests)
    .set({ status: 'resolved', resolvedBy: by, resolvedAt: new Date() })
    .where(and(eq(passwordResetRequests.userId, userId), eq(passwordResetRequests.status, 'pending')))
}

/**
 * Replace the password + clean up sessions. With keepSessionToken only that session survives
 * (a self-service change). All outstanding reset codes are discarded and pending reset requests
 * are closed as resolved.
 */
export async function setPassword(
  userId: string,
  newPassword: string,
  opts: { keepSessionToken?: string; resolvedBy?: string | null } = {},
): Promise<void> {
  const passwordHash = await hashPassword(newPassword)
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId))
    await tx
      .delete(sessions)
      .where(
        opts.keepSessionToken
          ? and(eq(sessions.userId, userId), ne(sessions.token, hashSessionToken(opts.keepSessionToken)))
          : eq(sessions.userId, userId),
      )
    await tx.delete(passwordResetCodes).where(eq(passwordResetCodes.userId, userId))
    // OAuth/MCP grants (access + 60-day refresh tokens) were minted under the old password:
    // someone who connected a client with a stolen session must not keep access (TODO #3).
    await tx.delete(oauthGrants).where(eq(oauthGrants.userId, userId))
    // The iCal feed URL is a bearer credential as well: a reset must cut it off (A-M3).
    await tx.delete(icalTokens).where(eq(icalTokens.userId, userId))
    await tx
      .update(passwordResetRequests)
      .set({ status: 'resolved', resolvedBy: opts.resolvedBy ?? null, resolvedAt: new Date() })
      .where(
        and(eq(passwordResetRequests.userId, userId), eq(passwordResetRequests.status, 'pending')),
      )
  })
  // Collab sockets opened with a now-deleted session (docs/adr/0754-*).
  closeUserConnections(userId, { includeInbox: true, keepSessionToken: opts.keepSessionToken })
}

/** Delete all of a user's sessions */
export async function revokeSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
  closeUserConnections(userId, { includeInbox: true })
}

/**
 * Issue a single-use reset code; earlier codes are discarded (only the newest is valid). The DB
 * keeps only a hash; the raw code is only returned (shown once on screen / mailed, then dropped).
 */
export async function issueResetCode(
  userId: string,
  createdBy: string | null,
): Promise<{ code: string; expiresAt: Date }> {
  const code = newSignupKey()
  const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS)
  await db.transaction(async (tx) => {
    // Two concurrent issues used to both delete (nothing) and both insert → two valid codes.
    // The per-user lock makes delete+insert one step (A-M3).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'reset-code:' + userId}))`)
    await tx.delete(passwordResetCodes).where(eq(passwordResetCodes.userId, userId))
    await tx.insert(passwordResetCodes).values({
      codeHash: sha256(normalizeCode(code)),
      userId,
      expiresAt,
      createdBy,
    })
  })
  return { code, expiresAt }
}

/** Normalize code input: trim + uppercase (the code alphabet is uppercase only) */
export const normalizeCode = (code: string) => code.trim().toUpperCase()

/** Is the reset code valid for that user (without consuming it)? Used to check admin mail resends */
export async function isValidResetCode(userId: string, code: string): Promise<boolean> {
  const rows = await db
    .select({ h: passwordResetCodes.codeHash })
    .from(passwordResetCodes)
    .where(
      and(
        eq(passwordResetCodes.codeHash, sha256(normalizeCode(code))),
        eq(passwordResetCodes.userId, userId),
        sql`${passwordResetCodes.expiresAt} > now()`,
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** Consume a reset code (single use). true when it was valid. */
export async function consumeResetCode(userId: string, code: string): Promise<boolean> {
  const rows = await db
    .delete(passwordResetCodes)
    .where(
      and(
        eq(passwordResetCodes.codeHash, sha256(normalizeCode(code))),
        eq(passwordResetCodes.userId, userId),
        sql`${passwordResetCodes.expiresAt} > now()`,
      ),
    )
    .returning({ h: passwordResetCodes.codeHash })
  return rows.length > 0
}

/** Issue an email verification token: earlier tokens discarded, only a hash in the DB. Returns the raw token. */
export async function issueVerifyToken(userId: string, email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.transaction(async (tx) => {
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId))
    await tx.insert(emailVerifications).values({
      tokenHash: sha256(token),
      userId,
      email: email.toLowerCase(),
      expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    })
  })
  return token
}

/**
 * Consume a verification token → verified if the account email is still the one it was sent to.
 * Returns the verified email on success.
 */
export async function consumeVerifyToken(token: string): Promise<string | null> {
  const [row] = await db
    .delete(emailVerifications)
    .where(
      and(
        eq(emailVerifications.tokenHash, sha256(token)),
        sql`${emailVerifications.expiresAt} > now()`,
      ),
    )
    .returning({ userId: emailVerifications.userId, email: emailVerifications.email })
  if (!row) return null
  const updated = await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(and(eq(users.id, row.userId), eq(users.email, row.email), eq(users.origin, 'local')))
    .returning({ email: users.email })
  return updated[0]?.email ?? null
}

/** Clean up expired reset codes and verification tokens (housekeeping) */
export async function purgeExpiredAccountTokens(now: Date): Promise<number> {
  const a = await db
    .delete(passwordResetCodes)
    .where(lt(passwordResetCodes.expiresAt, now))
    .returning({ h: passwordResetCodes.codeHash })
  const b = await db
    .delete(emailVerifications)
    .where(lt(emailVerifications.expiresAt, now))
    .returning({ h: emailVerifications.tokenHash })
  return a.length + b.length
}
