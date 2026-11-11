import { and, count, eq, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { clearSessionCookie, getUser, requireAdmin, requireUser, SESSION_COOKIE, verifyPassword } from '../auth'
import { db } from '../db/index'
import { sessions, users } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { assertAccount, assertNotBanned, recordFailure, recordSuccess } from '../guard'
import { hashSessionToken } from '../sessionTokens'
import { twoFactorEnabled, verifySecondFactor } from '../twoFactor'
import { deleteAccount, planAccountDeletion } from './deletion'
import { afterLastMemberLeft, purgeDeletedWorkspace } from './workspacePurge'

/** A delegated or OIDC account proves itself with a session this recent (docs/adr/2514-*). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000

const strictRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

const deleteMeSchema = z.object({
  /** The account's sign-in email or ID, typed as confirmation. */
  confirm: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(40).optional(),
})

const nameSchema = z.object({ name: z.string().max(200) })

/** What leaving deletes and what stays (GET /api/me/delete-preview). */
export interface DeletePreviewDTO {
  /** Deleted at once with their pages and files: the account is their only member. */
  deleted: { id: string; name: string; pages: number; files: number }[]
  /** The account is the only owner; another member takes over. */
  transferred: { id: string; name: string; to: { id: string; name: string } }[]
  /** Other workspaces: the account's shared pages and comments stay, without its name. */
  kept: { id: string; name: string }[]
  /** Private pages deleted in the other workspaces. */
  privatePages: number
  pages: number
  files: number
  /** What the request must carry: the password (local accounts), a 2FA code, or a recent sign-in. */
  needs: { password: boolean; code: boolean; recentSignIn: boolean }
  /** The text to type as confirmation (the sign-in email or ID). */
  confirm: string
  /** The only admin cannot leave (409 LAST_ADMIN). */
  lastAdmin: boolean
}

export async function registerAccountRoutes(api: FastifyInstance): Promise<void> {
  api.get('/me/delete-preview', { preHandler: requireUser }, async (req): Promise<DeletePreviewDTO> => {
    const me = getUser(req)
    const [u] = await db.select({ origin: users.origin, isAdmin: users.isAdmin }).from(users).where(eq(users.id, me.id)).limit(1)
    if (!u) throw notFound()
    const plan = await planAccountDeletion(db, me.id)
    const local = u.origin === 'local'
    return {
      deleted: plan.purge,
      transferred: plan.transfer.map((t) => ({ ...t.workspace, to: t.to })),
      kept: plan.kept,
      privatePages: plan.privatePages,
      pages: plan.purge.reduce((n, w) => n + w.pages, 0),
      files: plan.purge.reduce((n, w) => n + w.files, 0),
      needs: { password: local, code: local && (await twoFactorEnabled(me.id)), recentSignIn: !local },
      confirm: me.email,
      lastAdmin: u.isAdmin && (await otherAdmins(me.id)) === 0,
    }
  })

  /**
   * Leave (docs/adr/2514-*): browser sessions only. Local accounts send the current password (and a
   * 2FA code when it is on); delegated and OIDC accounts must have signed in within the last ten
   * minutes (401 REAUTH_REQUIRED). The confirmation is the sign-in email or ID. Deletes at once,
   * then ends the session.
   */
  api.delete('/me', { preHandler: requireUser, ...strictRateLimit }, async (req, reply) => {
    if (req.authVia !== 'cookie') throw forbidden('An account can only be deleted from a browser sign-in')
    const me = getUser(req)
    const body = deleteMeSchema.parse(req.body ?? {})
    const [u] = await db
      .select({ origin: users.origin, passwordHash: users.passwordHash, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1)
    if (!u) throw notFound()
    if (body.confirm.trim().toLowerCase() !== me.email.toLowerCase()) {
      throw new AppError(400, 'CONFIRM_MISMATCH', 'Type your sign-in email or ID to confirm')
    }
    if (u.isAdmin && (await otherAdmins(me.id)) === 0) {
      throw new AppError(409, 'LAST_ADMIN', 'You are the only admin of this server. Make another account an admin first.')
    }
    const acct = me.email.toLowerCase()
    if (u.origin === 'local') {
      // the sign-in guard: IP ban, account backoff, and a failure counts as a sign-in failure
      assertNotBanned(req)
      assertAccount(acct)
      if (!body.password || !(await verifyPassword(u.passwordHash, body.password))) {
        await recordFailure(req, 'delete-account', acct)
        throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect')
      }
      if (await twoFactorEnabled(me.id)) {
        if (!body.code) throw new AppError(400, 'TOTP_REQUIRED', 'Enter the code from your authenticator app')
        const r = await verifySecondFactor(me.id, body.code)
        if (r === 'invalid' || r === 'reused') {
          await recordFailure(req, 'delete-account', acct)
          throw new AppError(400, 'INVALID_TOTP_CODE', 'Incorrect code')
        }
      }
      recordSuccess(req, acct)
    } else {
      const token = req.cookies?.[SESSION_COOKIE]
      const [s] = token
        ? await db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.token, hashSessionToken(token))).limit(1)
        : []
      if (!s || Date.now() - s.createdAt.getTime() > REAUTH_WINDOW_MS) {
        throw new AppError(401, 'REAUTH_REQUIRED', 'Sign in again, then delete the account within ten minutes')
      }
    }
    const res = await deleteAccount(me.id, { by: 'self', log: (m) => req.log.warn(m) })
    clearSessionCookie(reply)
    return { ok: true, deletedWorkspaces: res.deletedWorkspaces, transferredWorkspaces: res.transferredWorkspaces }
  })

  /** "Delete now": a deleted workspace (still restorable) goes for good (docs/adr/2513-*). */
  api.delete('/workspaces/:id/permanent', { preHandler: requireUser }, async (req, reply) => {
    const me = getUser(req)
    const { id } = z.object({ id: z.uuid() }).parse(req.params)
    const { name } = nameSchema.parse(req.body ?? {})
    const blobs = await purgeDeletedWorkspace(me.id, id, name)
    await afterLastMemberLeft(id, blobs, (m) => req.log.warn(m))
    return reply.code(204).send()
  })

  /**
   * An account's expiry date (ACCOUNT_LIFETIME_DAYS, docs/adr/2515-*): read it, lift it
   * (`expiresAt: null`) or move it. Admins only.
   */
  api.get('/admin/users/:id/expiry', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params)
    const [u] = await db.select({ expiresAt: users.expiresAt }).from(users).where(eq(users.id, id)).limit(1)
    if (!u) throw notFound('USER_NOT_FOUND', 'User not found')
    return { expiresAt: u.expiresAt ? u.expiresAt.toISOString() : null }
  })

  api.patch('/admin/users/:id/expiry', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params)
    const body = z.object({ expiresAt: z.iso.datetime({ offset: true }).nullable() }).parse(req.body)
    const at = body.expiresAt === null ? null : new Date(body.expiresAt)
    if (at && at.getTime() <= Date.now()) throw badRequest('Pick a date in the future, or lift the expiry')
    const [u] = await db.update(users).set({ expiresAt: at }).where(eq(users.id, id)).returning({ expiresAt: users.expiresAt })
    if (!u) throw notFound('USER_NOT_FOUND', 'User not found')
    return { expiresAt: u.expiresAt ? u.expiresAt.toISOString() : null }
  })
}

async function otherAdmins(userId: string): Promise<number> {
  const [c] = await db.select({ n: count() }).from(users).where(and(eq(users.isAdmin, true), ne(users.id, userId)))
  return c?.n ?? 0
}
