import { randomBytes } from 'node:crypto'
import { and, count, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from './db/index'
import { totpLoginChallenges, userRecoveryCodes, userTotp } from './db/schema'
import { sha256 } from './oauth'
import { openSecret, sealSecret } from './secretBox'
import {
  base32Encode,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp'

/**
 * Two-step verification state and checks (docs/adr/1061-*). Routes live in routes/twoFactor.ts;
 * the sign-in step is in routes/auth.ts.
 */

const PURPOSE = 'totp-secret'
export const CHALLENGE_TTL_MS = 5 * 60_000
export const CHALLENGE_MAX_ATTEMPTS = 5

/** Separate guard backoff key for wrong 2FA codes: a correct password never clears it. */
export const totpAccountKey = (acct: string) => `totp:${acct.toLowerCase()}`

export interface TwoFactorState {
  enabled: boolean
  /** Setup started (secret issued) but not confirmed with a code yet. */
  pending: boolean
  recoveryCodesLeft: number
}

export async function twoFactorState(userId: string): Promise<TwoFactorState> {
  const [row] = await db
    .select({ enabledAt: userTotp.enabledAt })
    .from(userTotp)
    .where(eq(userTotp.userId, userId))
    .limit(1)
  const [c] = await db
    .select({ n: count() })
    .from(userRecoveryCodes)
    .where(eq(userRecoveryCodes.userId, userId))
  return { enabled: !!row?.enabledAt, pending: !!row && !row.enabledAt, recoveryCodesLeft: c?.n ?? 0 }
}

export async function twoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ u: userTotp.userId })
    .from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.enabledAt)))
    .limit(1)
  return !!row
}

/**
 * Start (or restart) setup: a fresh secret replaces any unconfirmed one. Returns null when 2FA is
 * already on (turning it off first is required, so a stolen session cannot swap the secret).
 */
export async function beginSetup(
  userId: string,
  account: string,
): Promise<{ secret: string; uri: string } | null> {
  const secret = newTotpSecret()
  const secretEnc = sealSecret(PURPOSE, secret, userId)
  const rows = await db
    .insert(userTotp)
    .values({ userId, secretEnc })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { secretEnc, lastUsedStep: null, createdAt: new Date() },
      setWhere: isNull(userTotp.enabledAt),
    })
    .returning({ userId: userTotp.userId })
  if (rows.length === 0) return null
  const b32 = base32Encode(secret)
  return { secret: b32, uri: otpauthUri(b32, account) }
}

function decryptSecret(userId: string, secretEnc: string): Buffer | null {
  try {
    return openSecret(PURPOSE, secretEnc, userId)
  } catch (err) {
    // APP_SECRET_KEY changed or unset: the account can still use a recovery code.
    console.error(`[inkling] cannot decrypt the TOTP secret of user ${userId}: ${(err as Error).message}`)
    return null
  }
}

/** Replace the recovery codes; returns the raw codes (shown once). */
async function replaceRecoveryCodes(
  tx: Pick<typeof db, 'delete' | 'insert'>,
  userId: string,
): Promise<string[]> {
  const codes = newRecoveryCodes()
  await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  await tx
    .insert(userRecoveryCodes)
    .values(codes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })))
  return codes
}

/**
 * Confirm setup with a code from the app. On success 2FA is on, the code's step is recorded (it
 * cannot be used again to sign in) and ten recovery codes are returned once.
 */
export async function confirmSetup(userId: string, code: string): Promise<string[] | null> {
  const [row] = await db
    .select({ secretEnc: userTotp.secretEnc })
    .from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNull(userTotp.enabledAt)))
    .limit(1)
  if (!row) return null
  const secret = decryptSecret(userId, row.secretEnc)
  if (!secret) return null
  const step = verifyTotp(secret, code)
  if (step === null) return null
  return db.transaction(async (tx) => {
    const done = await tx
      .update(userTotp)
      .set({ enabledAt: new Date(), lastUsedStep: step })
      .where(and(eq(userTotp.userId, userId), isNull(userTotp.enabledAt), eq(userTotp.secretEnc, row.secretEnc)))
      .returning({ u: userTotp.userId })
    if (done.length === 0) return null
    return replaceRecoveryCodes(tx, userId)
  })
}

