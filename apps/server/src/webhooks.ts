/**
 * Workspace webhooks — Slack / Discord notifications.
 *
 *  - URL policy: https only, exact host allowlist (hooks.slack.com → /services/,
 *    discord.com | discordapp.com → /api/webhooks/), validated when saved AND again on every
 *    delivery through safeFetch (allowedHosts + allowedPathPrefixes, no redirects).
 *  - Privacy: events are re-resolved at delivery time; anything on a page that is not
 *    scope='shared' (or is deleted / moved out of the workspace) is dropped. Messages contain a
 *    short summary + link, never page bodies.
 *  - Delivery: one outbox row per (event, hook) (docs/adr/1081-*): survives a restart, leased while
 *    the HTTP call is in flight (at-least-once; `X-Inkling-Delivery` carries a stable id), dedupe key
 *    per event so a re-emitted comment/mention/page_created is a no-op, per-workspace token bucket,
 *    retries with capped exponential backoff (Retry-After honoured), auto-disable after N
 *    consecutive failed events + owner notification.
 *  - Test mode: WEBHOOK_TEST_ALLOW_LOOPBACK=1 (ignored when NODE_ENV=production) additionally
 *    accepts http://127.0.0.1:<port>/… so smoke tests can use a local fake receiver.
 *
 * See docs/adr/0504-workspace-webhooks.md.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { WebhookDTO, WebhookEvent, WebhookKind } from '@inkling/shared'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import { broadcastToUser } from './collab'
import { db } from './db/index'
import { comments, notifications, pages, users, workspaceMembers, workspaceWebhooks } from './db/schema'
import { env } from './env'
import { kickOutbox, OUTBOX_ORIGIN, ownedOrOrphaned, registerOutboxHandler, wakeAt } from './outbox'
import type { Exec, RetryPolicy } from './outbox'
import { safeFetch, SafeFetchError } from './safeFetch'
import { liveWorkspace } from './workspaceLive'

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const PROVIDERS: Record<WebhookKind, { hosts: string[]; prefix: string; pathRe: RegExp }> = {
  slack: { hosts: ['hooks.slack.com'], prefix: '/services/', pathRe: /^\/services\/[A-Za-z0-9]{1,32}\/[A-Za-z0-9]{1,32}\/[A-Za-z0-9]{1,64}$/ },
  discord: {
    hosts: ['discord.com', 'discordapp.com'],
    prefix: '/api/webhooks/',
    pathRe: /^\/api\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,100}$/,
  },
}

export const MAX_WEBHOOKS_PER_WORKSPACE = 10
/** Consecutive failed events before a hook is disabled automatically. */
export const AUTO_DISABLE_AFTER = 5
/** 1 try + 3 retries after 2 s, 10 s, 50 s (cap 60 s), like the in-memory queue before. */
export const WEBHOOK_RETRY: RetryPolicy = { baseMs: 2_000, factor: 5, capMs: 60_000, maxAttempts: 4 }
const PAGE_CREATED_DELAY_MS = 20_000
const BUCKET_CAPACITY = 20
const BUCKET_REFILL_PER_SEC = 20 / 60
/** Pending deliveries per workspace; beyond this new events are dropped (flood guard). */
const QUEUE_MAX_PER_WS = 200
const MAX_CONCURRENCY = 4
/** A claimed delivery is retried by any consumer after this (crash during the HTTP call). */
export const WEBHOOK_LEASE_MS = 30_000

export function webhookTestMode(): boolean {
  return process.env.WEBHOOK_TEST_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV !== 'production'
}

function isLoopbackTestUrl(u: URL): boolean {
  return webhookTestMode() && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]')
}

export class WebhookUrlError extends Error {}

