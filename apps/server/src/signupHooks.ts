import type { FastifyRequest } from 'fastify'
import type { RegisterInput } from '@inkling/shared'
import type { Locale } from './i18n'
import type { Tx } from './pageTree'

/**
 * Sign-up hooks (0.22, docs/adr/2501-*): the places where restricted mode plugs checks and records
 * into `POST /api/auth/register` without each feature editing the route.
 *
 *   before(ctx)          before anything is consumed or written (signup key, password hash, rows).
 *                        Throw an AppError to refuse the sign-up.
 *   on(tx, user, ctx)    inside the transaction that creates the account, its first workspace and
 *                        its membership, after the first-admin promotion was decided (user.isAdmin
 *                        is final). Throwing rolls the whole sign-up back (no account, the signup key
 *                        is given back).
 *
 * Hooks run in registration order. With no hook registered the route behaves as 0.21.1.
 *
 * Only the sign-up route runs these. Accounts made any other way (admin, delegated sign-in, OIDC,
 * page guest invites, CLI) do not: restricted mode handles them after sign-in (docs/adr/2502-*).
 */

export interface SignupContext {
  /** The request body as the client sent it, before the schema (fields the schema does not know included). */
  rawBody: unknown
  /** The body after registerSchema (trimmed, known fields only). */
  body: RegisterInput
  /** The client IP as Fastify resolved it (X-Forwarded-For only from TRUST_PROXY addresses). */
  ip: string
  /** The language of the sign-up (Accept-Language, else DEFAULT_LOCALE): the account has none saved yet. */
  locale: Locale
  /** The account is the first admin made with the one-time setup code (docs/adr/2160-*). */
  setupCode: boolean
  req: FastifyRequest
}

/** The account as the transaction created it. */
export interface SignupUser {
  id: string
  email: string
  name: string
  /** Final: true for the setup-code account and for the first account of a server without admins. */
  isAdmin: boolean
  /** The personal workspace created with the account. */
  workspaceId: string
}

export interface SignupHook {
  before?: (ctx: SignupContext) => void | Promise<void>
  on?: (tx: Tx, user: SignupUser, ctx: SignupContext) => void | Promise<void>
}

const hooks = new Map<string, SignupHook>()

/**
 * Register a hook under a unique name (a second registration of the same name throws). Returns the
 * function that removes it (tests).
 */
export function registerSignupHook(name: string, hook: SignupHook): () => void {
  if (hooks.has(name)) throw new Error(`signup hook "${name}" is already registered`)
  hooks.set(name, hook)
  return () => {
    if (hooks.get(name) === hook) hooks.delete(name)
  }
}

export function hasSignupHooks(): boolean {
  return hooks.size > 0
}

export async function runBeforeSignup(ctx: SignupContext): Promise<void> {
  if (hooks.size === 0) return
  for (const h of [...hooks.values()]) if (h.before) await h.before(ctx)
}

export async function runOnSignup(tx: Tx, user: SignupUser, ctx: SignupContext): Promise<void> {
  if (hooks.size === 0) return
  for (const h of [...hooks.values()]) if (h.on) await h.on(tx, user, ctx)
}
