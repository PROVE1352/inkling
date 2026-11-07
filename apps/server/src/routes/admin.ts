import { isIP } from 'node:net'
import { alias } from 'drizzle-orm/pg-core'
import { and, count, desc, eq, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  createSignupKeySchema,
  sendCredentialMailSchema,
  manualBanSchema,
  sendInviteMailSchema,
  setAdminSchema,
} from '@inkling/shared'
import {
  isValidResetCode,
  issueResetCode,
  issueVerifyToken,
  resolvePendingRequests,
  revokeSessions,
  setPassword,
  withAdminLock,
} from '../accounts'
import { getUser, requireAdmin, verifyPassword } from '../auth'
import { banIp, guardPolicy, ipKey, isAllowlisted, listBans, unbanIp } from '../guard'
import { db } from '../db/index'
import { closeUserConnections } from '../liveConnections'
import { lockWorkspaceMembers } from '../helpers'
import { purgeWorkspacesTx, unlinkUploadBlobs } from '../workspaceDeletion'
import { ipBans, pages, passwordResetCodes, passwordResetRequests, signupKeys, users, userTotp } from '../db/schema'
import { env, mailEnabled } from '../env'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { appOrigin, inviteMail, resetCodeMail, sendMail, tempPasswordMail, verifyMail } from '../mail'
import { newSignupKey, newTempPassword } from '../util'
import { resolveLocale } from '../i18n'
import { disableTwoFactor } from '../twoFactor'
import { HASH_RE, hashSignupKey, protectSecret, signupKeyHint, tryRevealSecret } from '../secretsAtRest'
import { registerAdminStatusRoutes } from '../status/routes'

/**
 * Admin-only operations API: issuing/revoking Inkling signup keys, user management (password
 * reset, forced deletion, admin rights, email verification), the password reset request queue,
 * and sending mail.
 *
 * Signup keys only create Inkling's own accounts (origin='local'); they have nothing to do with
 * the external auth server used for delegated sign-in. Delegated accounts (origin='delegated')
 * keep their password elsewhere, so password features do not apply to them
 * (400 DELEGATED_ACCOUNT). Forced deletion still works.
 */
/**
 * Route parameter → signup_keys.key. Admin screens pass the key's id (its SHA-256); an older client
 * passes the key itself, which is hashed. A raw key is never 64 hex characters (docs/adr/1110-*).
 */