/** Validate a user-supplied webhook URL. Returns the canonical URL and the provider kind. */
export function parseWebhookUrl(raw: string, kindHint?: WebhookKind): { url: string; kind: WebhookKind } {
  if (typeof raw !== 'string' || raw.length > 512) throw new WebhookUrlError('Invalid webhook URL')
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new WebhookUrlError('Invalid webhook URL')
  }
  if (isLoopbackTestUrl(u)) return { url: u.href, kind: kindHint ?? 'slack' }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new WebhookUrlError('Webhook URL must be an https Slack or Discord incoming-webhook URL')
  }
  if (u.search || u.hash) throw new WebhookUrlError('Webhook URL must not contain a query or fragment')
  const host = u.hostname.toLowerCase()
  for (const [kind, p] of Object.entries(PROVIDERS) as [WebhookKind, (typeof PROVIDERS)[WebhookKind]][]) {
    if (p.hosts.includes(host)) {
      if (!p.pathRe.test(u.pathname)) throw new WebhookUrlError(`Not a valid ${kind === 'slack' ? 'Slack' : 'Discord'} webhook URL`)
      return { url: `https://${host}${u.pathname}`, kind }
    }
  }
  throw new WebhookUrlError('Only Slack (hooks.slack.com) and Discord (discord.com/api/webhooks) URLs are allowed')
}

/** Mask the secret part of a webhook URL for display. */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    if (u.hostname === 'hooks.slack.com') return `https://hooks.slack.com/services/${parts[1] ?? ''}/••••`
    if (parts[0] === 'api' && parts[1] === 'webhooks') return `https://${u.hostname}/api/webhooks/${parts[2] ?? ''}/••••`
    return `${u.protocol}//${u.host}/••••`
  } catch {
    return '••••'
  }
}

type HookRow = typeof workspaceWebhooks.$inferSelect

export function toWebhookDTO(r: HookRow): WebhookDTO {
  const events = Array.isArray(r.events) ? (r.events as string[]).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as string[]).includes(e)) : []
  return {
    id: r.id,
    kind: r.kind,
    urlMasked: maskWebhookUrl(r.url),
    events,
    enabled: r.enabled === '1',
    autoDisabledAt: r.autoDisabledAt ? r.autoDisabledAt.toISOString() : null,
    failureCount: r.failureCount,
    lastError: r.lastError,
    lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Events → messages
// ---------------------------------------------------------------------------

export interface WebhookEventInput {
  type: WebhookEvent
  workspaceId: string
  pageId: string
  actorId?: string | null
  commentId?: string | null
  /** For 'mention': the mentioned user ids. */
  mentionedUserIds?: string[]
  /** For 'review_due' / 'agent_digest': every page in the digest (pageId is the first one). docs/adr/0952-* */
  pageIds?: string[]
  /** For 'assigned': the person field's name, or 'owner' (docs/adr/1000-*). */
  field?: string | null
  /** OAuth client name when an agent caused the event; shown as "Alice via X". */
  via?: string | null
  /** Idempotency key of the event (default: derived for comment / mention / page_created). */
  key?: string
}

interface Message {
  /** Plain one-line summary (no markup). */
  summary: string
  /** Optional quoted excerpt (plain). */
  excerpt: string | null
  link: string | null
  title: string
}

function appOrigin(): string | null {
  return env.appUrl ?? env.publicUrl ?? null
}

function plainExcerpt(body: string, max = 140): string {
  // Comment bodies are plain text with optional markdown-ish links; flatten and cap.
  const t = body
    .slice(0, 2000)
    .replace(/\[([^\]\n]{0,200})\]\([^)\s]{0,500}\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * Re-resolve an event at delivery time. Returns null when it must not be sent:
 * page missing/deleted/private/moved, comment deleted, …  This is the single privacy gate.
 */
async function buildMessage(ev: WebhookEventInput, hookWorkspaceId: string): Promise<Message | null> {
  if (ev.type === 'review_due') return buildReviewDigest(ev, hookWorkspaceId)
  if (ev.type === 'agent_digest') return buildAgentDigest(ev, hookWorkspaceId)
  const page = (
    await db
      .select({ id: pages.id, title: pages.title, scope: pages.scope, workspaceId: pages.workspaceId, deletedAt: pages.deletedAt })
      .from(pages)
      .where(eq(pages.id, ev.pageId))
      .limit(1)
  )[0]
  if (!page || page.deletedAt || page.scope !== 'shared') return null
  if (page.workspaceId !== hookWorkspaceId || page.workspaceId !== ev.workspaceId) return null

  const ids = [ev.actorId, ...(ev.mentionedUserIds ?? [])].filter((x): x is string => !!x)
  const names = new Map<string, string>()
  if (ids.length > 0) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(ids)].slice(0, 50)))
    for (const r of rows) names.set(r.id, r.name)
  }
  const actorName = (ev.actorId && names.get(ev.actorId)) || 'Someone'
  const actor = ev.via ? `${actorName} via ${plainExcerpt(ev.via, 60)}` : actorName
  const title = page.title.trim() || 'Untitled'
  const origin = appOrigin()
  const link = origin ? `${origin}/w/${page.workspaceId}/p/${page.id}` : null

  let excerpt: string | null = null
  if ((ev.type === 'comment' || ev.type === 'mention') && ev.commentId) {
    const c = (await db.select({ body: comments.body, pageId: comments.pageId }).from(comments).where(eq(comments.id, ev.commentId)).limit(1))[0]
    if (!c || c.pageId !== page.id) return null
    excerpt = plainExcerpt(c.body) || null
  }

  let summary: string
  switch (ev.type) {
    case 'comment':
      summary = `${actor} commented on "${title}"`
      break
    case 'mention': {
      const who = (ev.mentionedUserIds ?? []).map((id) => names.get(id)).filter(Boolean).slice(0, 5)
      summary = who.length > 0 ? `${actor} mentioned ${who.join(', ')} in "${title}"` : `${actor} mentioned someone in "${title}"`
      break
    }
    case 'reminder':
      summary = `Due today: "${title}"`
      break
    case 'page_created':
      summary = `${actor} created "${title}"`
      break
    case 'assigned': {
      const who = (ev.mentionedUserIds ?? []).map((id) => names.get(id)).filter(Boolean).slice(0, 5)
      const what = ev.field ? ` (${plainExcerpt(ev.field, 60)})` : ''
      summary = who.length > 0 ? `${actor} assigned ${who.join(', ')} to "${title}"${what}` : `${actor} assigned someone to "${title}"${what}`
      break
    }
    default:
      return null
  }
  return { summary, excerpt, link, title }
}

