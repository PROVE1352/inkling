import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser, verifyPassword } from '../auth'
import { db } from '../db/index'
import { users } from '../db/schema'
import { env } from '../env'
import { AppError, forbidden } from '../errors'
import { assertAccount, assertNotBanned, recordFailure, recordSuccess } from '../guard'
import { secretBoxAvailable } from '../secretBox'
import {
  beginSetup,
  confirmSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  totpAccountKey,
  twoFactorState,
  verifySecondFactor,
} from '../twoFactor'

/**
 * Two-step verification settings (docs/adr/1061-*). Browser sessions of local accounts only:
 * delegated accounts sign in at the external auth server, which owns their second factor.
 *
 *   GET  /auth/2fa                    state
 *   POST /auth/2fa/setup              { password }        → { secret, uri }   (2FA not on yet)
 *   POST /auth/2fa/enable             { code }            → { recoveryCodes } (turns it on)
 *   POST /auth/2fa/disable            { password, code }  (code = app code or recovery code)
 *   POST /auth/2fa/recovery-codes     { password, code }  → { recoveryCodes } (replaces the rest)
 */

const strictRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }

const unavailable = () =>
  new AppError(
    501,
    'TWO_FACTOR_UNAVAILABLE',
    'Two-step verification is not available on this server (the administrator has to set APP_SECRET_KEY)',
  )
const invalidCode = () => new AppError(400, 'INVALID_TOTP_CODE', 'Incorrect code')

export async function registerTwoFactorRoutes(app: FastifyInstance): Promise<void> {
  /** The signed-in local account, from a browser session. */
  const localAccount = async (req: FastifyRequest) => {
    if (req.authVia !== 'cookie') throw forbidden('Can only be changed from a browser sign-in')
    const me = getUser(req)
    const [u] = await db
      .select({ id: users.id, email: users.email, origin: users.origin, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1)
    if (!u) throw forbidden()
    if (u.origin !== 'local') {
      throw new AppError(
        400,
        'DELEGATED_ACCOUNT',
        `${env.delegatedAuthName} accounts use the second factor of their own sign-in service`,
      )
    }
    return u
  }

  /** Re-check the password (wrong ones count like sign-in failures). */
  const checkPassword = async (req: FastifyRequest, u: { email: string; passwordHash: string }, password: string) => {
    assertNotBanned(req)
    assertAccount(u.email)
    if (!(await verifyPassword(u.passwordHash, password))) {
      await recordFailure(req, '2fa-password', u.email)
      throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect')
    }
    recordSuccess(req, u.email)
  }

  /** Check an app or recovery code of the signed-in account (wrong ones count too). */
  const checkCode = async (req: FastifyRequest, u: { id: string; email: string }, code: string) => {
    assertAccount(totpAccountKey(u.email))
    const r = await verifySecondFactor(u.id, code)
    if (r === 'invalid' || r === 'reused') {
      await recordFailure(req, '2fa-code', totpAccountKey(u.email))
      throw r === 'reused'
        ? new AppError(400, 'TOTP_CODE_REUSED', 'This code was already used. Wait for the next one.')
        : invalidCode()
    }
    recordSuccess(req, totpAccountKey(u.email))
  }

  app.get('/auth/2fa', { preHandler: requireUser }, async (req) => {
    const me = getUser(req)
    return { ...(await twoFactorState(me.id)), available: secretBoxAvailable() }
  })

  app.post('/auth/2fa/setup', { preHandler: requireUser, ...strictRateLimit }, async (req) => {
    const body = z.object({ password: z.string().min(1).max(200) }).parse(req.body)
    if (!secretBoxAvailable()) throw unavailable()
    const u = await localAccount(req)
    await checkPassword(req, u, body.password)
    const setup = await beginSetup(u.id, u.email)
    if (!setup) throw new AppError(409, 'TWO_FACTOR_ALREADY_ON', 'Two-step verification is already on')
    return setup
  })

  app.post('/auth/2fa/enable', { preHandler: requireUser, ...strictRateLimit }, async (req) => {
    const body = z.object({ code: z.string().trim().min(1).max(20) }).parse(req.body)
    if (!secretBoxAvailable()) throw unavailable()
    const u = await localAccount(req)
    assertAccount(totpAccountKey(u.email))
    const codes = await confirmSetup(u.id, body.code)
    if (!codes) {
      await recordFailure(req, '2fa-setup', totpAccountKey(u.email))
      throw invalidCode()
    }
    return { recoveryCodes: codes }
  })

  app.post('/auth/2fa/disable', { preHandler: requireUser, ...strictRateLimit }, async (req) => {
    const body = z
      .object({ password: z.string().min(1).max(200), code: z.string().trim().min(1).max(40) })
      .parse(req.body)
    const u = await localAccount(req)
    await checkPassword(req, u, body.password)
    if (!(await twoFactorState(u.id)).enabled) return { ok: true }
    await checkCode(req, u, body.code)
    await disableTwoFactor(u.id)
    return { ok: true }
  })

  app.post('/auth/2fa/recovery-codes', { preHandler: requireUser, ...strictRateLimit }, async (req) => {
    const body = z
      .object({ password: z.string().min(1).max(200), code: z.string().trim().min(1).max(40) })
      .parse(req.body)
    const u = await localAccount(req)
    await checkPassword(req, u, body.password)
    if (!(await twoFactorState(u.id)).enabled) {
      throw new AppError(409, 'TWO_FACTOR_OFF', 'Two-step verification is off')
    }
    await checkCode(req, u, body.code)
    return { recoveryCodes: await regenerateRecoveryCodes(u.id) }
  })
}
