import type { FastifyInstance } from 'fastify'
import type { AuthModeDTO } from '@inkling/shared'
import { db } from '../db/index'
import { registerAuthModeExtra, registerHousekeepingTask } from '../restrictedExtras'
import { registerSignupHook } from '../signupHooks'
import { registerFeatureGate } from './features'
import { instanceStorageLimitBytes, isInstanceFull, measureInstanceStorage } from './instance'
import { registerInstanceGate } from './instanceGate'
import { workspacesTotalReached } from './room'
import { quotaSignupHook } from './signup'
import { recountAllWorkspaces } from './storage'
import { registerUsageRoute } from './usage'

let processWide = false

/**
 * Restricted mode, piece A (limits and features turned off, docs/adr/2505-* .. 2511-*): the one place
 * this piece registers itself. restricted.ts registerRestrictedMode calls it inside the `/api` scope
 * of every app (index.ts and the test harnesses), after the auth routes.
 *
 * Per app: the usage route and the feature gate (an onRequest hook on the `/api` scope; Fastify
 * applies a scope's hooks to every route of the scope, the auth routes declared before it included).
 * Once per process: the hourly storage recount.
 *
 * The limit checks themselves (quota/room.ts) are called from the creating paths, and the features'
 * background senders check the setting where they act; neither needs registering.
 */
export async function registerQuota(api: FastifyInstance): Promise<void> {
  registerFeatureGate(api)
  // LIMIT_INSTANCE_STORAGE_MB: writes under /api refused while the fuse is tripped (docs/adr/2532-*)
  registerInstanceGate(api)
  registerUsageRoute(api)
  if (!processWide) {
    processWide = true
    registerHousekeepingTask('quota-storage-recount', async () => {
      await recountAllWorkspaces()
    })
    // LIMIT_WORKSPACES_TOTAL and the instance fuse (contract §14, docs/adr/2531-*, 2532-*): the sign-up
    // checks and the auth mode fields. Each answers nothing and reads nothing without its setting.
    registerSignupHook('quota-server-limits', quotaSignupHook)
    // the fuse is measured at least hourly even when nothing asks (and at most once a minute when asked)
    registerHousekeepingTask('quota-instance-measure', async () => {
      if (instanceStorageLimitBytes() != null) await measureInstanceStorage()
    })
    registerAuthModeExtra('quota-server-limits', async () => {
      const out: Partial<AuthModeDTO> = {}
      if (await workspacesTotalReached(db)) out.signupFull = true
      if (await isInstanceFull()) {
        out.instanceFull = true
        out.signupFull = true
      }
      return out
    })
  }
}
