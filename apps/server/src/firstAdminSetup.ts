import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from './db/index'
import { users } from './db/schema'

/**
 * First administrator setup (docs/adr/2160-*).
 *
 * A server whose database has no account at all makes a one-time setup code at boot, keeps only its
 * SHA-256 in memory and prints a `/setup?code=…` link to its own log. Whoever holds that code may
 * create the first account, which is made admin in the same transaction. Anyone who can read the
 * server log already runs the server (`docker compose logs`), so the code proves the same thing the
 * signup key from `deploy/signup-key.sh` (a psql INSERT) proves, without the extra step.
 *
 * Deliberately not "requests from localhost need no key": behind a reverse proxy every request
 * comes from a local address, so the first stranger to open a fresh public instance would become its
 * admin.
 *
 * The path closes for good once any account exists, however it was made (signup key, open signup,
 * OpenID Connect, delegated login): the account insert runs under the admin advisory lock with a
 * `no user exists` check in the same transaction, so of two concurrent setups at most one commits,
 * and a setup racing any other signup can only win while that other account has not committed.
 * Nothing is stored in the database; a restart with still no accounts prints a new code and the old
 * one stops working.
 */

/** Alphabet without confusable characters (0/O, 1/I/L), as signup keys and invite codes. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** 24 characters of a 31-letter alphabet: about 119 bits. */
const CODE_LENGTH = 24

let codeHash: Buffer | null = null
let closed = false

const hash = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Upper-case, without spaces and dashes: the code may be typed or pasted in groups. */
export function normalizeSetupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** A new random code in groups of four (rejection sampling, no modulo bias). */
export function newSetupCode(): string {
  let out = ''
  while (out.length < CODE_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b >= 248) continue // 248 = 8 * 31
      out += ALPHABET[b % ALPHABET.length]
      if (out.length === CODE_LENGTH) break
    }
  }
  return out.match(/.{4}/g)!.join('-')
}

async function anyAccount(): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).limit(1)
  return rows.length > 0
}

/**
 * At boot: with no account in the database, make the code and return it (for the log line);
 * otherwise close the setup path for this process and return null.
 */
export async function prepareFirstAdminSetup(): Promise<string | null> {
  if (await anyAccount()) {
    codeHash = null
    closed = true
    return null
  }
  const code = newSetupCode()
  codeHash = hash(normalizeSetupCode(code))
  closed = false
  return code
}

/**
 * Whether the setup screen can still be used (for /auth/mode). Checks the database while it is
 * open, so an account made some other way closes it; once closed it stays closed.
 */
export async function setupPending(): Promise<boolean> {
  if (closed || !codeHash) return false
  if (await anyAccount()) {
    closeFirstAdminSetup()
    return false
  }
  return true
}

/** 'ok', 'wrong' (a code is open and this is not it) or 'closed' (no code is open). */
export function checkSetupCode(raw: string): 'ok' | 'wrong' | 'closed' {
  if (closed || !codeHash) return 'closed'
  const given = hash(normalizeSetupCode(raw))
  return timingSafeEqual(given, codeHash) ? 'ok' : 'wrong'
}

/** After the first admin committed (or any account was seen): the code is gone for this process. */
export function closeFirstAdminSetup(): void {
  codeHash = null
  closed = true
}

/** The boot log lines with the link; origin null = PUBLIC_URL/APP_URL unset. */
export function setupLogLines(code: string, origin: string | null, port: number): string[] {
  const base = origin ?? `http://localhost:${port}`
  const lines = [
    '[inkling] ──────────────────────────────────────────────────────────────',
    '[inkling] No accounts yet. Create the first administrator account here:',
    `[inkling]   ${base}/setup?code=${code}`,
    `[inkling]   (setup code ${code} — works once, only while there are no accounts; a restart makes a new one)`,
  ]
  if (!origin) {
    lines.push('[inkling]   PUBLIC_URL is not set: if you open the app on another address or port, keep the /setup?code=… part.')
  }
  lines.push('[inkling] ──────────────────────────────────────────────────────────────')
  return lines
}
