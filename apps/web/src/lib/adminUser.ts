import type { AdminUserDTO } from '@inkling/shared'

/**
 * How an account was created, for the admin user list badge:
 * - `signupKey`: an Inkling account registered with a signup key (users.signup_key is set)
 * - `local`: an Inkling account without a key (open signup, or created before keys were required)
 * - `delegated`: mirrored from the external auth server (delegated login)
 */
export type UserOriginBadge = 'signupKey' | 'local' | 'delegated'

export function userOriginBadge(u: Pick<AdminUserDTO, 'origin' | 'signupKey'>): UserOriginBadge {
  if (u.origin !== 'local') return 'delegated'
  return u.signupKey ? 'signupKey' : 'local'
}