export type SecondFactorResult = 'totp' | 'recovery' | 'reused' | 'invalid'

/**
 * Check a sign-in code: a 6-digit TOTP code (accepted once: the step must be newer than the last
 * one used, updated atomically) or a recovery code (consumed with DELETE … RETURNING).
 */
export async function verifySecondFactor(userId: string, input: string): Promise<SecondFactorResult> {
  const code = input.replace(/\s/g, '')
  if (/^\d{6}$/.test(code)) {
    const [row] = await db
      .select({ secretEnc: userTotp.secretEnc })
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.enabledAt)))
      .limit(1)
    if (!row) return 'invalid'
    const secret = decryptSecret(userId, row.secretEnc)
    if (!secret) return 'invalid'
    const step = verifyTotp(secret, code)
    if (step === null) return 'invalid'
    const accepted = await db
      .update(userTotp)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(userTotp.userId, userId),
          isNotNull(userTotp.enabledAt),
          or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step)),
        ),
      )
      .returning({ u: userTotp.userId })
    return accepted.length > 0 ? 'totp' : 'reused'
  }
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length !== 10) return 'invalid'
  const used = await db
    .delete(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), eq(userRecoveryCodes.codeHash, sha256(normalized))))
    .returning({ h: userRecoveryCodes.codeHash })
  return used.length > 0 ? 'recovery' : 'invalid'
}

/** Turn 2FA off: secret, recovery codes and pending sign-in challenges go. */
export async function disableTwoFactor(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx.delete(userTotp).where(eq(userTotp.userId, userId)).returning({ u: userTotp.userId })
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
    await tx.delete(totpLoginChallenges).where(eq(totpLoginChallenges.userId, userId))
    return gone.length > 0
  })
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  return db.transaction((tx) => replaceRecoveryCodes(tx, userId))
}

// ---------------------------------------------------------------------------
// Sign-in challenge (password correct → waiting for the code)
// ---------------------------------------------------------------------------

export async function createLoginChallenge(userId: string, passwordHash: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  // Expired challenges of anyone are cleared here; there is no other writer that needs them.
  await db.delete(totpLoginChallenges).where(lt(totpLoginChallenges.expiresAt, new Date()))
  await db.insert(totpLoginChallenges).values({
    tokenHash: sha256(token),
    userId,
    passwordHash,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  })
  return token
}

/**
 * Count one attempt against a live challenge. Returns its user and password hash, plus whether
 * this was the last allowed attempt; null when the challenge is unknown, expired or used up.
 */
export async function takeChallengeAttempt(
  token: string,
): Promise<{ userId: string; passwordHash: string; last: boolean } | null> {
  const rows = await db
    .update(totpLoginChallenges)
    .set({ attempts: sql`${totpLoginChallenges.attempts} + 1` })
    .where(
      and(
        eq(totpLoginChallenges.tokenHash, sha256(token)),
        lt(totpLoginChallenges.attempts, CHALLENGE_MAX_ATTEMPTS),
        sql`${totpLoginChallenges.expiresAt} > now()`,
      ),
    )
    .returning({
      userId: totpLoginChallenges.userId,
      passwordHash: totpLoginChallenges.passwordHash,
      attempts: totpLoginChallenges.attempts,
    })
  const r = rows[0]
  if (!r) return null
  return { userId: r.userId, passwordHash: r.passwordHash, last: r.attempts >= CHALLENGE_MAX_ATTEMPTS }
}

export async function dropChallenge(token: string): Promise<void> {
  await db.delete(totpLoginChallenges).where(eq(totpLoginChallenges.tokenHash, sha256(token)))
}