function signupKeyId(param: string): string {
  return HASH_RE.test(param) ? param : hashSignupKey(param)
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: requireAdmin }
  // Admin endpoints that send mail: rate-limited so a hijacked admin account cannot spam
  const adminMail = {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }
  const log = (msg: string) => app.log.info(msg)
  // Server status summary for admins (docs/adr/1230-*)
  await registerAdminStatusRoutes(app)

  /** Load the target user; 404 if missing */
  const loadUser = async (id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('USER_NOT_FOUND', 'User not found')
    const [u] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        origin: users.origin,
        isAdmin: users.isAdmin,
        signupKey: users.signupKey,
        emailVerifiedAt: users.emailVerifiedAt,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
    if (!u) throw notFound('USER_NOT_FOUND', 'User not found')
    return u
  }

  /** Check the user is a valid password-feature target (local account, not yourself) */
  const passwordTarget = async (id: string, meId: string) => {
    const u = await loadUser(id)
    if (u.origin !== 'local') {
      throw new AppError(
        400,
        'DELEGATED_ACCOUNT',
        `Delegated sign-in (${env.delegatedAuthName}) accounts keep their password externally and cannot be reset here`,
      )
    }
    if (u.id === meId) {
      throw badRequest('Change your own password in Settings')
    }
    return u
  }

  const requireMail = () => {
    if (!mailEnabled) throw new AppError(501, 'MAIL_DISABLED', 'Email is not configured on this server')
  }

  /** All issued keys + who signed up with each. */
  app.get('/admin/signup-keys', admin, async () => {
    const rows = await db
      .select({
        id: signupKeys.key,
        keyEnc: signupKeys.keyEnc,
        keyHint: signupKeys.keyHint,
        note: signupKeys.note,
        maxUses: signupKeys.maxUses,
        usedCount: signupKeys.usedCount,
        expiresAt: signupKeys.expiresAt,
        lastUsedAt: signupKeys.lastUsedAt,
        createdAt: signupKeys.createdAt,
        createdByName: users.name,
      })
      .from(signupKeys)
      .leftJoin(users, eq(users.id, signupKeys.createdBy))
      .orderBy(desc(signupKeys.createdAt))

    // Key → signups. There are few keys, so load them all at once and group in memory.
    const joined = await db
      .select({
        signupKey: users.signupKey,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(sql`${users.signupKey} is not null`)
      .orderBy(users.createdAt)

    const byKey = new Map<string, typeof joined>()
    for (const u of joined) {
      if (!u.signupKey) continue
      const list = byKey.get(u.signupKey) ?? []
      list.push(u)
      byKey.set(u.signupKey, list)
    }

    const now = Date.now()
    return {
      keys: rows.map(({ keyEnc, ...k }) => ({
        ...k,
        // signup_keys.key is the SHA-256; the key to copy comes from its sealed copy (docs/adr/1110-*)
        key: tryRevealSecret('signup-key', keyEnc, k.id),
        expired: !!k.expiresAt && k.expiresAt.getTime() <= now,
        exhausted: k.usedCount >= k.maxUses,
        usedBy: (byKey.get(k.id) ?? []).map((u) => ({
          name: u.name,
          email: u.email,
          createdAt: u.createdAt,
        })),
      })),
    }
  })

  /** Issue a new key. Leave expiresInDays empty for no expiry. */
  app.post('/admin/signup-keys', admin, async (req) => {
    const body = createSignupKeySchema.parse(req.body)
    const me = getUser(req)

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    // Key collisions are negligible (31^16), but an insert failure is absorbed by retrying.
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = newSignupKey()
      const id = hashSignupKey(key)
      try {
        const [row] = await db
          .insert(signupKeys)
          .values({
            key: id,
            keyEnc: protectSecret('signup-key', key, id),
            keyHint: signupKeyHint(key),
            note: body.note?.trim() || null,
            maxUses: body.maxUses,
            expiresAt,
            createdBy: me.id,
          })
          .returning()
        const { keyEnc: _enc, ...rest } = row
        return { key: { ...rest, id, key, expired: false, exhausted: false, usedBy: [] } }
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string } }
        if (e?.code !== '23505' && e?.cause?.code !== '23505') throw err
      }
    }
    throw new AppError(500, 'KEY_GENERATION_FAILED', 'Could not generate a key')
  })

  /** Revoke a key. Accounts already created with it are kept. */
  app.delete('/admin/signup-keys/:key', admin, async (req) => {
    const { key } = req.params as { key: string }
    const deleted = await db
      .delete(signupKeys)
      .where(eq(signupKeys.key, signupKeyId(key)))
      .returning({ key: signupKeys.key })
    if (deleted.length === 0) throw notFound('KEY_NOT_FOUND', 'Signup key not found')
    return { ok: true }
  })

  /** Key → invite mail (the signup link has the key prefilled) */
  app.post('/admin/signup-keys/:key/send-invite', adminMail, async (req) => {
    requireMail()
    const { key } = req.params as { key: string }
    const { to } = sendInviteMailSchema.parse(req.body)
    const [k] = await db
      .select({ id: signupKeys.key, keyEnc: signupKeys.keyEnc, expiresAt: signupKeys.expiresAt })
      .from(signupKeys)
      .where(eq(signupKeys.key, signupKeyId(key)))
      .limit(1)
    if (!k) throw notFound('KEY_NOT_FOUND', 'Signup key not found')
    const raw = tryRevealSecret('signup-key', k.keyEnc, k.id)
    if (!raw) throw new AppError(409, 'KEY_NOT_REVEALABLE', 'This key can no longer be shown or sent. Issue a new key.')
    await sendMail(to, inviteMail({ key: raw, expiresAt: k.expiresAt, origin: appOrigin(req), locale: env.defaultLocale }), log)
    return { ok: true }
  })

  /** User list: who joined and how. Newest signups first. */
  app.get('/admin/users', admin, async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        origin: users.origin,
        isAdmin: users.isAdmin,
        signupKey: users.signupKey,
        signupKeyMaxUses: signupKeys.maxUses,
        signupKeyHint: signupKeys.keyHint,
        emailVerifiedAt: users.emailVerifiedAt,
        createdAt: users.createdAt,
        twoFactorAt: userTotp.enabledAt,
      })
      .from(users)
      .leftJoin(signupKeys, eq(signupKeys.key, users.signupKey))
      .leftJoin(userTotp, eq(userTotp.userId, users.id))
      .orderBy(desc(users.createdAt))
    return {
      users: rows.map(({ signupKeyMaxUses, signupKeyHint, twoFactorAt, ...u }) => ({
        ...u,
        // only a masked hint: users.signup_key is the key's SHA-256 (docs/adr/1110-*)
        signupKey: u.signupKey ? `••••-${signupKeyHint ?? '••••'}` : null,
        signupKeyRecovery: u.origin === 'local' && signupKeyMaxUses === 1,
        // Extension field (docs/adr/1061-*)
        twoFactor: !!twoFactorAt,
      })),
    }
  })

  /**
   * Grant/revoke admin rights. You cannot demote yourself or the last admin
   * (counted under an advisory lock so concurrent demotions cannot race).
   */
  app.patch('/admin/users/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    const body = setAdminSchema.parse(req.body)
    const me = getUser(req)

    if (id === me.id && !body.isAdmin) {
      throw badRequest('You cannot remove your own admin rights')
    }
    await loadUser(id)

    const row = await withAdminLock(async (tx) => {
      const [self] = await tx.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, me.id))
      if (!self?.isAdmin) throw forbidden('Admins only')
      if (!body.isAdmin) {
        const [c] = await tx
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.isAdmin, true), ne(users.id, id)))
        if ((c?.n ?? 0) === 0) throw badRequest("You can't remove the last admin's rights")
      }
      const [r] = await tx
        .update(users)
        .set({ isAdmin: body.isAdmin })
        .where(eq(users.id, id))
        .returning({ id: users.id, isAdmin: users.isAdmin })
      return r
    })
    if (!row) throw notFound('USER_NOT_FOUND', 'User not found')
    return { user: row }
  })

  /**
   * Forced deletion: deletes the users row. Content (pages, files, comments, snapshots,
   * templates, workspaces) stays with created_by etc. SET NULL; sessions, memberships, bookmarks,
   * the user's notifications and OAuth links cascade. The used_count of the signup key they used
   * goes back by 1 (never below 0). Not allowed for yourself or the last admin.
   */
  app.delete('/admin/users/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    const me = getUser(req)
    if (id === me.id) throw badRequest('You cannot delete your own account here')
    await loadUser(id)

    const blobIds: string[] = []
    let deletedWorkspaces = 0
    await withAdminLock(async (tx) => {
      const [self] = await tx.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, me.id))
      if (!self?.isAdmin) throw forbidden('Admins only')
      const [target] = await tx
        .select({ isAdmin: users.isAdmin, signupKey: users.signupKey })
        .from(users)
        .where(eq(users.id, id))
      if (!target) throw notFound('USER_NOT_FOUND', 'User not found')
      if (target.isAdmin) {
        const [c] = await tx
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.isAdmin, true), ne(users.id, id)))
        if ((c?.n ?? 0) === 0) throw badRequest('You cannot delete the last admin')
      }
      // A workspace whose only owner disappears can no longer be managed (members, public
      // links). Refuse until an admin/owner transfers ownership (C-H1); the list lets the UI
      // show what to fix. Membership changes take the same per-workspace lock (ws-members).
      // Workspaces where the user is the ONLY member (the auto-created personal workspace) are
      // deleted with the account instead: nobody else could ever reach them (docs/adr/0813-*).
      const memberOf = (await tx.execute(sql`
        SELECT workspace_id AS id FROM workspace_members WHERE user_id = ${id} ORDER BY workspace_id
      `)) as unknown as { id: string }[]
      for (const w of memberOf) await lockWorkspaceMembers(tx, w.id)
      const plan = await deletionPlan(tx, id)
      if (plan.soleOwnedShared.length > 0) {
        throw new AppError(
          409,
          'SOLE_OWNER',
          'This user is the only owner of some shared workspaces. An owner of each must use "Transfer ownership" in the workspace menu, or delete the workspace, first.',
          undefined,
          { workspaces: plan.soleOwnedShared },
        )
      }
      if (plan.personal.length > 0) {
        // Same permanent deletion as the 30-day workspace purge (workspaceDeletion.ts): ws-members
        // locks (above) → page-tree locks in id order → cascade; blobs are unlinked after commit.
        blobIds.push(...(await purgeWorkspacesTx(tx, plan.personal.map((w) => w.id))))
        deletedWorkspaces = plan.personal.length
      }
      // pages.created_by is ON DELETE SET NULL. The user's private pages go to the trash and
      // become ownerless: visible to nobody, admins included (pageDto.visibleTo), and removed by
      // the 30-day trash purge (docs/adr/0803-*). Nobody else gets to read them.
      await tx
        .update(pages)
        .set({ deletedAt: sql`coalesce(${pages.deletedAt}, now())` })
        .where(and(eq(pages.createdBy, id), eq(pages.scope, 'private')))
      await tx.delete(users).where(eq(users.id, id))
      if (target.signupKey) {
        await tx
          .update(signupKeys)
          .set({ usedCount: sql`greatest(${signupKeys.usedCount} - 1, 0)` })
          .where(eq(signupKeys.key, target.signupKey))
      }
    })
    // Sessions are gone with the user row; also drop the live collab sockets (docs/adr/0754-*).
    closeUserConnections(id, { includeInbox: true })
    // Best-effort, after commit (same as the trash purge): a rolled-back delete keeps its blobs.
    await unlinkUploadBlobs(blobIds)
    return { ok: true, deletedWorkspaces }
  })

  /**
   * What a forced deletion would do — for the admin confirmation dialog (docs/adr/0813-*).
   * `personalWorkspaces`: workspaces where the user is the only member; they are deleted with
   * the account. `soleOwnedShared`: workspaces with other members where the user is the only
   * owner; while non-empty, DELETE answers 409 SOLE_OWNER with the same list.
   */
  app.get('/admin/users/:id/delete-preview', admin, async (req) => {
    const { id } = req.params as { id: string }
    await loadUser(id)
    const plan = await deletionPlan(db, id)
    return {
      personalWorkspaces: plan.personal.length,
      personal: plan.personal,
      soleOwnedShared: plan.soleOwnedShared,
    }
  })

  /** Issue a temporary password, returned once in the response. All of the user's sessions are deleted. */
  app.post('/admin/users/:id/temp-password', admin, async (req) => {
    const { id } = req.params as { id: string }
    const me = getUser(req)
    const u = await passwordTarget(id, me.id)
    const password = newTempPassword()
    await setPassword(u.id, password, { resolvedBy: me.id })
    return { password }
  })

  /**
   * Turn off a member's two-step verification (lost phone and recovery codes, docs/adr/1061-*).
   * Their sessions are signed out too; they sign in with the password alone and can set 2FA up again.
   */
  app.delete('/admin/users/:id/2fa', admin, async (req) => {
    const { id } = req.params as { id: string }
    const me = getUser(req)
    const u = await loadUser(id)
    if (u.id === me.id) throw badRequest('Turn off your own two-step verification in Settings')
    const wasOn = await disableTwoFactor(u.id)
    if (wasOn) await revokeSessions(u.id)
    return { ok: true, wasOn }
  })

  /** Issue a one-time reset code (24 hours). Only its hash is stored. All of the user's sessions are deleted. */
  app.post('/admin/users/:id/reset-code', admin, async (req) => {
    const { id } = req.params as { id: string }
    const me = getUser(req)
    const u = await passwordTarget(id, me.id)
    const { code, expiresAt } = await issueResetCode(u.id, me.id)
    await revokeSessions(u.id)
    await resolvePendingRequests(u.id, me.id)
    return { code, expiresAt }
  })

  /**
   * Mail a just-issued reset code / temporary password. The server does not store the plain
   * value, so it takes the value shown on screen and sends it only after checking that it is
   * actually valid for that user.
   */
  app.post('/admin/users/:id/send-credential', adminMail, async (req) => {
    requireMail()
    const { id } = req.params as { id: string }
    const me = getUser(req)
    const body = sendCredentialMailSchema.parse(req.body)
    const u = await passwordTarget(id, me.id)
    const origin = appOrigin(req)
    // Mail in the recipient's language (their saved locale, else DEFAULT_LOCALE), not the admin's.
    const locale = resolveLocale(u.locale)

    if (body.kind === 'reset-code') {
      if (!(await isValidResetCode(u.id, body.secret))) {
        throw badRequest('This reset code is not valid. Issue a new one.')
      }
      const [row] = await db
        .select({ expiresAt: passwordResetCodes.expiresAt })
        .from(passwordResetCodes)
        .where(eq(passwordResetCodes.userId, u.id))
        .orderBy(desc(passwordResetCodes.createdAt))
        .limit(1)
      const expiresAt = row?.expiresAt ?? new Date()
      await sendMail(
        body.to,
        resetCodeMail({ name: u.name, email: u.email, code: body.secret.trim().toUpperCase(), expiresAt, origin, locale }),
        log,
      )
    } else {
      const [ph] = await db
        .select({ h: users.passwordHash })
        .from(users)
        .where(eq(users.id, u.id))
        .limit(1)
      if (!ph || !(await verifyPassword(ph.h, body.secret))) {
        throw badRequest('This temporary password is no longer valid. Issue a new one.')
      }
      await sendMail(body.to, tempPasswordMail({ name: u.name, email: u.email, password: body.secret, origin, locale }), log)
    }
    return { ok: true }
  })

  /** Send the email verification mail. It always goes to the account email (that is what is being verified). */
  app.post('/admin/users/:id/send-verification', adminMail, async (req) => {
    requireMail()
    const { id } = req.params as { id: string }
    const u = await loadUser(id)
    if (u.origin !== 'local') {
      throw new AppError(400, 'DELEGATED_ACCOUNT', `Delegated sign-in (${env.delegatedAuthName}) accounts do not use email verification`)
    }
    if (u.emailVerifiedAt) throw badRequest('This email is already verified')
    const token = await issueVerifyToken(u.id, u.email)
    await sendMail(u.email, verifyMail({ name: u.name, token, origin: appOrigin(req), locale: resolveLocale(u.locale) }), log)
    return { ok: true }
  })

  /** Admin manually marks the email as verified (verified=false unverifies it) */
  app.post('/admin/users/:id/verify', admin, async (req) => {
    const { id } = req.params as { id: string }
    const verified = (req.body as { verified?: unknown } | undefined)?.verified !== false
    const u = await loadUser(id)
    if (u.origin !== 'local') {
      throw new AppError(400, 'DELEGATED_ACCOUNT', `Delegated sign-in (${env.delegatedAuthName}) accounts do not use email verification`)
    }
    const [row] = await db
      .update(users)
      .set({ emailVerifiedAt: verified ? new Date() : null })
      .where(eq(users.id, id))
      .returning({ emailVerifiedAt: users.emailVerifiedAt })
    return { user: { id, emailVerifiedAt: row?.emailVerifiedAt ?? null } }
  })

  // -------------------------------------------------------------------------
  // Password reset request queue
  // -------------------------------------------------------------------------

  /** Request list (newest first, last 200). Handle them with the per-user temp-password / reset-code endpoints. */
  app.get('/admin/reset-requests', admin, async () => {
    const resolver = alias(users, 'resolver')
    const rows = await db
      .select({
        id: passwordResetRequests.id,
        userId: passwordResetRequests.userId,
        email: users.email,
        name: users.name,
        origin: users.origin,
        note: passwordResetRequests.note,
        ip: passwordResetRequests.ip,
        status: passwordResetRequests.status,
        createdAt: passwordResetRequests.createdAt,
        resolvedAt: passwordResetRequests.resolvedAt,
        resolvedByName: resolver.name,
      })
      .from(passwordResetRequests)
      .innerJoin(users, eq(users.id, passwordResetRequests.userId))
      .leftJoin(resolver, eq(resolver.id, passwordResetRequests.resolvedBy))
      .orderBy(desc(passwordResetRequests.createdAt))
      .limit(200)
    return { requests: rows }
  })

  /** Dismiss a request */
  app.post('/admin/reset-requests/:id/dismiss', admin, async (req) => {
    const { id } = req.params as { id: string }
    const me = getUser(req)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('REQUEST_NOT_FOUND', 'Request not found')
    const rows = await db
      .update(passwordResetRequests)
      .set({ status: 'dismissed', resolvedBy: me.id, resolvedAt: new Date() })
      .where(and(eq(passwordResetRequests.id, id), eq(passwordResetRequests.status, 'pending')))
      .returning({ id: passwordResetRequests.id })
    if (rows.length === 0) throw notFound('REQUEST_NOT_FOUND', 'Request not found or already handled')
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Brute-force protection: banned IPs
  // -------------------------------------------------------------------------

  /** Ban history (newest 200) + your IP, the allowlist and the policy */
  app.get('/admin/ip-bans', admin, async (req) => {
    const rows = await listBans(200)
    return {
      bans: rows,
      yourIp: ipKey(req.ip),
      yourIpAllowlisted: isAllowlisted(req.ip),
      allowlist: env.allowlistIps,
      policy: guardPolicy(),
    }
  })

  /** Manual ban. Allowlisted IPs and your current IP are refused. */
  app.post('/admin/ip-bans', admin, async (req) => {
    const body = manualBanSchema.parse(req.body)
    const raw = body.ip.trim()
    const bare = raw.replace(/\/64$/, '').replace(/::$/, '::1')
    if (!isIP(raw) && !(raw.endsWith('/64') && isIP(bare))) {
      throw badRequest('Not a valid IP address')
    }
    const key = raw.endsWith('/64') ? ipKey(bare) : ipKey(raw)
    if (isAllowlisted(raw.endsWith('/64') ? bare : raw)) {
      throw badRequest("IPs on the allowlist (ALLOWLIST_IPS) can't be banned")
    }
    if (key === ipKey(req.ip)) {
      throw badRequest("You can't ban the IP you are connected from")
    }
    const until = await banIp(
      key,
      `manual${body.reason ? `: ${body.reason}` : ''}`,
      0,
      body.minutes * 60_000,
      log,
    )
    return { ok: true, ip: key, bannedUntil: until }
  })

  /** Unban (by ip_bans.id; lifts every active ban on that IP) */
  app.delete('/admin/ip-bans/:id', admin, async (req) => {
    const { id } = req.params as { id: string }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('BAN_NOT_FOUND', 'Ban not found')
    const [row] = await db.select({ ip: ipBans.ip }).from(ipBans).where(eq(ipBans.id, id)).limit(1)
    if (!row) throw notFound('BAN_NOT_FOUND', 'Ban not found')
    await unbanIp(row.ip)
    return { ok: true }
  })
}

type Exec = Pick<typeof db, 'execute'>
type WsRef = { id: string; name: string }

/**
 * Workspaces a forced deletion of `userId` affects (docs/adr/0813-*):
 *   personal        — the user is the only member, or the workspace is already soft-deleted and
 *                     the user is its only owner (nobody else could restore it, ADR 0910): deleted
 *                     together with the account.
 *   soleOwnedShared — other members exist but no other owner: the deletion is refused (409).
 */
async function deletionPlan(tx: Exec, userId: string): Promise<{ personal: WsRef[]; soleOwnedShared: WsRef[] }> {
  const rows = (await tx.execute(sql`
    SELECT w.id, w.name, m.role, (w.deleted_at IS NOT NULL) AS deleted,
           (SELECT count(*)::int FROM workspace_members a WHERE a.workspace_id = w.id) AS members
      FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ${userId}
     WHERE NOT EXISTS (SELECT 1 FROM workspace_members o
                        WHERE o.workspace_id = w.id AND o.role = 'owner' AND o.user_id <> ${userId})
     ORDER BY w.name, w.id
  `)) as unknown as { id: string; name: string; role: string; deleted: boolean; members: number }[]
  const purge = (r: (typeof rows)[number]) => Number(r.members) <= 1 || (r.deleted && r.role === 'owner')
  return {
    personal: rows.filter(purge).map((r) => ({ id: r.id, name: r.name })),
    soleOwnedShared: rows
      .filter((r) => !purge(r) && r.role === 'owner')
      .map((r) => ({ id: r.id, name: r.name })),
  }
}
