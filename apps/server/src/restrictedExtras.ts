import type { AuthModeDTO, UserDTO } from '@inkling/shared'
import type { AuthUser } from './auth'

/**
 * Plug points of restricted mode (0.22, docs/adr/2503-*) that the pieces register from their own
 * `register.ts` instead of editing shared files: fields added to GET /api/auth/mode and
 * GET /api/auth/me, and jobs run after the hourly housekeeping.
 *
 * Every registration takes a unique name (a second one with the same name throws) and returns the
 * function that removes it (tests). With nothing registered the routes and housekeeping behave as
 * before.
 */

export type AuthModeExtra = () => Partial<AuthModeDTO> | Promise<Partial<AuthModeDTO>>
export type MeExtra = (user: AuthUser) => Partial<UserDTO> | Promise<Partial<UserDTO>>
export type HousekeepingTask = () => Promise<void>

function registry<T>(kind: string) {
  const items = new Map<string, T>()
  return {
    items,
    add(name: string, item: T): () => void {
      if (items.has(name)) throw new Error(`${kind} "${name}" is already registered`)
      items.set(name, item)
      return () => {
        if (items.get(name) === item) items.delete(name)
      }
    },
  }
}

const authModeExtras = registry<AuthModeExtra>('auth mode extra')
const meExtras = registry<MeExtra>('me extra')
const housekeepingTasks = registry<HousekeepingTask>('housekeeping task')

/** Fields merged into GET /api/auth/mode (in registration order; later ones win on the same key). */
export function registerAuthModeExtra(name: string, fn: AuthModeExtra): () => void {
  return authModeExtras.add(name, fn)
}

/** Fields merged into GET /api/auth/me's `user` (in registration order). */
export function registerMeExtra(name: string, fn: MeExtra): () => void {
  return meExtras.add(name, fn)
}

/**
 * A job run after the hourly housekeeping (housekeeping.ts runHousekeeping), in registration order.
 * One that throws is logged in one line and the next one still runs.
 */
export function registerHousekeepingTask(name: string, fn: HousekeepingTask): () => void {
  return housekeepingTasks.add(name, fn)
}

/** The merged extra fields of /auth/mode ({} when nothing is registered). */
export async function authModeExtraFields(): Promise<Partial<AuthModeDTO>> {
  if (authModeExtras.items.size === 0) return {}
  const out: Partial<AuthModeDTO> = {}
  for (const fn of [...authModeExtras.items.values()]) Object.assign(out, await fn())
  return out
}

/** The merged extra fields of /auth/me ({} when nothing is registered). */
export async function meExtraFields(user: AuthUser): Promise<Partial<UserDTO>> {
  if (meExtras.items.size === 0) return {}
  const out: Partial<UserDTO> = {}
  for (const fn of [...meExtras.items.values()]) Object.assign(out, await fn(user))
  return out
}

/** Run every registered housekeeping job; called by runHousekeeping and directly by tests. */
export async function runRegisteredHousekeepingTasks(log: (msg: string) => void = (m) => console.warn(m)): Promise<void> {
  for (const [name, fn] of [...housekeepingTasks.items.entries()]) {
    try {
      await fn()
    } catch (err) {
      log(`[inkling] housekeeping task ${name} failed: ${String(err)}`)
    }
  }
}
