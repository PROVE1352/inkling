/**
 * Workspace webhooks — Slack / Discord notifications.
 *
 *  - URL policy: https only, exact host allowlist (hooks.slack.com → /services/,
 *    discord.com | discordapp.com → /api/webhooks/), validated when saved AND again on every
 *    delivery through safeFetch (allowedHosts + allowedPathPrefixes, no redirects).
 *  - Privacy: events are re-resolved at delivery time; anything on a page that is not
 *    scope='shared' (or is deleted / moved out of the workspace) is dropped. Messages contain a
 *    short summary + link, never page bodies.
 *  - Delivery: in-memory queue, per-workspace token bucket, retries with exponential backoff
 *    (Retry-After honoured), auto-disable after N consecutive failed events + owner notification.
 *  - Test mode: WEBHOOK_TEST_ALLOW_LOOPBACK=1 (ignored when NODE_ENV=production) additionally
 *    accepts http://127.0.0.1:<port>/… so smoke tests can use a local fake receiver.
 *
 * See docs/adr/0504-workspace-webhooks.md.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { WebhookDTO, WebhookEvent, WebhookKind } from '@inkling/shared'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import { broadcastToUser } from './collab'
import { db } from './db/index'
import { comments, notifications, pages, users, workspaceMembers, workspaceWebhooks } from './db/schema'
import { env } from './env'
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
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000]
const PAGE_CREATED_DELAY_MS = 20_000
const BUCKET_CAPACITY = 20
const BUCKET_REFILL_PER_SEC = 20 / 60
const QUEUE_MAX_PER_WS = 200
const QUEUE_MAX_TOTAL = 5000
const MAX_CONCURRENCY = 4

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
  const page = (
    await db
      .select({ id: pages.id, title: pages.title, scope: pages.scope, workspaceId: pages.workspaceId, deletedAt: pages.deletedAt, isTemplate: pages.isTemplate })
      .from(pages)
      .where(eq(pages.id, ev.pageId))
      .limit(1)
  )[0]
  if (!page || page.deletedAt || page.scope !== 'shared' || page.isTemplate === '1') return null
  if (page.workspaceId !== hookWorkspaceId || page.workspaceId !== ev.workspaceId) return null

  const ids = [ev.actorId, ...(ev.mentionedUserIds ?? [])].filter((x): x is string => !!x)
  const names = new Map<string, string>()
  if (ids.length > 0) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(ids)].slice(0, 50)))
    for (const r of rows) names.set(r.id, r.name)
  }
  const actor = (ev.actorId && names.get(ev.actorId)) || 'Someone'
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
  }
  return { summary, excerpt, link, title }
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

export async function deliver(hook: Pick<HookRow, 'kind' | 'url'>, body: string): Promise<DeliveryResult> {
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
      headers: { 'content-type': 'application/json' },
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

interface Job {
  hookId: string
  workspaceId: string
  event: WebhookEventInput
  attempt: number
  notBefore: number
}

const queue: Job[] = []
const perWs = new Map<string, number>()
const buckets = new Map<string, { tokens: number; at: number }>()
let running = 0
let timer: NodeJS.Timeout | null = null
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

function push(job: Job): void {
  const n = perWs.get(job.workspaceId) ?? 0
  if (n >= QUEUE_MAX_PER_WS || queue.length >= QUEUE_MAX_TOTAL) {
    log(`[webhooks] queue full, dropping ${job.event.type} for workspace ${job.workspaceId}`)
    return
  }
  perWs.set(job.workspaceId, n + 1)
  queue.push(job)
  schedule()
}

let timerAt = 0

/** (Re)arm the single wake-up timer for the earliest due job (capped at 30 s). */
function schedule(): void {
  // While all workers are busy, runJob's finally re-arms the timer; avoid a setTimeout(0) spin.
  if (queue.length === 0 || running >= MAX_CONCURRENCY) return
  let next = Infinity
  for (const j of queue) if (j.notBefore < next) next = j.notBefore
  const at = Math.min(next, Date.now() + 30_000)
  if (timer && timerAt <= at) return
  if (timer) clearTimeout(timer)
  timerAt = at
  timer = setTimeout(() => {
    timer = null
    void pump()
  }, Math.max(0, at - Date.now()))
  timer.unref?.()
}

async function pump(): Promise<void> {
  const now = Date.now()
  while (running < MAX_CONCURRENCY) {
    const idx = queue.findIndex((j) => j.notBefore <= now)
    if (idx < 0) break
    const job = queue[idx]
    const wait = takeToken(job.workspaceId)
    if (wait > 0) {
      job.notBefore = now + wait
      continue
    }
    queue.splice(idx, 1)
    const left = (perWs.get(job.workspaceId) ?? 1) - 1
    // Drop idle workspaces so the maps stay bounded by workspaces with queued jobs (ADR 0752 inv.).
    if (left > 0) perWs.set(job.workspaceId, left)
    else {
      perWs.delete(job.workspaceId)
      const b = buckets.get(job.workspaceId)
      if (b && b.tokens >= BUCKET_CAPACITY - 1) buckets.delete(job.workspaceId)
    }
    running++
    void runJob(job).finally(() => {
      running--
      schedule()
      if (queue.some((j) => j.notBefore <= Date.now())) void pump()
    })
  }
  schedule()
}

async function runJob(job: Job): Promise<void> {
  try {
    // A job queued before its workspace was soft-deleted is dropped here (ADR 0910).
    const hook = (
      await db
        .select()
        .from(workspaceWebhooks)
        .where(and(eq(workspaceWebhooks.id, job.hookId), liveWorkspace(workspaceWebhooks.workspaceId)))
        .limit(1)
    )[0]
    if (!hook || hook.enabled !== '1' || hook.workspaceId !== job.workspaceId) return
    const msg = await buildMessage(job.event, hook.workspaceId)
    if (!msg) return
    const result = await deliver(hook, formatPayload(hook.kind, msg))
    if (result.ok) {
      await recordSuccess(hook.id)
      return
    }
    if (result.retryable && job.attempt < RETRY_DELAYS_MS.length) {
      const delay = result.retryAfterMs ?? RETRY_DELAYS_MS[job.attempt]
      push({ ...job, attempt: job.attempt + 1, notBefore: Date.now() + delay })
      return
    }
    await recordFailure(hook, result.error)
  } catch (err) {
    log(`[webhooks] job failed: ${String(err)}`)
  }
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

/**
 * Fire-and-forget: queue an event for every enabled hook of the workspace subscribed to it.
 * Never throws and never blocks the caller's request. Privacy filtering happens at delivery.
 */
export function emitWebhookEvent(ev: WebhookEventInput): void {
  void (async () => {
    try {
      const hooks = await enabledHooks(ev.workspaceId)
      if (hooks.length === 0) return
      const delay = ev.type === 'page_created' ? PAGE_CREATED_DELAY_MS : 0
      for (const h of hooks) {
        if (!h.events.includes(ev.type)) continue
        push({ hookId: h.id, workspaceId: ev.workspaceId, event: ev, attempt: 0, notBefore: Date.now() + delay })
      }
    } catch (err) {
      log(`[webhooks] emit failed: ${String(err)}`)
    }
  })()
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

/** Exposed for tests/diagnostics. */
export function _queueSize(): number {
  return queue.length
}