const DIGEST_LISTED = 8

/**
 * The daily review digest (docs/adr/0952-*). Same privacy gate as single-page events, applied to
 * each page at delivery: only live, shared, non-template pages of this workspace are named.
 */
async function buildReviewDigest(ev: WebhookEventInput, hookWorkspaceId: string): Promise<Message | null> {
  if (ev.workspaceId !== hookWorkspaceId) return null
  const ids = [...new Set(ev.pageIds ?? [ev.pageId])].slice(0, 100)
  if (ids.length === 0) return null
  const rows = await db
    .select({ id: pages.id, title: pages.title, ownerName: users.name })
    .from(pages)
    .leftJoin(users, eq(users.id, pages.ownerId))
    .where(
      and(
        inArray(pages.id, ids),
        eq(pages.workspaceId, hookWorkspaceId),
        sql`${pages.deletedAt} is null`,
        eq(pages.scope, 'shared'),
      ),
    )
  if (rows.length === 0) return null
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const listed = rows
    .slice(0, DIGEST_LISTED)
    .map((r) => `${r.title.trim() || 'Untitled'}${r.ownerName ? ` (${r.ownerName})` : ''}`)
  const more = rows.length - listed.length
  const origin = appOrigin()
  return {
    summary: `${rows.length} document${rows.length === 1 ? ' is' : 's are'} due for review`,
    excerpt: plainExcerpt(listed.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), 600),
    link: origin ? `${origin}/w/${hookWorkspaceId}/workspace-settings?tab=review` : null,
    title: 'Review due',
  }
}

