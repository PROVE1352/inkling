import type { FastifyRequest } from 'fastify'
import { forbidden } from './errors'
import { outOfRange } from './tokenRange'
import type { RangeScope } from './tokenRange'

/**
 * Which routes a bearer token may call (docs/adr/1201-*, 1202-*).
 *
 * Before personal API tokens, a bearer token reached REST only through the /mcp handler's inject,
 * so the MCP tool list was the effective allow-list. An API token reaches every /api route, so the
 * routes that must stay in a signed-in browser are listed here, in one place, and `requireUser`
 * refuses them for every bearer request (API tokens and, as a backstop, OAuth tokens). Routes that
 * already check `req.authVia !== 'cookie'` themselves (2FA, password, OAuth consent and grants,
 * API token management, workspace administration, notification settings, edit locks, plugins,
 * sidebar, the admin API) are not repeated here.
 *
 * Matching uses the route pattern Fastify resolved (`req.routeOptions.url`), never the raw URL
 * (an encoded path cannot slip past, as in guard.ts).
 */

type Rule = { method: string; url: string; reason: string }

/** Refused for every bearer token: credentials, membership, outbound data, irreversible actions. */
export const SESSION_ONLY: Rule[] = [
  { method: '*', url: '/api/me/ical', reason: 'issues an unscoped feed credential' },
  { method: '*', url: '/api/workspaces/:id/webhooks', reason: 'sends workspace events to an outside URL' },
  { method: '*', url: '/api/webhooks/:id', reason: 'webhook settings' },
  { method: '*', url: '/api/webhooks/:id/test', reason: 'webhook settings' },
  { method: '*', url: '/api/webhooks/:id/secret', reason: 'webhook signing secret' },
  { method: '*', url: '/api/webhooks/:id/deliveries', reason: 'webhook settings' },
  { method: '*', url: '/api/webhooks/:id/deliveries/:deliveryId/resend', reason: 'webhook settings' },
  { method: 'POST', url: '/api/pages/:id/share', reason: 'publishes a page to the web' },
  { method: 'PATCH', url: '/api/pages/:id/share', reason: 'public link password and expiry' },
  { method: 'DELETE', url: '/api/pages/:id/share', reason: 'public link' },
  { method: 'POST', url: '/api/pages/:id/publish/notion', reason: 'sends a page to an outside service' },
  { method: 'PUT', url: '/api/pages/:id/collection/sheet-sync', reason: 'stores an outside URL the server fetches' },
  { method: 'DELETE', url: '/api/pages/:id/collection/sheet-sync', reason: 'sheet sync settings' },
  { method: 'DELETE', url: '/api/pages/:id/purge', reason: 'permanent deletion' },
  { method: 'POST', url: '/api/workspaces/join', reason: 'joins a workspace with an invite code' },
  { method: 'POST', url: '/api/workspaces/:id/invite/regenerate', reason: 'invite code' },
  { method: 'POST', url: '/api/workspaces/:id/members', reason: 'membership' },
  { method: 'PATCH', url: '/api/workspaces/:id/members/:userId', reason: 'member roles' },
  { method: 'DELETE', url: '/api/workspaces/:id/members/:userId', reason: 'membership' },
  { method: 'POST', url: '/api/workspaces/:id/transfer', reason: 'ownership' },
  { method: 'PATCH', url: '/api/workspaces/:id', reason: 'workspace settings' },
  { method: 'DELETE', url: '/api/workspaces/:id', reason: 'deletes a workspace' },
  { method: 'GET', url: '/api/workspaces/:id/delete-preview', reason: 'workspace deletion' },
  { method: 'POST', url: '/api/workspaces/:id/restore', reason: 'workspace deletion' },
  { method: 'GET', url: '/api/workspaces/deleted', reason: 'workspace deletion' },
]

/** Refused for a token limited to some workspaces or a subtree: they reach past the range. */
export const RANGED_DENY: Rule[] = [
  { method: 'POST', url: '/api/workspaces', reason: 'a new workspace is outside the range' },
  { method: 'GET', url: '/api/workspaces/invite-preview', reason: 'other workspaces' },
  { method: 'GET', url: '/api/workspaces/:id/member-candidates', reason: 'people of other workspaces' },
]

/**
 * Refused for a subtree range: workspace-wide objects that hold page content from anywhere in the
 * workspace (templates are copies of pages taken when they were saved).
 */
export const SUBTREE_DENY: Rule[] = [
  { method: '*', url: '/api/workspaces/:id/templates', reason: 'workspace templates' },
  { method: '*', url: '/api/workspaces/:id/templates/:tid/preview', reason: 'workspace templates' },
  { method: '*', url: '/api/workspaces/:id/templates/:tid/export', reason: 'workspace templates' },
  { method: '*', url: '/api/workspaces/:id/templates/import', reason: 'workspace templates' },
  { method: '*', url: '/api/templates/:id', reason: 'workspace templates' },
  { method: '*', url: '/api/pages/from-template', reason: 'copies template content into the range' },
]

function matches(rules: Rule[], method: string, url: string): Rule | undefined {
  return rules.find((r) => r.url === url && (r.method === '*' || r.method === method))
}

export const SESSION_ONLY_MESSAGE = 'This can only be done in the web app while signed in, not with a token'

/**
 * Throws for a bearer request to a route it may not call. `range` is the token's range (null =
 * everything). Called from requireUser after the token is accepted.
 */
export function assertBearerRouteAllowed(req: FastifyRequest, range: RangeScope | null | undefined): void {
  const url = req.routeOptions?.url
  if (!url) return
  const method = req.method === 'HEAD' ? 'GET' : req.method
  if (matches(SESSION_ONLY, method, url)) throw forbidden(SESSION_ONLY_MESSAGE)
  if (!range) return
  if (matches(RANGED_DENY, method, url)) throw outOfRange()
  if (range.kind === 'subtree' && matches(SUBTREE_DENY, method, url)) throw outOfRange()
}
