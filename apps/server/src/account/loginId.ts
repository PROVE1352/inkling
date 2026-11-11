import { registerSchema, type RegisterInput } from '@inkling/shared'
import { AppError } from '../errors'
import { limits } from '../limits'

/**
 * Sign-in IDs (LOGIN_ID_MODE=username, docs/adr/2512-*): 3–30 characters of [a-z0-9._-], starting
 * with a letter or digit, lower-cased, never a reserved name. Stored in users.email (no new column);
 * an ID can never equal an email because it has no '@'.
 */
export const LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/

/** Names that would read as the server, its staff or a special address. */
export const RESERVED_LOGIN_IDS: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'inkling', 'owner', 'operator', 'moderator',
  'staff', 'help', 'null', 'undefined',
  // names the server or the app uses for itself
  'api', 'mcp', 'oauth', 'setup', 'login', 'logout', 'register', 'signup', 'auth', 'me', 'settings',
  'security', 'webmaster', 'postmaster', 'hostmaster', 'abuse', 'noreply', 'no-reply', 'mailer-daemon',
  'everyone', 'here', 'channel', 'all', 'guest', 'guests', 'anonymous', 'unknown', 'someone', 'deleted',
  'agent', 'bot', 'demo', 'test', 'official', 'service', 'info', 'contact', 'billing', 'legal',
  'privacy', 'terms', 'team',
])

/** The normalized ID, or a 400 LOGIN_ID_INVALID. */
export function normalizeLoginId(raw: string): string {
  const id = raw.trim().toLowerCase()
  if (!LOGIN_ID_RE.test(id) || RESERVED_LOGIN_IDS.has(id)) {
    throw new AppError(
      400,
      'LOGIN_ID_INVALID',
      'IDs are 3 to 30 characters: lower-case letters, digits, dot, underscore and hyphen, starting with a letter or digit. Some names are reserved.',
    )
  }
  return id
}

const usernameRegisterSchema = registerSchema.omit({ email: true })

/**
 * The sign-up body for the server's mode. Email mode: the 0.21.1 schema (a stray `loginId` is
 * ignored, as the schema always did). ID mode: `loginId` instead of `email`; sending `email` (alone
 * or with an ID) is a 400. The returned `email` is the normalized ID, the value users.email stores.
 */
export function parseRegisterBody(raw: unknown): RegisterInput {
  if (limits.loginIdMode !== 'username') return registerSchema.parse(raw)
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (obj.email !== undefined) throw new AppError(400, 'VALIDATION', 'This server signs up with an ID (loginId), not an email')
  if (typeof obj.loginId !== 'string') throw new AppError(400, 'LOGIN_ID_INVALID', 'An ID (loginId) is required')
  const body = usernameRegisterSchema.parse(raw)
  const id = normalizeLoginId(obj.loginId)
  return { ...body, loginId: id, email: id }
}

let dummyHash: Promise<string> | null = null

/** One argon2 check against a throwaway hash, so a sign-in with an unknown ID takes as long as a wrong password. */
export async function spendPasswordCheck(password: string): Promise<void> {
  const { hashPassword, verifyPassword } = await import('../auth')
  dummyHash ??= hashPassword(`unused-${Math.random()}`)
  await verifyPassword(await dummyHash, password)
}
