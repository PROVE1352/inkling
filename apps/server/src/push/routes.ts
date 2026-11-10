import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  DEFAULT_PUSH_KINDS,
  PUSH_KIND_GROUPS,
  pushSubscribeSchema,
  pushTestSchema,
  pushUnsubscribeSchema,
  updatePushSettingsSchema,
} from '@inkling/shared'
import type { PushDeviceDTO, PushKeyDTO, PushKindGroup, PushSettingsDTO } from '@inkling/shared'
import { getUser, requireUser, SESSION_COOKIE } from '../auth'
import { db } from '../db/index'
import { AppError, forbidden, notFound } from '../errors'
import { idParam } from '../helpers'
import { protectSecret } from '../secretsAtRest'
import { hashSessionToken } from '../sessionTokens'
import { endpointHash, PushEndpointError, pushEnv, validateEndpoint } from './config'
import { noteSubscriptionAdded, queueTestPush } from './deliver'
import { activeVapid, PushUnavailableError } from './keys'
import { assertSubscriptionKeys } from './webPushCrypto'

/**
 * /api/push/* (docs/adr/2220-* .. 2223-*). Browser sessions only: a bearer connection (an agent, an
 * API token) that registered an endpoint would receive the person's notification text, and push
 * settings must not be silenced by an agent (the rule of notification settings, docs/adr/1004-*).
 * Every account may use it, guests included: push mirrors the person's own bell, which the
 * notification engine already limits to workspaces they are a member of.
 *
 *   GET    /api/push/key              VAPID public key, and whether the server can push at all
 *   GET    /api/push/settings         my switch, kinds, "hide content" and my devices
 *   PATCH  /api/push/settings
 *   POST   /api/push/subscriptions    register (or refresh) this browser's subscription
 *   DELETE /api/push/subscriptions    this browser off (body: { endpoint })
 *   DELETE /api/push/devices/:id      one of my devices off
 *   POST   /api/push/test             a test notification to my devices (or one)
 */

/** Devices per person; registering one more removes the one that has gone longest without a delivery. */
export const MAX_DEVICES_PER_USER = 20

async function requireBrowserUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Push notifications are managed in the web app only')
}

function sessionTokenOf(req: FastifyRequest): string {
  const raw = req.cookies?.[SESSION_COOKIE]
  if (!raw) throw forbidden('Push notifications are managed in the web app only')
  return hashSessionToken(raw)
}

const unavailable = () => new AppError(503, 'PUSH_UNAVAILABLE', 'Push notifications are not available on this server')

async function requireVapid() {
  try {
    return await activeVapid()
  } catch (e) {
    if (e instanceof PushUnavailableError) throw unavailable()
    throw e
  }
}

/** "Chrome on macOS" from a user agent (a hint for the device list, never trusted for anything). */
export function deviceLabel(ua: string | undefined): string | null {
  if (!ua) return null
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null
  if (!browser && !os) return null
  return [browser, os].filter(Boolean).join(' · ')
}

interface SettingsRow {
  enabled: boolean
  kinds: string[] | null
  hideContent: boolean
}

async function loadSettings(userId: string): Promise<SettingsRow> {
  const [r] = (await db.execute(sql`
    SELECT enabled, kinds, hide_content AS "hideContent" FROM push_settings WHERE user_id = ${userId}
  `)) as unknown as SettingsRow[]
  return r ?? { enabled: true, kinds: null, hideContent: false }
}

function kindsOf(kinds: string[] | null): PushKindGroup[] {
  if (!kinds) return [...DEFAULT_PUSH_KINDS]
  return PUSH_KIND_GROUPS.filter((k) => kinds.includes(k))
}

async function listDevices(userId: string, sessionToken: string | null, keyId: string | null): Promise<PushDeviceDTO[]> {
  const rows = (await db.execute(sql`
    SELECT id, label, vapid_key_id AS "vapidKeyId", session_token AS "sessionToken", failure_count AS "failureCount",
           to_json(created_at) #>> '{}' AS "createdAt", to_json(last_success_at) #>> '{}' AS "lastSuccessAt",
           to_json(last_failure_at) #>> '{}' AS "lastFailureAt"
      FROM push_subscriptions WHERE user_id = ${userId}
     ORDER BY created_at DESC LIMIT ${MAX_DEVICES_PER_USER}
  `)) as unknown as {
    id: string
    label: string | null
    vapidKeyId: string
    sessionToken: string
    failureCount: number
    createdAt: string
    lastSuccessAt: string | null
    lastFailureAt: string | null
  }[]
  const iso = (s: string | null) => (s ? new Date(s).toISOString() : null)
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: new Date(r.createdAt).toISOString(),
    lastSuccessAt: iso(r.lastSuccessAt),
    lastFailureAt: iso(r.lastFailureAt),
    failureCount: Number(r.failureCount),
    current: sessionToken !== null && r.sessionToken === sessionToken,
    stale: keyId !== null && r.vapidKeyId !== keyId,
  }))
}

