import type { FastifyInstance } from 'fastify'
import { registerAccount } from './account/register'
import { registerLegal } from './legal/register'
import { registerQuota } from './quota/register'

/**
 * Restricted mode (0.22, docs/adr/2503-*): each piece registers itself from its own register.ts, so
 * index.ts, routes/auth.ts, housekeeping.ts and the test harnesses are edited once, here.
 * Called inside the `/api` scope, after the auth routes, by index.ts and by every test app builder.
 */
export async function registerRestrictedMode(api: FastifyInstance): Promise<void> {
  await registerQuota(api)
  await registerAccount(api)
  await registerLegal(api)
}