/** The daily AI-edit digest (docs/adr/1004-*): same per-page privacy gate as the review digest. */
async function buildAgentDigest(ev: WebhookEventInput, hookWorkspaceId: string): Promise<Message | null> {
  if (ev.workspaceId !== hookWorkspaceId) return null
  const ids = [...new Set(ev.pageIds ?? [ev.pageId])].slice(0, 100)
  if (ids.length === 0) return null
  const rows = await db
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(
      and(
        inArray(pages.id, ids),
        eq(pages.workspaceId, hookWorkspaceId),
        sql`${pages.deletedAt} is null`,
        eq(pages.scope, 'shared'),
      ),
    )
  if (rows.length === 0) return null
  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const listed = rows.slice(0, DIGEST_LISTED).map((r) => r.title.trim() || 'Untitled')
  const more = rows.length - listed.length
  const origin = appOrigin()
  return {
    summary: `AI connections edited ${rows.length} page${rows.length === 1 ? '' : 's'} in the last day`,
    excerpt: plainExcerpt(listed.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), 600),
    link: origin ? `${origin}/w/${hookWorkspaceId}/activity?actor=ai` : null,
    title: 'AI activity',
  }
}

function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function discordEscape(s: string): string {
  // Neutralise markdown and mass mentions; allowed_mentions also blocks pings server-side.
  return s.replace(/([\\*_~`|>[\]()#:-])/g, '\\$1').replace(/@/g, '@\u200b')
}

export function formatPayload(kind: WebhookKind, m: Message): string {
  if (kind === 'slack') {
    const lines = [slackEscape(m.summary)]
    if (m.excerpt) lines.push(`> ${slackEscape(m.excerpt)}`)
    if (m.link) lines.push(`<${m.link}|Open in Inkling>`)
    return JSON.stringify({ text: lines.join('\n'), unfurl_links: false, unfurl_media: false })
  }
  const lines = [discordEscape(m.summary)]
  if (m.excerpt) lines.push(`> ${discordEscape(m.excerpt)}`)
  if (m.link) lines.push(`<${m.link}>`)
  return JSON.stringify({ content: lines.join('\n').slice(0, 1900), allowed_mentions: { parse: [] } })
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryResult =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string }

export async function deliver(hook: Pick<HookRow, 'kind' | 'url'>, body: string, deliveryId?: string): Promise<DeliveryResult> {
  const p = PROVIDERS[hook.kind]
  let u: URL
  try {
    u = new URL(hook.url)
  } catch {
    return { ok: false, retryable: false, error: 'invalid URL' }
  }
  const loop = isLoopbackTestUrl(u)
  try {
    const res = await safeFetch(hook.url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...(deliveryId ? { 'x-inkling-delivery': deliveryId } : {}) },
      ...(loop ? { unsafeAllowLoopbackForTests: true } : { allowedHosts: p.hosts, allowedPathPrefixes: [p.prefix] }),
      maxRedirects: 0,
      maxBytes: 16 * 1024,
      truncate: true,
      timeoutMs: 8000,
    })
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
    if (res.status === 429) {
      const ra = Number(res.headers['retry-after'])
      return { ok: false, retryable: true, retryAfterMs: Number.isFinite(ra) ? Math.min(ra * 1000, 60_000) : undefined, error: 'HTTP 429' }
    }
    return { ok: false, retryable: res.status >= 500, error: `HTTP ${res.status}` }
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network'
    const retryable = code === 'timeout' || code === 'network' || code === 'dns_failed'
    return { ok: false, retryable, error: code }
  }
}

interface WebhookJob {
  hookId: string
  event: WebhookEventInput
}

interface ClaimedRow {
  id: string
  workspaceId: string
  payload: WebhookJob
  attempts: number
}

const buckets = new Map<string, { tokens: number; at: number }>()
let inflight = 0
let log: (msg: string) => void = () => {}

function takeToken(ws: string): number {
  const now = Date.now()
  const b = buckets.get(ws) ?? { tokens: BUCKET_CAPACITY, at: now }
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + ((now - b.at) / 1000) * BUCKET_REFILL_PER_SEC)
  b.at = now
  buckets.set(ws, b)
  if (b.tokens >= 1) {
    b.tokens -= 1
    return 0
  }
  return Math.ceil(((1 - b.tokens) / BUCKET_REFILL_PER_SEC) * 1000)
}

/**
 * One consumer pass: lease up to the free concurrency slots of due rows (SKIP LOCKED, so several
 * consumers take disjoint rows; an expired lease is taken again) and start their deliveries.
 */
export async function runWebhookPass(): Promise<number> {
  const free = MAX_CONCURRENCY - inflight
  if (free <= 0) return 0
  const rows = (await db.execute(sql`
    UPDATE outbox SET locked_until = now() + make_interval(secs => ${WEBHOOK_LEASE_MS / 1000}), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
        WHERE topic = 'webhook' AND state = 'pending' AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now()) AND ${ownedOrOrphaned()}
        ORDER BY id LIMIT ${free}
          FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id, workspace_id AS "workspaceId", payload, attempts
  `)) as unknown as ClaimedRow[]
  for (const r of rows) {
    inflight++
    void runJob(r).finally(() => {
      inflight--
      kickOutbox('webhook')
    })
  }
  if (rows.length === 0) await armNextWake()
  return rows.length
}

registerOutboxHandler('webhook', runWebhookPass, MAX_CONCURRENCY)

/** Wake up when the next delayed / backed-off / leased row becomes due (capped at 30 s). */
async function armNextWake(): Promise<void> {
  const [r] = (await db.execute(sql`
    SELECT (extract(epoch from min(greatest(available_at, coalesce(locked_until, available_at))) - now()) * 1000)::float8 AS ms
      FROM outbox WHERE topic = 'webhook' AND state = 'pending'
  `)) as unknown as { ms: number | null }[]
  if (r?.ms !== null && r?.ms !== undefined) wakeAt('webhook', Math.min(30_000, Math.max(0, Number(r.ms)) + 5))
}

/** Finish a leased row, unless another consumer took it over (lease expired: attempts moved on). */
async function settle(r: ClaimedRow, state: 'done' | 'dead', error: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE outbox SET state = ${state}, finished_at = now(), locked_until = NULL, last_error = ${error?.slice(0, 300) ?? null}
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}
  `)
}

async function retryLater(r: ClaimedRow, delayMs: number, error: string, countAttempt = true): Promise<void> {
  await db.execute(sql`
    UPDATE outbox SET locked_until = NULL, last_error = ${error.slice(0, 300)},
           attempts = ${countAttempt ? r.attempts : r.attempts - 1},
           available_at = now() + make_interval(secs => ${delayMs / 1000})
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}
  `)
  wakeAt('webhook', delayMs)
}

/** Fault injection for the crash tests: runs after the HTTP call, before the row is finished. */
export const webhookTestHooks: { afterSend?: (r: { id: string; attempts: number }) => void | Promise<void> } = {}

async function runJob(r: ClaimedRow): Promise<void> {
  const job = r.payload
  try {
    // A job queued before its workspace was soft-deleted is dropped here (ADR 0910).
    const hook = (
      await db
        .select()
        .from(workspaceWebhooks)
        .where(and(eq(workspaceWebhooks.id, job.hookId), liveWorkspace(workspaceWebhooks.workspaceId)))
        .limit(1)
    )[0]
    if (!hook || hook.enabled !== '1' || hook.workspaceId !== r.workspaceId) return await settle(r, 'done', 'skipped: hook gone or disabled')
    const msg = await buildMessage(job.event, hook.workspaceId)
    if (!msg) return await settle(r, 'done', 'skipped: not deliverable')
    const wait = takeToken(hook.workspaceId)
    if (wait > 0) return await retryLater(r, wait, 'rate limited', false)
    const result = await deliver(hook, formatPayload(hook.kind, msg), r.id)
    await webhookTestHooks.afterSend?.({ id: r.id, attempts: r.attempts })
    if (result.ok) {
      await settle(r, 'done', null)
      await recordSuccess(hook.id)
      return
    }
    if (result.retryable && r.attempts < WEBHOOK_RETRY.maxAttempts) {
      await retryLater(r, result.retryAfterMs ?? backoff(r.attempts), result.error)
      return
    }
    await settle(r, 'dead', result.error)
    await recordFailure(hook, result.error)
  } catch (err) {
    log(`[webhooks] job failed: ${String(err)}`)
    try {
      if (r.attempts < WEBHOOK_RETRY.maxAttempts) await retryLater(r, backoff(r.attempts), String(err))
      else await settle(r, 'dead', String(err))
    } catch {
      // the lease expires and another pass retries it
    }
  } finally {
    // Drop idle workspaces' buckets so the map stays bounded (ADR 0752 inv.).
    const b = buckets.get(r.workspaceId)
    if (b && b.tokens >= BUCKET_CAPACITY - 1) buckets.delete(r.workspaceId)
  }
}

function backoff(attempts: number): number {
  return Math.min(WEBHOOK_RETRY.capMs, WEBHOOK_RETRY.baseMs * Math.pow(WEBHOOK_RETRY.factor, Math.max(0, attempts - 1)))
}

async function recordSuccess(hookId: string): Promise<void> {
  await db
    .update(workspaceWebhooks)
    .set({ failureCount: 0, lastError: null, lastSuccessAt: new Date() })
    .where(eq(workspaceWebhooks.id, hookId))
}

async function recordFailure(hook: HookRow, error: string): Promise<void> {
  const [row] = await db
    .update(workspaceWebhooks)
    .set({ failureCount: sql`${workspaceWebhooks.failureCount} + 1`, lastError: error.slice(0, 200) })
    .where(eq(workspaceWebhooks.id, hook.id))
    .returning({ failureCount: workspaceWebhooks.failureCount, enabled: workspaceWebhooks.enabled })
  if (!row || row.enabled !== '1' || row.failureCount < AUTO_DISABLE_AFTER) return
  const disabled = await db
    .update(workspaceWebhooks)
    .set({ enabled: '0', autoDisabledAt: new Date() })
    .where(and(eq(workspaceWebhooks.id, hook.id), eq(workspaceWebhooks.enabled, '1')))
    .returning({ id: workspaceWebhooks.id })
  if (disabled.length === 0) return
  invalidateWebhookCache(hook.workspaceId)
  log(`[webhooks] hook ${hook.id} disabled after ${row.failureCount} consecutive failures`)
  const owners = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, hook.workspaceId), eq(workspaceMembers.role, 'owner')))
  if (owners.length === 0) return
  await db.insert(notifications).values(
    owners.map((o) => ({ userId: o.userId, type: 'webhook_disabled' as const, workspaceId: hook.workspaceId, actorId: null })),
  )
  for (const o of owners) broadcastToUser(o.userId, { t: 'notifications' })
}

