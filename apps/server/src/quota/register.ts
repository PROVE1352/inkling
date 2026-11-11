import type { FastifyInstance } from 'fastify'
import { registerHousekeepingTask } from '../restrictedExtras'
import { registerFeatureGate } from './features'
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
  registerUsageRoute(api)
  if (!processWide) {
    processWide = true
    registerHousekeepingTask('quota-storage-recount', async () => {
      await recountAllWorkspaces()
    })
  }
}
