import { randomBytes } from 'node:crypto'
import type { AuthUser } from '../auth'

/**
 * Who an automation run acts as (docs/adr/2241-*). The runner calls the REST routes through
 * `app.inject` like the MCP server does, so a run gets exactly the permission checks a person's
 * request gets (membership, visibility, edit locks, placement, row cap, person cells, agents). The
 * request carries `x-inkling-automation-run: <token>`; the token names an entry of this in-process
 * map for the length of one action, so nothing outside this process can present one (inject never
 * leaves the process, and a guessed 256-bit token is not plausible).
 */
export const AUTOMATION_RUN_HEADER = 'x-inkling-automation-run'

const runs = new Map<string, AuthUser>()

/** The user of a live run token, or null. */
export function automationRunUser(token: string): AuthUser | null {
  return runs.get(token) ?? null
}

/** Run `fn` with a fresh token that authenticates as `user` until `fn` settles. */
export async function withRunToken<T>(user: AuthUser, fn: (token: string) => Promise<T>): Promise<T> {
  const token = randomBytes(32).toString('base64url')
  runs.set(token, user)
  try {
    return await fn(token)
  } finally {
    runs.delete(token)
  }
}

/** Live tokens (tests). */
export function liveRunTokens(): number {
  return runs.size
}