// ---------------------------------------------------------------------------
// Emission (called from comment / reminder / page routes)
// ---------------------------------------------------------------------------

type CachedHooks = { at: number; hooks: { id: string; events: string[] }[] }
const hookCache = new Map<string, CachedHooks>()
const HOOK_CACHE_TTL_MS = 60_000

export function invalidateWebhookCache(workspaceId: string): void {
  hookCache.delete(workspaceId)
}

async function enabledHooks(workspaceId: string): Promise<CachedHooks['hooks']> {
  const hit = hookCache.get(workspaceId)
  if (hit && Date.now() - hit.at < HOOK_CACHE_TTL_MS) return hit.hooks
  const rows = await db
    .select({ id: workspaceWebhooks.id, events: workspaceWebhooks.events })
    .from(workspaceWebhooks)
    .where(
      and(
        eq(workspaceWebhooks.workspaceId, workspaceId),
        eq(workspaceWebhooks.enabled, '1'),
        // nothing is sent for a soft-deleted workspace (ADR 0910); the cache is invalidated on delete/restore
        liveWorkspace(workspaceWebhooks.workspaceId),
      ),
    )
  const hooks = rows.map((r) => ({ id: r.id, events: Array.isArray(r.events) ? (r.events as string[]) : [] }))
  hookCache.set(workspaceId, { at: Date.now(), hooks })
  if (hookCache.size > 10_000) hookCache.delete(hookCache.keys().next().value as string)
  return hooks
}