async function settingsDto(req: FastifyRequest, userId: string): Promise<PushSettingsDTO> {
  let keyId: string | null = null
  let available = false
  try {
    keyId = (await activeVapid()).keyId
    available = true
  } catch {
    available = false
  }
  const s = await loadSettings(userId)
  const token = req.cookies?.[SESSION_COOKIE] ? hashSessionToken(req.cookies[SESSION_COOKIE]!) : null
  return { available, enabled: s.enabled, kinds: kindsOf(s.kinds), hideContent: s.hideContent, devices: await listDevices(userId, token, keyId) }
}

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/push/key', { preHandler: requireBrowserUser }, async () => {
    try {
      const v = await activeVapid()
      const dto: PushKeyDTO = { available: true, publicKey: v.keys.publicKey }
      return dto
    } catch (e) {
      if (!(e instanceof PushUnavailableError)) throw e
      const dto: PushKeyDTO = { available: false, publicKey: null }
      return dto
    }
  })

  app.get('/push/settings', { preHandler: requireBrowserUser }, async (req) => settingsDto(req, getUser(req).id))

  app.patch('/push/settings', { preHandler: requireBrowserUser }, async (req) => {
    const user = getUser(req)
    const b = updatePushSettingsSchema.parse(req.body)
    const cur = await loadSettings(user.id)
    const enabled = b.enabled ?? cur.enabled
    const kinds = b.kinds ? PUSH_KIND_GROUPS.filter((k) => b.kinds!.includes(k)) : cur.kinds
    const hideContent = b.hideContent ?? cur.hideContent
    await db.execute(sql`
      INSERT INTO push_settings (user_id, enabled, kinds, hide_content, updated_at)
      VALUES (${user.id}, ${enabled}, ${kinds === null ? null : JSON.stringify(kinds)}::jsonb, ${hideContent}, now())
      ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, kinds = EXCLUDED.kinds,
        hide_content = EXCLUDED.hide_content, updated_at = now()
    `)
    return settingsDto(req, user.id)
  })

  app.post(
    '/push/subscriptions',
    { preHandler: requireBrowserUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const session = sessionTokenOf(req)
      if (!pushEnv.enabled) throw unavailable()
      const b = pushSubscribeSchema.parse(req.body)
      // One coarse answer for every refusal: the route must not tell which address checks failed.
      try {
        validateEndpoint(b.endpoint)
        assertSubscriptionKeys(b.keys)
      } catch (e) {
        if (e instanceof PushEndpointError && e.code === 'host_not_allowed') {
          throw new AppError(400, 'PUSH_SERVICE_NOT_ALLOWED', "This browser's push service is not allowed on this server")
        }
        throw new AppError(400, 'PUSH_SUBSCRIPTION_INVALID', 'Invalid push subscription')
      }
      const vapid = await requireVapid()
      const hash = endpointHash(b.endpoint)
      const ua = (req.headers['user-agent'] ?? '').slice(0, 300) || null
      const label = b.label || deviceLabel(ua ?? undefined)
      const id = await db.transaction(async (tx) => {
        // The browser keeps one subscription per site: whoever registers it last owns it (another
        // account signing in on a shared browser takes it over and gets a new row id).
        const [cur] = (await tx.execute(sql`
          SELECT id, user_id AS "userId" FROM push_subscriptions WHERE endpoint_hash = ${hash} FOR UPDATE
        `)) as unknown as { id: string; userId: string }[]
        const rowId = cur && cur.userId === user.id ? cur.id : randomUUID()
        const [row] = (await tx.execute(sql`
          INSERT INTO push_subscriptions (id, user_id, session_token, endpoint_hash, endpoint, p256dh, auth, vapid_key_id, label, user_agent)
          VALUES (${rowId}, ${user.id}, ${session}, ${hash}, ${protectSecret('push-endpoint', b.endpoint, rowId)}, ${b.keys.p256dh},
                  ${protectSecret('push-auth', b.keys.auth, rowId)}, ${vapid.keyId}, ${label}, ${ua})
          ON CONFLICT (endpoint_hash) DO UPDATE SET
            id = EXCLUDED.id, user_id = EXCLUDED.user_id, session_token = EXCLUDED.session_token, endpoint = EXCLUDED.endpoint,
            p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, vapid_key_id = EXCLUDED.vapid_key_id,
            label = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id AND ${b.label === undefined}
                         THEN coalesce(push_subscriptions.label, EXCLUDED.label) ELSE EXCLUDED.label END,
            user_agent = EXCLUDED.user_agent, failure_count = 0, last_error = NULL,
            created_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.created_at ELSE now() END,
            last_success_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.last_success_at END,
            last_failure_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.last_failure_at END
          RETURNING id
        `)) as unknown as { id: string }[]
        // Over the cap: drop the devices that have gone longest without a delivery.
        await tx.execute(sql`
          DELETE FROM push_subscriptions WHERE id IN (
            SELECT id FROM push_subscriptions WHERE user_id = ${user.id}
             ORDER BY coalesce(last_success_at, created_at) DESC OFFSET ${MAX_DEVICES_PER_USER})
        `)
        return row.id
      })
      noteSubscriptionAdded()
      const devices = await listDevices(user.id, session, vapid.keyId)
      return reply.code(201).send({ id, device: devices.find((d) => d.id === id) ?? null })
    },
  )

  app.delete('/push/subscriptions', { preHandler: requireBrowserUser }, async (req, reply) => {
    const user = getUser(req)
    const b = pushUnsubscribeSchema.parse(req.body)
    await db.execute(sql`DELETE FROM push_subscriptions WHERE endpoint_hash = ${endpointHash(b.endpoint)} AND user_id = ${user.id}`)
    return reply.code(204).send()
  })

  app.delete('/push/devices/:id', { preHandler: requireBrowserUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const out = (await db.execute(sql`
      DELETE FROM push_subscriptions WHERE id = ${id} AND user_id = ${user.id} RETURNING 1
    `)) as unknown as unknown[]
    if (!out.length) throw notFound()
    return reply.code(204).send()
  })

  app.post(
    '/push/test',
    { preHandler: requireBrowserUser, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const b = pushTestSchema.parse(req.body ?? {})
      await requireVapid()
      const queued = await queueTestPush(user.id, b.deviceId)
      if (b.deviceId && queued === 0) throw notFound()
      return { queued }
    },
  )
}
