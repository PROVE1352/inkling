import type { FastifyInstance } from 'fastify'
import { registerAuthModeExtra, registerHousekeepingTask } from '../restrictedExtras'
import { registerSignupHook } from '../signupHooks'
import { expireAccounts, purgeAccountRecords } from './housekeeping'
import { registerAccountRoutes } from './routes'
import { proxyWarning, signupChecksOn, signupGuardHook } from './signupGuards'

/**
 * Restricted mode, piece B (accounts: sign-in IDs, deletion, lifetime, docs/adr/2512-* .. 2517-*): the one place this piece registers itself.
 * restricted.ts registerRestrictedMode calls it inside the `/api` scope of every app (index.ts and the
 * test harnesses), after the auth routes.
 *
 * This function runs every time an app is built, and a test process builds several apps: routes go on
 * the `api` it is given each time, but hooks, gates, extras and housekeeping jobs are process-wide and
 * registered only once (module flag).
 *
 * Every registered part does nothing while its setting is unset; the routes (DELETE /api/me,
 * GET /api/me/delete-preview, DELETE /api/workspaces/:id/permanent, the admin expiry routes) exist on
 * every server (contract §0, exceptions a and e).
 */
let registered = false

export async function registerAccount(api: FastifyInstance): Promise<void> {
  await registerAccountRoutes(api)
  if (registered) return
  registered = true
  registerSignupHook('account-signup-limits', signupGuardHook)
  // tells the sign-up form to send the bot-check fields; absent (as in 0.21.1) without sign-up limits
  registerAuthModeExtra('account-signup-checks', () => (signupChecksOn() ? { signupChecks: true } : {}))
  registerHousekeepingTask('account-lifetime', async () => {
    await expireAccounts((m) => console.warn(m))
  })
  registerHousekeepingTask('account-records-retention', async () => {
    await purgeAccountRecords()
  })
  const w = proxyWarning()
  if (w) console.warn(w)
}
