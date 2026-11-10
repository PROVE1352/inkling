import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { DEFAULT_PUSH_KINDS, PUSH_GROUP_OF_TYPE } from '@inkling/shared'
import { db } from '../db/index'
import { resolveLocale } from '../i18n'
import { backoffMs, drainOutbox, kickOutbox, OUTBOX_ORIGIN, outboxCommitted, ownedOrOrphaned, registerOutboxHandler, wakeAt } from '../outbox'
import type { Exec, RetryPolicy } from '../outbox'
import { SafeFetchError, safeFetch } from '../safeFetch'
import { revealSecret } from '../secretsAtRest'
import { twoFactorBlockedSql } from '../twoFactorPolicy'
import { liveWorkspace } from '../workspaceLive'
import { audienceOf, endpointFetchPolicy, pushEnv, validateEndpoint, vapidSubject } from './config'
import { activeVapid, PushUnavailableError } from './keys'
import { notificationPayload, testPayload } from './payload'
import type { PushItem } from './payload'
import { encryptPayload, vapidAuthorization, vapidJwt } from './webPushCrypto'

/**
 * Web push delivery (docs/adr/2222-*).
 *
 *  - Source: the notification engine. After a consumer pass wrote its notification rows,
 *    `enqueuePushInTx` queues one outbox row per (notification, browser subscription) of the people
 *    who want that kind pushed, in ONE statement inside a savepoint of the same transaction: the rows
 *    commit with the notifications, and a failure here never fails a notification. Only rows that
 *    ping ('now') push; quiet rows, and hand-offs to an agent connection the person keeps no copy of,
 *    do not. Due-date reminders queue the same way after their insert (md/reminders.ts).
 *  - Coalescing: the dedupe key holds a 30 s bucket, so a burst on one thread or page sends one push
 *    per device; its text is built at send time from the (collapsed) row, so it says the latest.
 *  - Privacy at send time: the row must still exist, be unread, and its page must be visible to the
 *    person now (the mailer's rule: member, live page and workspace, private pages only for their
 *    author, not held back by a 2FA requirement). The person's push switch and kinds are read again.
 *  - Delivery: outbox topic 'push', leased while the HTTP call runs (at-least-once), CONCURRENCY at
 *    a time per process, retries with capped exponential backoff (the push service's Retry-After
 *    honoured), then 'dead'. 404/410 remove the subscription at once; PUSH_MAX_FAILURES failures in a
 *    row remove it too. No redirects are followed and at most 4 KiB of a response is read.
 */

export const PUSH_RETRY: RetryPolicy = { baseMs: 10_000, factor: 3, capMs: 30 * 60_000, maxAttempts: 5 }
export const PUSH_LEASE_MS = 30_000
/** Failed deliveries in a row after which a subscription is removed. */
export const PUSH_MAX_FAILURES = 10
/** Pending deliveries per person; beyond this new ones are dropped (flood guard). */
export const PUSH_QUEUE_MAX_PER_USER = 100
/** How long the push service keeps a message for a device that is offline. */
export const PUSH_TTL_S = 24 * 60 * 60
const CONCURRENCY = 4
const COALESCE_MS = 30_000
const TIMEOUT_MS = 10_000

export type PushJob = { t: 'n'; n: string; s: string; u: string } | { t: 'test'; s: string; u: string }

let log: (msg: string) => void = (m) => console.error(m)

export function initPush(logger: (msg: string) => void): void {
  log = logger
}