/** Whether the workspace has an enabled hook subscribed to `event` (cached like delivery). */
export async function hasEnabledHook(workspaceId: string, event: WebhookEvent): Promise<boolean> {
  return (await enabledHooks(workspaceId)).some((h) => h.events.includes(event))
}

/** Natural idempotency key of an event, when it has one. */
function eventKey(ev: WebhookEventInput): string | null {
  if (ev.key) return ev.key
  switch (ev.type) {
    case 'comment':
      return ev.commentId ? `comment:${ev.commentId}` : null
    case 'mention':
      return ev.commentId ? `mention:${ev.commentId}` : null
    case 'page_created':
      return `page_created:${ev.pageId}`
    default:
      return null
  }
}

/**
 * Queue an event for every enabled hook of the workspace subscribed to it, with `exec` (the
 * producer's transaction, or `db`). Returns the number of deliveries queued. Privacy filtering
 * happens at delivery.
 */
export async function enqueueWebhookEvent(exec: Exec, ev: WebhookEventInput): Promise<number> {
  const hooks = (await enabledHooks(ev.workspaceId)).filter((h) => h.events.includes(ev.type))
  if (hooks.length === 0) return 0
  const key = eventKey(ev) ?? randomUUID()
  const delay = ev.type === 'page_created' ? PAGE_CREATED_DELAY_MS : 0
  const rows = hooks.map((h) => ({ k: `wh:${key}:${h.id}`, p: { hookId: h.id, event: ev } satisfies WebhookJob }))
  const out = (await exec.execute(sql`
    WITH cap AS (
      SELECT count(*) AS n FROM outbox WHERE topic = 'webhook' AND state = 'pending' AND workspace_id = ${ev.workspaceId}
    ), ins AS (
      INSERT INTO outbox (topic, origin, dedupe_key, workspace_id, payload, available_at)
      SELECT 'webhook', ${OUTBOX_ORIGIN}, x.k, ${ev.workspaceId}, x.p, now() + make_interval(secs => ${delay / 1000})
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(k text, p jsonb), cap
       WHERE cap.n < ${QUEUE_MAX_PER_WS}
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    )
    SELECT (SELECT n FROM cap)::int AS pending, (SELECT count(*) FROM ins)::int AS n,
           (SELECT pg_notify('inkling_outbox', ${`webhook:${OUTBOX_ORIGIN}`}) FROM ins LIMIT 1) AS z
  `)) as unknown as { pending: number; n: number }[]
  const n = Number(out[0]?.n ?? 0)
  if (Number(out[0]?.pending ?? 0) >= QUEUE_MAX_PER_WS) log(`[webhooks] queue full, dropping ${ev.type} for workspace ${ev.workspaceId}`)
  if (n > 0 && exec === db) {
    if (delay > 0) wakeAt('webhook', delay)
    else kickOutbox('webhook')
  }
  return n
}

