import { db } from '../db/index'
import { AppError } from '../errors'
import type { SignupHook } from '../signupHooks'
import { instanceFullError, isInstanceFull } from './instance'
import { assertWorkspacesTotalRoom, workspacesTotalReached } from './room'

/**
 * Sign-up against the server-wide limits of this piece (contract §14, docs/adr/2531-*, 2532-*):
 *   - LIMIT_WORKSPACES_TOTAL: a sign-up makes a personal workspace, so a server holding as many
 *     workspaces as it allows takes no new account (403 SIGNUP_FULL). Checked before anything is
 *     written, and again inside the sign-up transaction under the `ws-total` lock (the new workspace is
 *     already inserted there, so it counts).
 *   - LIMIT_INSTANCE_STORAGE_MB: a full server takes no new account (503 INSTANCE_FULL).
 * The first admin's sign-up with the setup code is never refused (like SIGNUP_MAX_USERS): it makes the
 * operator's own account. Without the settings nothing is read.
 */
export const quotaSignupHook: SignupHook = {
  async before(ctx) {
    if (ctx.setupCode) return
    if (await isInstanceFull()) throw instanceFullError()
    if (await workspacesTotalReached(db)) {
      throw new AppError(403, 'SIGNUP_FULL', 'This server is not taking new accounts right now')
    }
  },
  async on(tx, _user, ctx) {
    if (ctx.setupCode) return
    await assertWorkspacesTotalRoom(tx, 0, 'signup')
  },
}