/** Notification rows a consumer pass wrote (what the engine hands over). */
export interface WrittenRow {
  id: string
  userId: string
  type: string
  delivery: 'now' | 'quiet'
  workspaceId: string | null
  connection: string | null
  personToo: boolean
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Whether any subscription exists (cached for a few seconds): most installs have none, and the
 * notify pass then runs no push statement at all.
 */
let anySubs: { v: boolean; at: number } | null = null
const ANY_SUBS_TTL_MS = 10_000

export function noteSubscriptionAdded(): void {
  anySubs = { v: true, at: Date.now() }
}

async function hasSubscriptions(exec: Exec): Promise<boolean> {
  if (anySubs && Date.now() - anySubs.at < ANY_SUBS_TTL_MS) return anySubs.v
  const r = (await exec.execute(sql`SELECT EXISTS (SELECT 1 FROM push_subscriptions) AS v`)) as unknown as { v: boolean }[]
  anySubs = { v: !!r[0]?.v, at: Date.now() }
  return anySubs.v
}

/** The rows of `written` that may push (before the per-person choices, which SQL applies). */
export function pushCandidates(written: readonly WrittenRow[]): { id: string; uid: string; grp: string; ws: string | null }[] {
  const out: { id: string; uid: string; grp: string; ws: string | null }[] = []
  for (const w of written) {
    if (w.delivery !== 'now') continue
    // a hand-off to one agent connection reaches the person only with their "copies" setting
    if (w.connection && !w.personToo) continue
    const grp = PUSH_GROUP_OF_TYPE[w.type]
    if (!grp) continue
    out.push({ id: w.id, uid: w.userId, grp, ws: w.workspaceId })
  }
  return out
}

/**
 * Queue deliveries for notification rows with `exec` (a transaction or `db`): ONE statement joining
 * the rows with their people's subscriptions and push settings. Returns the number queued; call
 * `outboxCommitted(['push'])` after the commit (`pushCommitted`).
 */
export async function queuePushFor(exec: Exec, written: readonly WrittenRow[], now = Date.now()): Promise<number> {
  if (!pushEnv.enabled) return 0
  const rows = pushCandidates(written)
  if (!rows.length) return 0
  if (!(await hasSubscriptions(exec))) return 0
  const bucket = Math.floor(now / COALESCE_MS)
  const out = (await exec.execute(sql`
    WITH n AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id uuid, uid uuid, grp text, ws uuid)
    ), pending AS (
      SELECT payload->>'u' AS uid, count(*) AS c FROM outbox
       WHERE topic = 'push' AND state = 'pending' AND payload->>'u' IN (SELECT uid::text FROM n)
       GROUP BY 1
    )
    INSERT INTO outbox (topic, origin, dedupe_key, workspace_id, payload)
    SELECT 'push', ${OUTBOX_ORIGIN}, 'push:' || n.id || ':' || s.id || ':' || ${bucket}::text, n.ws,
           jsonb_build_object('t', 'n', 'n', n.id, 's', s.id, 'u', n.uid)
      FROM n
      JOIN push_subscriptions s ON s.user_id = n.uid
      LEFT JOIN push_settings ps ON ps.user_id = n.uid
      LEFT JOIN pending ON pending.uid = n.uid::text
     WHERE coalesce(ps.enabled, true)
       AND (CASE WHEN ps.kinds IS NULL THEN n.grp = ANY(${`{${DEFAULT_PUSH_KINDS.join(',')}}`}::text[]) ELSE ps.kinds @> jsonb_build_array(n.grp) END)
       AND coalesce(pending.c, 0) < ${PUSH_QUEUE_MAX_PER_USER}
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1
  `)) as unknown as unknown[]
  return out.length
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * In the notify consumer's transaction, in a savepoint: a failure here leaves the notification rows
 * untouched. Returns whether rows were queued (pass it to `pushCommitted` after the commit).
 */
export async function enqueuePushInTx(tx: Tx, written: readonly WrittenRow[]): Promise<boolean> {
  if (!pushEnv.enabled || !written.length) return false
  try {
    if (!pushCandidates(written).length) return false
    return await tx.transaction(async (sp) => (await queuePushFor(sp, written)) > 0)
  } catch (err) {
    log(`[push] queueing deliveries failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    return false
  }
}

/** After the commit of rows queued by `enqueuePushInTx`. */
export function pushCommitted(queued: boolean): void {
  if (queued) outboxCommitted(['push'])
}

/**
 * Queue deliveries for notification rows written outside the engine (due-date reminders), right
 * after their insert. Never throws.
 */
export async function pushForInserted(ids: readonly string[]): Promise<void> {
  if (!pushEnv.enabled || !ids.length) return
  try {
    const rows = (await db.execute(sql`
      SELECT id, user_id AS "userId", type, delivery, workspace_id AS "workspaceId", connection, person_too AS "personToo"
        FROM notifications WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])
    `)) as unknown as WrittenRow[]
    if ((await queuePushFor(db, rows)) > 0) outboxCommitted(['push'])
  } catch (err) {
    log(`[push] queueing deliveries failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
}

/** A test push to one or all of a person's subscriptions (POST /api/push/test). Returns how many. */
export async function queueTestPush(userId: string, subscriptionId?: string): Promise<number> {
  const out = (await db.execute(sql`
    INSERT INTO outbox (topic, origin, dedupe_key, payload)
    SELECT 'push', ${OUTBOX_ORIGIN}, NULL, jsonb_build_object('t', 'test', 's', s.id, 'u', s.user_id)
      FROM push_subscriptions s
     WHERE s.user_id = ${userId} ${subscriptionId ? sql`AND s.id = ${subscriptionId}` : sql``}
    RETURNING 1
  `)) as unknown as unknown[]
  if (out.length) outboxCommitted(['push'])
  return out.length
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface Claimed {
  id: string
  payload: PushJob
  attempts: number
}

let inflight = 0
const running = new Set<Promise<void>>()

/** Counters since process start (admin status, tests). */
export const pushStats = { sent: 0, failed: 0, removed: 0, skipped: 0 }

export async function runPushPass(): Promise<number> {
  const free = CONCURRENCY - inflight
  if (free <= 0) return 0
  const rows = (await db.execute(sql`
    UPDATE outbox SET locked_until = now() + make_interval(secs => ${PUSH_LEASE_MS / 1000}), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
        WHERE topic = 'push' AND state = 'pending' AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now()) AND ${ownedOrOrphaned()}
        ORDER BY id LIMIT ${free}
          FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id, payload, attempts
  `)) as unknown as Claimed[]
  for (const r of rows) {
    inflight++
    const p = runJob(r).finally(() => {
      inflight--
      running.delete(p)
      kickOutbox('push')
    })
    running.add(p)
  }
  if (rows.length === 0) await armNextWake()
  return rows.length
}

registerOutboxHandler('push', runPushPass, CONCURRENCY)

async function armNextWake(): Promise<void> {
  const [r] = (await db.execute(sql`
    SELECT (extract(epoch from min(greatest(available_at, coalesce(locked_until, available_at))) - now()) * 1000)::float8 AS ms
      FROM outbox WHERE topic = 'push' AND state = 'pending'
  `)) as unknown as { ms: number | null }[]
  if (r?.ms !== null && r?.ms !== undefined) wakeAt('push', Math.min(30_000, Math.max(0, Number(r.ms)) + 5))
}

/** Tests, shutdown: run passes until nothing due is left and nothing of this process is in flight. */
export async function flushPush(maxRounds = 100): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    await drainOutbox('push', 5)
    if (running.size) {
      await Promise.allSettled([...running])
      continue
    }
    const [r] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM outbox WHERE topic = 'push' AND state = 'pending' AND available_at <= now()
    `)) as unknown as { n: number }[]
    if (!Number(r?.n)) return
    await new Promise((res) => setTimeout(res, 10))
  }
}

async function settle(r: Claimed, state: 'done' | 'dead', note: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE outbox SET state = ${state}, finished_at = now(), locked_until = NULL, last_error = ${note?.slice(0, 300) ?? null}
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}`)
}

async function retryLater(r: Claimed, delayMs: number, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE outbox SET locked_until = NULL, last_error = ${error.slice(0, 300)},
           available_at = now() + make_interval(secs => ${delayMs / 1000})
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}`)
  wakeAt('push', delayMs)
}

async function removeSubscription(id: string): Promise<void> {
  const out = (await db.execute(sql`DELETE FROM push_subscriptions WHERE id = ${id} RETURNING 1`)) as unknown as unknown[]
  pushStats.removed += out.length
}

async function recordFailure(subId: string, error: string): Promise<void> {
  const [r] = (await db.execute(sql`
    UPDATE push_subscriptions SET failure_count = failure_count + 1, last_failure_at = now(), last_error = ${error.slice(0, 100)}
     WHERE id = ${subId} RETURNING failure_count AS n
  `)) as unknown as { n: number }[]
  if (r && Number(r.n) >= PUSH_MAX_FAILURES) await removeSubscription(subId)
}

async function recordSuccess(subId: string): Promise<void> {
  await db.execute(sql`
    UPDATE push_subscriptions SET failure_count = 0, last_success_at = now(), last_error = NULL WHERE id = ${subId}`)
}

interface SubRow {
  id: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  vapidKeyId: string
  locale: string | null
  enabled: boolean | null
  kinds: string[] | null
  hideContent: boolean | null
}

async function loadSubscription(id: string, userId: string): Promise<SubRow | null> {
  const [r] = (await db.execute(sql`
    SELECT s.id, s.user_id AS "userId", s.endpoint, s.p256dh, s.auth, s.vapid_key_id AS "vapidKeyId", u.locale,
           ps.enabled, ps.kinds, ps.hide_content AS "hideContent"
      FROM push_subscriptions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN push_settings ps ON ps.user_id = s.user_id
     WHERE s.id = ${id} AND s.user_id = ${userId}
  `)) as unknown as SubRow[]
  return r ?? null
}

/**
 * The notification as the person may see it now, or null: gone, read, handed to an agent connection
 * without a copy, or its page / workspace is no longer visible to them (the mailer's send-time rule,
 * notify/mailer.ts `pending`).
 */
async function loadItem(notificationId: string, userId: string): Promise<PushItem | null> {
  const [r] = (await db.execute(sql`
    SELECT n.id, n.type, n.page_id AS "pageId", coalesce(n.workspace_id, p.workspace_id) AS "workspaceId",
           p.title, a.name AS actor, n.via_client AS via, n.excerpt, n.count,
           (n.read = '0' AND n.delivery = 'now' AND (n.connection IS NULL OR n.person_too)
             AND (n.page_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL
               AND (p.scope = 'shared' OR p.created_by = ${userId})
               AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = p.workspace_id AND m.user_id = ${userId})
               AND ${liveWorkspace(sql`p.workspace_id`)}
               AND NOT ${twoFactorBlockedSql(sql`p.workspace_id`, userId)}))
             AND (n.workspace_id IS NULL OR (
               EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = n.workspace_id AND m.user_id = ${userId})
               AND ${liveWorkspace(sql`n.workspace_id`)}
               AND NOT ${twoFactorBlockedSql(sql`n.workspace_id`, userId)}))) AS ok
      FROM notifications n
      LEFT JOIN pages p ON p.id = n.page_id
      LEFT JOIN users a ON a.id = n.actor_id
     WHERE n.id = ${notificationId} AND n.user_id = ${userId}
  `)) as unknown as (PushItem & { ok: boolean })[]
  if (!r || !r.ok) return null
  return { ...r, count: Number(r.count) }
}

/** Hash of a tag for the push service `Topic` header (≤ 32 base64url characters). */
function topicOf(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32)
}

const URGENT = new Set(['mention', 'assigned', 'approval', 'reminder'])

async function runJob(r: Claimed): Promise<void> {
  const job = r.payload
  let subId: string | null = null
  try {
    if (!pushEnv.enabled) return await skip(r, 'web push is off')
    const sub = await loadSubscription(job.s, job.u)
    if (!sub) return await skip(r, 'subscription gone')
    subId = sub.id
    let vapid
    try {
      vapid = await activeVapid()
    } catch (e) {
      if (e instanceof PushUnavailableError) return await settle(r, 'dead', `unavailable: ${e.reason}`)
      throw e
    }
    // made with another server key: it cannot work any more (the browser re-subscribes on next start)
    if (sub.vapidKeyId !== vapid.keyId) {
      await removeSubscription(sub.id)
      return await skip(r, 'subscription of an older VAPID key')
    }
    const L = resolveLocale(sub.locale)
    let payload
    let urgency = 'normal'
    if (job.t === 'test') {
      payload = testPayload(L)
    } else {
      if (sub.enabled === false) return await skip(r, 'push switched off')
      const item = await loadItem(job.n, sub.userId)
      if (!item) return await skip(r, 'not visible or already read')
      const grp = PUSH_GROUP_OF_TYPE[item.type]
      const kinds = sub.kinds ?? [...DEFAULT_PUSH_KINDS]
      if (!grp || !kinds.includes(grp)) return await skip(r, 'kind switched off')
      if (URGENT.has(grp)) urgency = 'high'
      payload = notificationPayload(item, L, sub.hideContent === true)
    }
    let endpoint: string
    let auth: string
    try {
      endpoint = revealSecret('push-endpoint', sub.endpoint, sub.id)
      auth = revealSecret('push-auth', sub.auth, sub.id)
    } catch {
      await removeSubscription(sub.id)
      return await settle(r, 'dead', 'secret_unreadable')
    }
    let url: URL
    try {
      url = validateEndpoint(endpoint)
    } catch {
      // the allowlist changed since it was registered
      await removeSubscription(sub.id)
      return await settle(r, 'dead', 'endpoint not allowed')
    }
    const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), { p256dh: sub.p256dh, auth })
    const jwt = vapidJwt({ audience: audienceOf(url), subject: vapidSubject(), keys: vapid.keys })
    let status: number
    let retryAfter: number | undefined
    try {
      const res = await safeFetch(url.href, {
        ...endpointFetchPolicy(),
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/octet-stream',
          'content-encoding': 'aes128gcm',
          ttl: String(PUSH_TTL_S),
          urgency,
          topic: topicOf(payload.tag),
          authorization: vapidAuthorization(jwt, vapid.keys.publicKey),
          'user-agent': 'Inkling-WebPush/1',
        },
        maxBytes: 4096,
        truncate: true,
        timeoutMs: TIMEOUT_MS,
      })
      status = res.status
      const ra = Number(res.headers['retry-after'])
      retryAfter = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, PUSH_RETRY.capMs) : undefined
    } catch (e) {
      const code = e instanceof SafeFetchError ? e.code : 'network'
      if (code === 'blocked_address' || code === 'host_not_allowed' || code === 'scheme_not_allowed' || code === 'port_not_allowed') {
        await removeSubscription(sub.id)
        return await settle(r, 'dead', code)
      }
      return await fail(r, sub.id, code, true)
    }
    if (status >= 200 && status < 300) {
      await settle(r, 'done', null)
      await recordSuccess(sub.id)
      pushStats.sent++
      return
    }
    // RFC 8030 §7.3: the subscription expired or was removed by the browser
    if (status === 404 || status === 410) {
      await removeSubscription(sub.id)
      return await settle(r, 'done', `HTTP ${status}: subscription removed`)
    }
    const retryable = status === 429 || status >= 500
    return await fail(r, sub.id, `HTTP ${status}`, retryable, retryAfter)
  } catch (err) {
    log(`[push] delivery ${r.id} failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    try {
      if (subId) await fail(r, subId, 'internal error', true)
      else if (r.attempts < PUSH_RETRY.maxAttempts) await retryLater(r, backoffMs(r.attempts, PUSH_RETRY), 'internal error')
      else await settle(r, 'dead', 'internal error')
    } catch {
      // the lease expires and another pass takes the row again
    }
  }
}