const emitting = new Set<Promise<unknown>>()

/**
 * Fire-and-forget: queue an event for every enabled hook of the workspace subscribed to it.
 * Never throws and never blocks the caller's request.
 */
export function emitWebhookEvent(ev: WebhookEventInput): void {
  const p = enqueueWebhookEvent(db, ev).catch((err) => log(`[webhooks] emit failed: ${String(err)}`))
  emitting.add(p)
  void p.finally(() => emitting.delete(p))
}

/** Wait for in-flight emits (tests). */
export async function flushWebhookEmits(): Promise<void> {
  while (emitting.size) await Promise.allSettled([...emitting])
}

/** Send a fixed test message right away (bypasses the queue, still rate-limited per workspace). */
export async function sendTestMessage(hook: HookRow, workspaceName: string): Promise<DeliveryResult> {
  const wait = takeToken(hook.workspaceId)
  if (wait > 0) return { ok: false, retryable: true, retryAfterMs: wait, error: 'rate_limited' }
  const origin = appOrigin()
  const msg: Message = {
    summary: `Test message from Inkling workspace "${workspaceName}". Webhook notifications are working.`,
    excerpt: null,
    link: origin ? `${origin}/w/${hook.workspaceId}` : null,
    title: workspaceName,
  }
  const result = await deliver(hook, formatPayload(hook.kind, msg))
  if (result.ok) await recordSuccess(hook.id)
  else await db.update(workspaceWebhooks).set({ lastError: result.error.slice(0, 200) }).where(eq(workspaceWebhooks.id, hook.id))
  return result
}

export function initWebhooks(logger: (msg: string) => void): void {
  log = logger
}

/** Exposed for tests/diagnostics: deliveries in flight in this process. */
export function _queueSize(): number {
  return inflight
}

