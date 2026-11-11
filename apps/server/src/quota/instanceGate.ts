import type { FastifyInstance, FastifyRequest } from 'fastify'
import { instanceFullError, instanceStorageLimitBytes, isInstanceFull } from './instance'

/**
 * The /api side of the instance storage fuse (LIMIT_INSTANCE_STORAGE_MB, contract §14, docs/adr/2532-*):
 * one onRequest hook on the `/api` scope. While the fuse is tripped every POST, PUT and PATCH answers
 * 503 INSTANCE_FULL before authentication or body parsing, except the routes below; GET and DELETE
 * always pass (reading, exporting, and every deletion: pages, files, workspaces, the trash, the own
 * account). A new write route is refused by default.
 *
 * Without the setting the hook returns at once (no measurement, no read).
 */

/** Writes that keep working on a full server: signing in and out, account safety, consent, reads sent as POST, read marks, and what only removes. */
export const OPEN_WHEN_FULL: readonly string[] = [
  // signing in and out, keeping the account safe
  'POST /api/auth/login',
  'POST /api/auth/login/totp',
  'POST /api/auth/logout',
  'POST /api/auth/change-password',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'POST /api/auth/2fa/setup',
  'POST /api/auth/2fa/enable',
  'POST /api/auth/2fa/disable',
  'POST /api/auth/2fa/recovery-codes',
  // consent to the terms (LEGAL_DIR): without it nothing else works, deleting the account included
  'POST /api/legal/consent',
  // reads sent as POST
  'POST /api/workspaces/:id/query',
  'POST /api/workspaces/:id/charts/aggregate',
  'POST /api/workspaces/:id/sync/read',
  'POST /api/public/:token/unlock',
  // read marks (part of reading)
  'POST /api/inbox/ack',
  'POST /api/notifications/read',
  'POST /api/threads/:id/read',
  // what only removes or hands over
  'POST /api/suggestions/:id/reject',
  'POST /api/suggestions/:id/withdraw',
  'POST /api/workspaces/:id/shared/unpublish',
  'POST /api/workspaces/:id/guests/remove',
  'POST /api/connections/release',
  'POST /api/workspaces/:id/agent-connections/release',
  'POST /api/workspaces/:id/transfer',
]

const open = new Set(OPEN_WHEN_FULL)

/** Is this request refused while the fuse is tripped? (pure, for tests) */
export function refusedWhenFull(req: Pick<FastifyRequest, 'method' | 'routeOptions' | 'url'>): boolean {
  const m = req.method.toUpperCase()
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return false
  const url = req.routeOptions?.url ?? req.url.split('?')[0]
  // the server admin's screens and API keep working (the operator makes room there)
  if (url === '/api/admin' || url.startsWith('/api/admin/')) return false
  return !open.has(`${m} ${url}`)
}

export function registerInstanceGate(api: FastifyInstance): void {
  api.addHook('onRequest', async (req) => {
    if (instanceStorageLimitBytes() == null) return
    if (!refusedWhenFull(req)) return
    if (await isInstanceFull()) throw instanceFullError()
  })
}