async function skip(r: Claimed, why: string): Promise<void> {
  pushStats.skipped++
  await settle(r, 'done', `skipped: ${why}`)
}

async function fail(r: Claimed, subId: string, error: string, retryable: boolean, retryAfterMs?: number): Promise<void> {
  pushStats.failed++
  await recordFailure(subId, error)
  if (retryable && r.attempts < PUSH_RETRY.maxAttempts) return retryLater(r, retryAfterMs ?? backoffMs(r.attempts, PUSH_RETRY), error)
  await settle(r, 'dead', error)
}

/** Admin status summary (docs/adr/2222-*): counts only. */
export async function pushSummary(): Promise<{ subscriptions: number; failing: number; lastFailureAt: string | null; pending: number; dead24h: number }> {
  const [s] = (await db.execute(sql`
    SELECT count(*)::int AS subscriptions, count(*) FILTER (WHERE failure_count > 0)::int AS failing,
           to_json(max(last_failure_at)) #>> '{}' AS "lastFailureAt"
      FROM push_subscriptions
  `)) as unknown as { subscriptions: number; failing: number; lastFailureAt: string | null }[]
  const [o] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
           count(*) FILTER (WHERE state = 'dead' AND finished_at > now() - interval '1 day')::int AS dead
      FROM outbox WHERE topic = 'push'
  `)) as unknown as { pending: number; dead: number }[]
  return {
    subscriptions: Number(s?.subscriptions ?? 0),
    failing: Number(s?.failing ?? 0),
    lastFailureAt: s?.lastFailureAt ?? null,
    pending: Number(o?.pending ?? 0),
    dead24h: Number(o?.dead ?? 0),
  }
}
