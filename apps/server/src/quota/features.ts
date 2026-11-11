import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DisabledFeatureName } from '@inkling/shared'
import { AppError } from '../errors'
import { isFeatureDisabled, limits } from '../limits'

/**
 * Features turned off with DISABLED_FEATURES (docs/adr/2507-*).
 *
 * Every route of a feature stays registered and answers 404 FEATURE_DISABLED while the feature is
 * off, decided per request (so a test that changes the setting sees it at once, and the MCP test
 * harness behaves like the server). What already exists stops working too: the background senders
 * (webhook deliveries, Slack, web push, automation hooks), public links and forms, iCal feeds and the
 * embed frame origins check the setting themselves where they act. Nothing is deleted.
 *
 * Kept on while the feature is off: the routes that remove or switch off what exists (unpublish,
 * delete a webhook, a Slack link or an iCal token, unsubscribe a device), so an owner can still
 * clean up.
 *
 * Routes inside `/api` are listed here by method and Fastify route pattern and refused by one
 * `onRequest` hook on the `/api` scope (registerQuota). Routes outside `/api` (`/s/:token`,
 * `/ical/:file`, Slack's signed endpoints live inside) call assertFeatureOn in their handler.
 */
export const FEATURE_ROUTES: Record<DisabledFeatureName, readonly string[]> = {
  'public-links': [
    'POST /api/pages/:id/share',
    'PATCH /api/pages/:id/share',
    'GET /api/public/:token',
    'GET /api/public/:token/export.md',
    'GET /api/public/:token/f/:fileId',
    'GET /api/public/:token/p/:ref',
    'GET /api/public/:token/p/:ref/export.md',
    'GET /api/public/:token/p/:ref/f/:fileId',
    'POST /api/public/:token/unlock',
  ],
  'public-forms': [
    'GET /api/collection-views/:id/form-link',
    'POST /api/collection-views/:id/form-link',
    'GET /api/public/forms/:token',
    'POST /api/public/forms/:token',
  ],
  webhooks: [
    'GET /api/workspaces/:id/webhooks',
    'POST /api/workspaces/:id/webhooks',
    'PATCH /api/webhooks/:id',
    'POST /api/webhooks/:id/test',
    'POST /api/webhooks/:id/secret',
    'GET /api/webhooks/:id/deliveries',
    'POST /api/webhooks/:id/deliveries/:deliveryId/resend',
  ],
  slack: [
    'GET /api/workspaces/:id/slack',
    'PUT /api/workspaces/:id/slack',
    'POST /api/workspaces/:id/slack/test',
    'GET /api/workspaces/:id/slack/links',
    'POST /api/slack/link/preview',
    'POST /api/slack/link/confirm',
    'POST /api/slack/w/:workspaceId/commands',
    'POST /api/slack/w/:workspaceId/events',
  ],
  'link-preview': ['GET /api/link-preview'],
  'web-clipper': ['POST /api/clip', 'GET /api/clip/lookup'],
  ical: ['GET /api/me/ical', 'POST /api/me/ical'],
  'notion-import': [],
  'web-push': ['GET /api/push/key', 'POST /api/push/subscriptions', 'PATCH /api/push/settings', 'POST /api/push/test'],
  'password-reset': [
    'POST /api/auth/forgot-password',
    'POST /api/auth/reset-password',
    'POST /api/admin/users/:id/temp-password',
    'POST /api/admin/users/:id/reset-code',
    'POST /api/admin/users/:id/send-credential',
    'GET /api/admin/reset-requests',
    'POST /api/admin/reset-requests/:id/dismiss',
  ],
  'email-invites': ['POST /api/admin/signup-keys/:key/send-invite'],
  'automations-webhooks': ['POST /api/pages/:id/button-webhook', 'GET /api/workspaces/:id/webhook-targets'],
  'oauth-cimd': [],
  embeds: [],
  'member-direct-add': ['POST /api/workspaces/:id/members', 'GET /api/workspaces/:id/member-candidates'],
}

/** "METHOD pattern" → feature, built once. HEAD follows GET. */
const ROUTE_FEATURE = new Map<string, DisabledFeatureName>()
for (const [name, routes] of Object.entries(FEATURE_ROUTES) as [DisabledFeatureName, readonly string[]][]) {
  for (const r of routes) ROUTE_FEATURE.set(r, name)
}

export function featureDisabledError(name: DisabledFeatureName): AppError {
  return new AppError(404, 'FEATURE_DISABLED', `This server has turned off ${name}`, undefined, { feature: name })
}

/** Throws 404 FEATURE_DISABLED when the operator turned the feature off. */
export function assertFeatureOn(name: DisabledFeatureName): void {
  if (isFeatureDisabled(name)) throw featureDisabledError(name)
}

/** The feature a request's route belongs to (null = none). */
export function routeFeature(req: Pick<FastifyRequest, 'method' | 'routeOptions'>): DisabledFeatureName | null {
  const url = req.routeOptions?.url
  if (!url) return null
  const method = req.method === 'HEAD' ? 'GET' : req.method
  return ROUTE_FEATURE.get(`${method} ${url}`) ?? null
}

/**
 * One onRequest hook on the `/api` scope: a route of a feature that is off answers 404
 * FEATURE_DISABLED before authentication, body parsing or rate limits. No feature off → one length
 * check per request.
 */
export function registerFeatureGate(api: FastifyInstance): void {
  api.addHook('onRequest', async (req) => {
    if (limits.disabledFeatures.length === 0) return
    const name = routeFeature(req)
    if (name && isFeatureDisabled(name)) throw featureDisabledError(name)
  })
}
