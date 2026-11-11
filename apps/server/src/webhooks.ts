/**
 * Workspace webhooks — Slack / Discord notifications, and signed JSON events to any https endpoint
 * ('generic', docs/adr/1190-*, docs/WEBHOOKS.md).
 *
 *  - URL policy: https only. Slack / Discord: exact host allowlist (hooks.slack.com → /services/,
 *    discord.com | discordapp.com → /api/webhooks/), validated when saved AND again on every
 *    delivery through safeFetch (allowedHosts + allowedPathPrefixes, no redirects). Generic: any
 *    host on port 443 whose every DNS answer is public (safeFetch: checked when saved and on every
 *    delivery, connection pinned to the checked address), no redirects, 8 s deadline, 16 KiB read.
 *  - Generic deliveries are signed (`X-Inkling-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over
 *    `t + "." + body` with the hook's secret, sealed at rest like the URL) and carry
 *    `X-Inkling-Event`. Every attempt updates one `webhook_deliveries` row (docs/adr/1191-*) in the
 *    statement that finishes or reschedules the outbox row.
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
import { isFeatureDisabled } from './limits'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { WebhookDeliveryDTO, WebhookDTO, WebhookEvent, WebhookKind, WebhookPayloadV1 } from '@inkling/shared'
import { WEBHOOK_EVENTS } from '@inkling/shared'
import { broadcastToUser } from './collab'
import { db } from './db/index'
import { comments, notifications, pages, users, workspaceMembers, workspaces, workspaceWebhooks } from './db/schema'
import { env } from './env'
import { enqueue, kickOutbox, OUTBOX_ORIGIN, ownedOrOrphaned, registerOutboxHandler, wakeAt, WEBHOOK_QUEUE_MAX_PER_WS } from './outbox'
import type { Exec, OutboxRow, RetryPolicy } from './outbox'
import { resolvePublic, safeFetch, SafeFetchError, validateUrl } from './safeFetch'
import { protectSecret, revealSecret, SecretUnreadableError, tryRevealSecret } from './secretsAtRest'
import { liveWorkspace } from './workspaceLive'

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const PROVIDERS: Record<Exclude<WebhookKind, 'generic'>, { hosts: string[]; prefix: string; pathRe: RegExp }> = {
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
/** Generic hooks are disabled only once the failure streak is also this old (docs/adr/1192-*). */
export const GENERIC_DISABLE_AFTER_MS = 24 * 60 * 60 * 1000
/** How long the secret before a rotation keeps being signed with (unless revoked at once). */
export const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000
/** Delivery records kept per hook (docs/adr/1191-*); pruned every PRUNE_EVERY records. */
export const WEBHOOK_DELIVERY_KEEP = 100
const PRUNE_EVERY = 20
/** Payload version of generic deliveries (docs/WEBHOOKS.md). */
export const WEBHOOK_PAYLOAD_VERSION = 1
/** Pages listed in a generic digest payload. */
const GENERIC_DIGEST_LISTED = 50
/** Characters of a non-2xx response body kept in the delivery record. */
const RESPONSE_EXCERPT_MAX = 200
/** 1 try + 3 retries after 2 s, 10 s, 50 s (cap 60 s), like the in-memory queue before. */
export const WEBHOOK_RETRY: RetryPolicy = { baseMs: 2_000, factor: 5, capMs: 60_000, maxAttempts: 4 }
const PAGE_CREATED_DELAY_MS = 20_000
const BUCKET_CAPACITY = 20
const BUCKET_REFILL_PER_SEC = 20 / 60
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
  // A generic hook is chosen explicitly: a mistyped Slack URL must not turn into one.
  if (kindHint === 'generic') return { url: parseGenericUrl(u), kind: 'generic' }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    throw new WebhookUrlError('Webhook URL must be an https Slack or Discord incoming-webhook URL')
  }
  if (u.search || u.hash) throw new WebhookUrlError('Webhook URL must not contain a query or fragment')
  const host = u.hostname.toLowerCase()
  for (const [kind, p] of Object.entries(PROVIDERS) as [Exclude<WebhookKind, 'generic'>, (typeof PROVIDERS)['slack']][]) {
    if (p.hosts.includes(host)) {
      if (!p.pathRe.test(u.pathname)) throw new WebhookUrlError(`Not a valid ${kind === 'slack' ? 'Slack' : 'Discord'} webhook URL`)
      return { url: `https://${host}${u.pathname}`, kind }
    }
  }
  throw new WebhookUrlError('Only Slack (hooks.slack.com) and Discord (discord.com/api/webhooks) URLs are allowed')
}

/**
 * Generic endpoint (docs/adr/1190-*): https on port 443, no credentials, no fragment; a query string
 * is kept (some receivers put a routing key there). The synchronous safeFetch checks run here
 * (scheme, port, literal private addresses, localhost); `assertPublicWebhookHost` adds DNS.
 */
function parseGenericUrl(u: URL): string {
  if (u.protocol !== 'https:') throw new WebhookUrlError('Webhook URL must start with https://')
  if (u.username || u.password) throw new WebhookUrlError('Webhook URL must not contain a user name or password')
  if (u.port && u.port !== '443') throw new WebhookUrlError('Webhook URL must use the default https port (443)')
  if (u.hash) throw new WebhookUrlError('Webhook URL must not contain a fragment')
  try {
    validateUrl(u, { allowedPorts: [443] })
  } catch (e) {
    if (e instanceof SafeFetchError) throw new WebhookUrlError('Webhook URL must point to a public internet address')
    throw e
  }
  return u.href
}

/**
 * At save time: every DNS answer of a generic hook's host must be public, so an internal target is
 * refused now instead of failing every delivery. Delivery checks again (DNS can change).
 */
export async function assertPublicWebhookHost(url: string): Promise<void> {
  const u = new URL(url)
  if (isLoopbackTestUrl(u)) return
  try {
    await resolvePublic(u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase())
  } catch (e) {
    if (e instanceof SafeFetchError && e.code === 'dns_failed') throw new WebhookUrlError('The webhook host could not be resolved')
    if (e instanceof SafeFetchError) throw new WebhookUrlError('Webhook URL must point to a public internet address')
    throw e
  }
}

/** Mask the secret part of a webhook URL for display. */
export function maskWebhookUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    if (u.hostname === 'hooks.slack.com') return `https://hooks.slack.com/services/${parts[1] ?? ''}/••••`
    if (parts[0] === 'api' && parts[1] === 'webhooks') return `https://${u.hostname}/api/webhooks/${parts[2] ?? ''}/••••`
    // Generic: host plus a first path segment that looks like a route name ("webhook", "hooks"),
    // never the query or anything that may be a token.
    if (parts.length >= 2 && /^[A-Za-z_-]{1,24}$/.test(parts[0])) return `${u.protocol}//${u.host}/${parts[0]}/••••`
    return `${u.protocol}//${u.host}/••••`
  } catch {
    return '••••'
  }
}

type HookRow = typeof workspaceWebhooks.$inferSelect

/**
 * The hook's URL as stored → the real URL (docs/adr/1111-*). Sealed with APP_SECRET_KEY when the key
 * is set (row id as AAD); plaintext rows from a key-less install pass through. Throws
 * SecretUnreadableError when the key is missing or changed.
 */
export function hookUrl(h: Pick<HookRow, 'id' | 'url'>): string {
  return revealSecret('webhook-url', h.url, h.id)
}

/** Stored form of a new hook's URL. */
export function storeHookUrl(id: string, url: string): string {
  return protectSecret('webhook-url', url, id)
}

/** Masked URL for display and audit labels; '••••' when the stored URL cannot be decrypted. */
export function maskedHookUrl(h: Pick<HookRow, 'id' | 'url'>): string {
  const url = tryRevealSecret('webhook-url', h.url, h.id)
  return url ? maskWebhookUrl(url) : '••••'
}

/** lastError of a hook whose URL cannot be decrypted (shown in the webhooks panel). */
export const UNREADABLE_URL_ERROR = 'URL cannot be decrypted: APP_SECRET_KEY is missing or changed'
export const UNREADABLE_SECRET_ERROR = 'Signing secret cannot be decrypted: APP_SECRET_KEY is missing or changed'

/** A new signing secret: `whsec_` + 32 random bytes, base64url (no '.', never starts with `v1.`). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/** Stored form of a hook's signing secret (sealed like the URL, docs/adr/1111-*). */
export function storeHookSecret(id: string, secret: string): string {
  return protectSecret('webhook-secret', secret, id)
}

/**
 * The secrets a delivery is signed with: the current one, plus the one before the last rotation
 * while its grace period lasts. Throws SecretUnreadableError when a stored secret cannot be opened.
 */
export function signingSecrets(h: Pick<HookRow, 'id' | 'secret' | 'previousSecret' | 'previousSecretUntil'>, now = Date.now()): string[] {
  const out: string[] = []
  if (h.secret) out.push(revealSecret('webhook-secret', h.secret, h.id))
  if (h.previousSecret && h.previousSecretUntil && h.previousSecretUntil.getTime() > now) {
    out.push(revealSecret('webhook-secret', h.previousSecret, h.id))
  }
  return out
}

/** `X-Inkling-Signature` value: `t=<unix seconds>,v1=<hex>` with one `v1` per secret (Stripe's scheme). */
export function signatureHeader(secrets: string[], body: string, t: number): string {
  const sigs = secrets.map((k) => `v1=${createHmac('sha256', k).update(`${t}.${body}`, 'utf8').digest('hex')}`)
  return [`t=${t}`, ...sigs].join(',')
}

export function toWebhookDTO(r: HookRow): WebhookDTO {
  const events = Array.isArray(r.events) ? (r.events as string[]).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as string[]).includes(e)) : []
  return {
    id: r.id,
    kind: r.kind,
    urlMasked: maskedHookUrl(r),
    events,
    enabled: r.enabled === '1',
    autoDisabledAt: r.autoDisabledAt ? r.autoDisabledAt.toISOString() : null,
    failureCount: r.failureCount,
    lastError: r.lastError,
    lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    failingSince: r.failingSince ? r.failingSince.toISOString() : null,
    hasSecret: !!r.secret,
    previousSecretUntil:
      r.previousSecret && r.previousSecretUntil && r.previousSecretUntil.getTime() > Date.now() ? r.previousSecretUntil.toISOString() : null,
  }
}

// ---------------------------------------------------------------------------
// Events → messages
// ---------------------------------------------------------------------------

/**
 * 'automation' (docs/adr/2243-*) is not a subscription: a button or a database automation names the
 * hook, whatever its events.
 */
export interface WebhookEventInput {
  type: WebhookEvent | 'automation'
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
  /** For 'automation' (docs/adr/2243-*): the rule's or button's message (plain, capped). */
  message?: string | null
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

/**
 * An event re-resolved at delivery time: everything any format may show, nothing more. Built by
 * `resolveEvent`, the single privacy gate; `toMessage` (Slack / Discord) and `toGenericPayload`
 * (JSON) only choose from it.
 */
interface ResolvedEvent {
  type: WebhookEvent | 'automation'
  workspaceId: string
  actor: { id: string; name: string } | null
  /** OAuth client name when an agent caused the event (capped). */
  via: string | null
  page?: { id: string; title: string; url: string | null }
  comment?: { id: string; excerpt: string | null }
  users?: { id: string; name: string }[]
  field?: string | null
  message?: string | null
  /** Digests: the deliverable pages in event order, and the digest's link. */
  pages?: { id: string; title: string; url: string | null; owner: { id: string; name: string } | null }[]
  url?: string | null
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
 * page missing/deleted/private/moved, comment deleted, …  This is the single privacy gate, for
 * every hook kind.
 */
async function resolveEvent(ev: WebhookEventInput, hookWorkspaceId: string): Promise<ResolvedEvent | null> {
  if (ev.type === 'review_due' || ev.type === 'agent_digest') return resolveDigest(ev, hookWorkspaceId)
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
  const origin = appOrigin()
  const out: ResolvedEvent = {
    type: ev.type,
    workspaceId: page.workspaceId,
    actor: ev.actorId && names.has(ev.actorId) ? { id: ev.actorId, name: names.get(ev.actorId)! } : null,
    via: ev.via ? plainExcerpt(ev.via, 60) : null,
    page: { id: page.id, title: page.title.trim() || 'Untitled', url: origin ? `${origin}/w/${page.workspaceId}/p/${page.id}` : null },
  }
  if ((ev.type === 'comment' || ev.type === 'mention') && ev.commentId) {
    const c = (await db.select({ body: comments.body, pageId: comments.pageId }).from(comments).where(eq(comments.id, ev.commentId)).limit(1))[0]
    if (!c || c.pageId !== page.id) return null
    out.comment = { id: ev.commentId, excerpt: plainExcerpt(c.body) || null }
  }
  if (ev.type === 'mention' || ev.type === 'assigned') {
    out.users = (ev.mentionedUserIds ?? []).filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }))
  }
  if (ev.type === 'assigned') out.field = ev.field ? plainExcerpt(ev.field, 60) : null
  if (ev.type === 'automation') {
    out.field = ev.field ? plainExcerpt(ev.field, 80) : null
    out.message = ev.message ? plainExcerpt(ev.message, 500) : null
  }
  if (!['comment', 'mention', 'reminder', 'page_created', 'assigned', 'automation'].includes(ev.type)) return null
  return out
}

const DIGEST_LISTED = 8

/**
 * The daily review digest (docs/adr/0952-*) and AI-edit digest (docs/adr/1004-*). Same privacy gate
 * as single-page events, applied to each page at delivery: only live, shared pages of this
 * workspace are named.
 */
async function resolveDigest(ev: WebhookEventInput, hookWorkspaceId: string): Promise<ResolvedEvent | null> {
  if (ev.workspaceId !== hookWorkspaceId) return null
  const ids = [...new Set(ev.pageIds ?? [ev.pageId])].slice(0, 100)
  if (ids.length === 0) return null
  const rows = await db
    .select({ id: pages.id, title: pages.title, ownerId: pages.ownerId, ownerName: users.name })
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
  const origin = appOrigin()
  const review = ev.type === 'review_due'
  return {
    type: ev.type,
    workspaceId: hookWorkspaceId,
    actor: null,
    via: null,
    pages: rows.map((r) => ({
      id: r.id,
      title: r.title.trim() || 'Untitled',
      url: origin ? `${origin}/w/${hookWorkspaceId}/p/${r.id}` : null,
      // only the review digest names owners (as its Slack text always did)
      owner: review && r.ownerId && r.ownerName ? { id: r.ownerId, name: r.ownerName } : null,
    })),
    url: origin ? (review ? `${origin}/w/${hookWorkspaceId}/workspace-settings?tab=review` : `${origin}/w/${hookWorkspaceId}/activity?actor=ai`) : null,
  }
}

/** Slack / Discord text of a resolved event (unchanged wording since ADR 0504 / 0952 / 1004). */
function toMessage(e: ResolvedEvent): Message {
  if (e.pages) {
    const n = e.pages.length
    const listed = e.pages.slice(0, DIGEST_LISTED).map((p) => `${p.title}${p.owner ? ` (${p.owner.name})` : ''}`)
    const more = n - listed.length
    const excerpt = plainExcerpt(listed.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), 600)
    if (e.type === 'review_due') {
      return { summary: `${n} document${n === 1 ? ' is' : 's are'} due for review`, excerpt, link: e.url ?? null, title: 'Review due' }
    }
    return { summary: `AI connections edited ${n} page${n === 1 ? '' : 's'} in the last day`, excerpt, link: e.url ?? null, title: 'AI activity' }
  }
  const actorName = e.actor?.name || 'Someone'
  const actor = e.via ? `${actorName} via ${e.via}` : actorName
  const title = e.page!.title
  const who = (e.users ?? []).map((u) => u.name).filter(Boolean).slice(0, 5)
  let summary: string
  switch (e.type) {
    case 'comment':
      summary = `${actor} commented on "${title}"`
      break
    case 'mention':
      summary = who.length > 0 ? `${actor} mentioned ${who.join(', ')} in "${title}"` : `${actor} mentioned someone in "${title}"`
      break
    case 'reminder':
      summary = `Due today: "${title}"`
      break
    case 'page_created':
      summary = `${actor} created "${title}"`
      break
    case 'automation':
      // "via automation: X" already names the rule; a button names itself
      summary = e.via && e.field && e.via.endsWith(e.field) ? `${actor} on "${title}"` : `${actor} ran "${e.field ?? ''}" on "${title}"`
      return { summary, excerpt: e.message ?? null, link: e.page!.url, title }
    default: {
      const what = e.field ? ` (${e.field})` : ''
      summary = who.length > 0 ? `${actor} assigned ${who.join(', ')} to "${title}"${what}` : `${actor} assigned someone to "${title}"${what}`
    }
  }
  return { summary, excerpt: e.comment?.excerpt ?? null, link: e.page!.url, title }
}

/**
 * Generic JSON body, version 1 (docs/WEBHOOKS.md). Ids, names, titles and links only: comment text
 * is never sent (docs/adr/1190-*), digests list at most GENERIC_DIGEST_LISTED pages.
 */
function toGenericPayload(e: ResolvedEvent, id: string, occurredAt: string, workspaceName: string): WebhookPayloadV1 {
  const out: WebhookPayloadV1 = {
    version: WEBHOOK_PAYLOAD_VERSION,
    id,
    type: e.type,
    occurredAt,
    workspace: { id: e.workspaceId, name: workspaceName },
    actor: e.actor ? { id: e.actor.id, name: e.actor.name, via: e.via } : null,
  }
  if (e.page) out.page = e.page
  if (e.comment) out.comment = { id: e.comment.id }
  if (e.users) out.users = e.users
  if (e.type === 'assigned') out.field = e.field ?? null
  if (e.type === 'automation') {
    out.field = e.field ?? null
    out.message = e.message ?? null
  }
  if (e.pages) {
    out.pages = e.pages.slice(0, GENERIC_DIGEST_LISTED).map((p) => ({ ...p }))
    out.total = e.pages.length
    out.url = e.url ?? null
  }
  return out
}

const wsNames = new Map<string, { at: number; name: string }>()

/** Workspace name for generic payloads (cached like the hook list: 60 s). */
async function workspaceName(id: string): Promise<string> {
  const hit = wsNames.get(id)
  if (hit && Date.now() - hit.at < HOOK_CACHE_TTL_MS) return hit.name
  const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, id)).limit(1)
  const name = w?.name ?? ''
  wsNames.set(id, { at: Date.now(), name })
  if (wsNames.size > 10_000) wsNames.delete(wsNames.keys().next().value as string)
  return name
}

function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function discordEscape(s: string): string {
  // Neutralise markdown and mass mentions; allowed_mentions also blocks pings server-side.
  return s.replace(/([\\*_~`|>[\]()#:-])/g, '\\$1').replace(/@/g, '@\u200b')
}

export function formatPayload(kind: Exclude<WebhookKind, 'generic'>, m: Message): string {
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

/** The request body of a delivery for `hook`. */
async function deliveryBody(
  hook: Pick<HookRow, 'kind' | 'workspaceId'>,
  e: ResolvedEvent,
  id: string,
  occurredAt: string,
): Promise<string> {
  if (hook.kind === 'generic') return JSON.stringify(toGenericPayload(e, id, occurredAt, await workspaceName(hook.workspaceId)))
  return formatPayload(hook.kind, toMessage(e))
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryResult =
  | { ok: true; status: number; durationMs: number }
  | {
      ok: false
      retryable: boolean
      retryAfterMs?: number
      error: string
      /** HTTP status when the endpoint answered. */
      status?: number
      durationMs: number
      /** Start of a non-2xx body (printable, ≤ RESPONSE_EXCERPT_MAX characters). */
      responseExcerpt?: string | null
    }

/** Printable start of a response body for the delivery record (non-2xx only, docs/adr/1191-*). */
function responseExcerpt(body: Buffer): string | null {
  if (body.length === 0) return null
  const t = body
    .subarray(0, RESPONSE_EXCERPT_MAX * 4)
    .toString('utf8')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return null
  return t.length > RESPONSE_EXCERPT_MAX ? t.slice(0, RESPONSE_EXCERPT_MAX - 1) + '…' : t
}

/**
 * One HTTP attempt. Slack / Discord: host + path allowlist. Generic: no allowlist, so safeFetch's
 * public-address check and the pinned connection are the whole SSRF guard; the test-mode loopback
 * receiver is the only bypass. Never follows redirects (a 3xx is a failed attempt).
 */
export async function deliver(
  hook: Pick<HookRow, 'id' | 'kind' | 'url'> & Partial<Pick<HookRow, 'secret' | 'previousSecret' | 'previousSecretUntil'>>,
  body: string,
  deliveryId?: string,
  event?: string,
): Promise<DeliveryResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  let url: string
  try {
    url = hookUrl(hook)
  } catch (e) {
    if (e instanceof SecretUnreadableError) return { ok: false, retryable: false, error: UNREADABLE_URL_ERROR, durationMs: 0 }
    throw e
  }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, retryable: false, error: 'invalid URL', durationMs: 0 }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(deliveryId ? { 'x-inkling-delivery': deliveryId } : {}) }
  if (hook.kind === 'generic') {
    let secrets: string[]
    try {
      secrets = signingSecrets({ id: hook.id, secret: hook.secret ?? null, previousSecret: hook.previousSecret ?? null, previousSecretUntil: hook.previousSecretUntil ?? null })
    } catch (e) {
      if (e instanceof SecretUnreadableError) return { ok: false, retryable: false, error: UNREADABLE_SECRET_ERROR, durationMs: 0 }
      throw e
    }
    if (secrets.length === 0) return { ok: false, retryable: false, error: 'no signing secret', durationMs: 0 }
    headers['x-inkling-signature'] = signatureHeader(secrets, body, Math.floor(Date.now() / 1000))
    if (event) headers['x-inkling-event'] = event
    headers['user-agent'] = 'Inkling-Webhooks/1'
  }
  const loop = isLoopbackTestUrl(u)
  const policy =
    hook.kind === 'generic'
      ? { allowedPorts: [443] }
      : { allowedHosts: PROVIDERS[hook.kind].hosts, allowedPathPrefixes: [PROVIDERS[hook.kind].prefix] }
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      body,
      headers,
      ...(loop ? { unsafeAllowLoopbackForTests: true } : policy),
      maxRedirects: 0,
      maxBytes: 16 * 1024,
      truncate: true,
      timeoutMs: 8000,
    })
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, durationMs: elapsed() }
    const base = { status: res.status, durationMs: elapsed(), responseExcerpt: responseExcerpt(res.body) }
    if (res.status === 429) {
      const ra = Number(res.headers['retry-after'])
      return { ok: false, retryable: true, retryAfterMs: Number.isFinite(ra) ? Math.min(ra * 1000, 60_000) : undefined, error: 'HTTP 429', ...base }
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, retryable: false, error: `HTTP ${res.status} (redirects are not followed)`, ...base }
    return { ok: false, retryable: res.status >= 500, error: `HTTP ${res.status}`, ...base }
  } catch (e) {
    const code = e instanceof SafeFetchError ? e.code : 'network'
    const retryable = code === 'timeout' || code === 'network' || code === 'dns_failed'
    return { ok: false, retryable, error: code, durationMs: elapsed() }
  }
}

interface WebhookJob {
  hookId: string
  event: WebhookEventInput
  /** `attempts` when the delivery was last sent again by hand: the retry budget counts from there. */
  attemptBase?: number
}

interface ClaimedRow {
  id: string
  workspaceId: string
  payload: WebhookJob
  attempts: number
  /** outbox.created_at in ms: the event's `occurredAt`. */
  createdMs: number
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
  // webhooks turned off (docs/adr/2507-*): nothing is sent; queued deliveries wait (or expire) as they are
  if (isFeatureDisabled('webhooks')) return 0
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
    RETURNING id::text AS id, workspace_id AS "workspaceId", payload, attempts,
              (extract(epoch from created_at) * 1000)::float8 AS "createdMs"
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

/** The attempt to record with the outbox update (docs/adr/1191-*). */
interface AttemptRecord {
  hookId: string
  event: string
  status: 'ok' | 'retrying' | 'failed'
  result: DeliveryResult
}

/**
 * `INSERT … ON CONFLICT` of the delivery record, as the tail of a statement whose CTE `s` is the
 * outbox update (`RETURNING id, available_at`): nothing is recorded when the lease was lost.
 */
function recordAttemptSql(r: ClaimedRow, a: AttemptRecord) {
  const res = a.result
  const statusCode = res.status ?? null
  const error = res.ok ? null : res.error.slice(0, 300)
  const excerpt = res.ok ? null : (res.responseExcerpt ?? null)
  return sql`
    INSERT INTO webhook_deliveries (hook_id, outbox_id, event, status, attempts, status_code, error, duration_ms, response_excerpt, next_attempt_at)
    SELECT ${a.hookId}::uuid, s.id, ${a.event}::text, ${a.status}::text, ${r.attempts}::int, ${statusCode}::int, ${error}::text,
           ${res.durationMs}::int, ${excerpt}::text, CASE WHEN ${a.status}::text = 'retrying' THEN s.available_at END
      FROM s
    ON CONFLICT (outbox_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, status_code = excluded.status_code,
           error = excluded.error, duration_ms = excluded.duration_ms, response_excerpt = excluded.response_excerpt,
           next_attempt_at = excluded.next_attempt_at, updated_at = now()
    RETURNING (xmax = 0) AS inserted`
}

/** Finish a leased row, unless another consumer took it over (lease expired: attempts moved on). */
async function settle(r: ClaimedRow, state: 'done' | 'dead', error: string | null, attempt?: AttemptRecord): Promise<void> {
  const update = sql`
    UPDATE outbox SET state = ${state}, finished_at = now(), locked_until = NULL, last_error = ${error?.slice(0, 300) ?? null}
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}`
  if (!attempt) {
    await db.execute(update)
    return
  }
  const ok = attempt.status === 'ok'
  // Success: outbox row, delivery record and the hook's streak reset in one statement.
  const rows = (await db.execute(sql`
    WITH s AS (${update} RETURNING id, available_at),
         rec AS (${recordAttemptSql(r, attempt)})
    ${
      ok
        ? sql`, hk AS (
             UPDATE workspace_webhooks SET failure_count = 0, last_error = NULL, last_success_at = now(), failing_since = NULL
              WHERE id = ${attempt.hookId}::uuid)
           SELECT inserted FROM rec`
        : sql`SELECT inserted FROM rec`
    }
  `)) as unknown as { inserted: boolean }[]
  if (rows[0]?.inserted) notePrune(attempt.hookId)
}

async function retryLater(r: ClaimedRow, delayMs: number, error: string, countAttempt = true, attempt?: AttemptRecord): Promise<void> {
  const update = sql`
    UPDATE outbox SET locked_until = NULL, last_error = ${error.slice(0, 300)},
           attempts = ${countAttempt ? r.attempts : r.attempts - 1},
           available_at = now() + make_interval(secs => ${delayMs / 1000})
     WHERE id = ${r.id} AND state = 'pending' AND attempts = ${r.attempts}`
  if (attempt) {
    const rows = (await db.execute(sql`
      WITH s AS (${update} RETURNING id, available_at)
      ${recordAttemptSql(r, attempt)}
    `)) as unknown as { inserted: boolean }[]
    if (rows[0]?.inserted) notePrune(attempt.hookId)
  } else {
    await db.execute(update)
  }
  wakeAt('webhook', delayMs)
}

const sinceprune = new Map<string, number>()

/** Count a new delivery record of `hookId`; every PRUNE_EVERY records, drop all but the newest KEEP. */
function notePrune(hookId: string): void {
  const n = (sinceprune.get(hookId) ?? 0) + 1
  if (n < PRUNE_EVERY) {
    sinceprune.set(hookId, n)
    if (sinceprune.size > 10_000) sinceprune.delete(sinceprune.keys().next().value as string)
    return
  }
  sinceprune.delete(hookId)
  void db
    .execute(sql`
      DELETE FROM webhook_deliveries
       WHERE hook_id = ${hookId}::uuid
         AND id < (SELECT id FROM webhook_deliveries WHERE hook_id = ${hookId}::uuid ORDER BY id DESC OFFSET ${WEBHOOK_DELIVERY_KEEP - 1} LIMIT 1)
    `)
    .catch((err) => log(`[webhooks] prune failed: ${String(err)}`))
}

/** Fault injection for the crash tests: runs after the HTTP call, before the row is finished. */
export const webhookTestHooks: { afterSend?: (r: { id: string; attempts: number }) => void | Promise<void> } = {}

async function runJob(r: ClaimedRow): Promise<void> {
  const job = r.payload
  // Attempts since the delivery was last sent by hand (resend gives a fresh retry budget).
  const used = r.attempts - Math.max(0, Number(job.attemptBase ?? 0))
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
    const resolved = await resolveEvent(job.event, hook.workspaceId)
    if (!resolved) return await settle(r, 'done', 'skipped: not deliverable')
    const wait = takeToken(hook.workspaceId)
    if (wait > 0) return await retryLater(r, wait, 'rate limited', false)
    const body = await deliveryBody(hook, resolved, r.id, new Date(Number(r.createdMs)).toISOString())
    const result = await deliver(hook, body, r.id, job.event.type)
    await webhookTestHooks.afterSend?.({ id: r.id, attempts: r.attempts })
    const rec = (status: AttemptRecord['status']): AttemptRecord => ({ hookId: hook.id, event: job.event.type, status, result })
    if (result.ok) {
      await settle(r, 'done', null, rec('ok'))
      return
    }
    if (result.retryable && used < WEBHOOK_RETRY.maxAttempts) {
      await retryLater(r, result.retryAfterMs ?? backoff(used), result.error, true, rec('retrying'))
      return
    }
    await settle(r, 'dead', result.error, rec('failed'))
    await recordFailure(hook, result.error)
  } catch (err) {
    log(`[webhooks] job failed: ${String(err)}`)
    try {
      if (used < WEBHOOK_RETRY.maxAttempts) await retryLater(r, backoff(used), String(err))
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

/**
 * A delivery gave up. Disable the hook after AUTO_DISABLE_AFTER consecutive failed events; a
 * generic hook additionally only once the streak is GENERIC_DISABLE_AFTER_MS old (docs/adr/1192-*),
 * so a receiver that is down for a deploy does not lose its hook. Owners get one notification.
 */
async function recordFailure(hook: HookRow, error: string): Promise<void> {
  const [row] = await db
    .update(workspaceWebhooks)
    .set({
      failureCount: sql`${workspaceWebhooks.failureCount} + 1`,
      lastError: error.slice(0, 200),
      failingSince: sql`coalesce(${workspaceWebhooks.failingSince}, now())`,
    })
    .where(eq(workspaceWebhooks.id, hook.id))
    .returning({ failureCount: workspaceWebhooks.failureCount, enabled: workspaceWebhooks.enabled, failingSince: workspaceWebhooks.failingSince })
  if (!row || row.enabled !== '1' || row.failureCount < AUTO_DISABLE_AFTER) return
  if (hook.kind === 'generic' && (!row.failingSince || Date.now() - row.failingSince.getTime() < GENERIC_DISABLE_AFTER_MS)) return
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
// Delivery records, resend (docs/adr/1191-*)
// ---------------------------------------------------------------------------

/** Recent deliveries of a hook, newest first. */
export async function listDeliveries(hookId: string, limit = 30): Promise<WebhookDeliveryDTO[]> {
  const rows = (await db.execute(sql`
    SELECT d.outbox_id::text AS "outboxId", d.event, d.status, d.attempts, d.status_code AS "statusCode", d.error,
           d.duration_ms AS "durationMs", d.response_excerpt AS "responseExcerpt",
           to_json(CASE WHEN o.state = 'pending' THEN greatest(o.available_at, coalesce(o.locked_until, o.available_at)) ELSE d.next_attempt_at END) #>> '{}' AS "nextAttemptAt",
           to_json(d.created_at) #>> '{}' AS "createdAt", to_json(d.updated_at) #>> '{}' AS "updatedAt",
           o.state AS "outboxState"
      FROM webhook_deliveries d
      LEFT JOIN outbox o ON o.id = d.outbox_id AND o.topic = 'webhook'
     WHERE d.hook_id = ${hookId}::uuid
     ORDER BY d.id DESC
     LIMIT ${Math.max(1, Math.min(100, limit))}
  `)) as unknown as {
    outboxId: string | null
    event: string
    status: WebhookDeliveryDTO['status']
    attempts: number
    statusCode: number | null
    error: string | null
    durationMs: number | null
    responseExcerpt: string | null
    nextAttemptAt: string | null
    createdAt: string
    updatedAt: string
    outboxState: string | null
  }[]
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null)
  return rows.map((r) => ({
    id: r.outboxId,
    event: r.event as WebhookDeliveryDTO['event'],
    // A row sent again by hand is pending in the outbox before its record is rewritten.
    status: r.outboxState === 'pending' ? 'retrying' : r.status,
    attempts: Number(r.attempts),
    statusCode: r.statusCode === null ? null : Number(r.statusCode),
    error: r.error,
    durationMs: r.durationMs === null ? null : Number(r.durationMs),
    responseExcerpt: r.responseExcerpt,
    nextAttemptAt: r.outboxState === 'pending' || r.status === 'retrying' ? iso(r.nextAttemptAt) : null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    canResend: r.outboxState !== null,
  }))
}

/**
 * Send a delivery again (owner action): the same outbox row, so the same X-Inkling-Delivery and
 * body `id`, due now, taken by this process, with a fresh retry budget (`attemptBase`; `attempts`
 * itself keeps growing, so a consumer whose lease expired can never finish the new attempt).
 * 'gone': the row was purged (done after 7 days, failed after 30) or belongs to another hook;
 * 'busy': an attempt is in flight right now.
 */
export async function resendDelivery(hookId: string, outboxId: number): Promise<'queued' | 'gone' | 'busy'> {
  const rows = (await db.execute(sql`
    WITH s AS (
      UPDATE outbox SET state = 'pending', available_at = now(), locked_until = NULL, finished_at = NULL, last_error = NULL,
             origin = ${OUTBOX_ORIGIN}, payload = jsonb_set(payload, '{attemptBase}', to_jsonb(attempts))
       WHERE id = ${outboxId} AND topic = 'webhook' AND payload->>'hookId' = ${hookId}
         AND (state <> 'pending' OR locked_until IS NULL OR locked_until < now())
      RETURNING id, available_at)
    UPDATE webhook_deliveries d SET status = 'retrying', next_attempt_at = s.available_at, updated_at = now()
      FROM s WHERE d.outbox_id = s.id
    RETURNING d.id
  `)) as unknown as unknown[]
  const [hit] = (await db.execute(sql`
    SELECT state, locked_until > now() AS leased FROM outbox WHERE id = ${outboxId} AND topic = 'webhook' AND payload->>'hookId' = ${hookId}
  `)) as unknown as { state: string; leased: boolean | null }[]
  if (!hit) return 'gone'
  if (rows.length === 0 && hit.leased) return 'busy'
  kickOutbox('webhook')
  return 'queued'
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

/** `exec`: the caller's transaction when it has one (a cache miss must not wait for a second pool connection). */
async function enabledHooks(workspaceId: string, exec: Pick<typeof db, 'select'> = db): Promise<CachedHooks['hooks']> {
  // webhooks turned off (DISABLED_FEATURES, docs/adr/2507-*): no hook takes events; the hooks are kept
  if (isFeatureDisabled('webhooks')) return []
  const hit = hookCache.get(workspaceId)
  if (hit && Date.now() - hit.at < HOOK_CACHE_TTL_MS) return hit.hooks
  const rows = await exec
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
 * Outbox rows of an event: one per enabled hook of the workspace subscribed to it (dedupe key per
 * event and hook). For writers that queue the rows in their own statement (`outboxInsertSql`,
 * docs/adr/1150-*); the flood guard (WEBHOOK_QUEUE_MAX_PER_WS) is part of that insert.
 */
export async function webhookOutboxRows(ev: WebhookEventInput, exec: Pick<typeof db, 'select'> = db): Promise<OutboxRow[]> {
  const hooks = (await enabledHooks(ev.workspaceId, exec)).filter((h) => h.events.includes(ev.type))
  if (hooks.length === 0) return []
  const key = eventKey(ev) ?? randomUUID()
  const delayMs = ev.type === 'page_created' ? PAGE_CREATED_DELAY_MS : 0
  return hooks.map((h) => ({
    topic: 'webhook' as const,
    workspaceId: ev.workspaceId,
    dedupeKey: `wh:${key}:${h.id}`,
    payload: { hookId: h.id, event: ev } satisfies WebhookJob,
    delayMs,
  }))
}

/**
 * Queue an event for every enabled hook of the workspace subscribed to it, with `exec` (the
 * producer's transaction, or `db`). Returns the number of deliveries queued. Privacy filtering
 * happens at delivery. In a transaction, call `outboxCommitted(['webhook'])` after the commit.
 */
export async function enqueueWebhookEvent(exec: Exec & Pick<typeof db, 'select'>, ev: WebhookEventInput): Promise<number> {
  const rows = await webhookOutboxRows(ev, exec)
  if (rows.length === 0) return 0
  const n = await enqueue(exec, rows)
  if (n < rows.length) log(`[webhooks] ${rows.length - n} of ${rows.length} ${ev.type} deliveries not queued (already queued, or the workspace queue of ${WEBHOOK_QUEUE_MAX_PER_WS} is full)`)
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
/**
 * Send a fixed test message right away (bypasses the queue, still rate-limited per workspace).
 * Generic hooks get a signed `type: "test"` event with a fresh `test_…` delivery id; the attempt is
 * recorded in the delivery list (no outbox row, so it cannot be sent again).
 */
export async function sendTestMessage(hook: HookRow, workspaceName: string, actor?: { id: string; name: string }): Promise<DeliveryResult> {
  const wait = takeToken(hook.workspaceId)
  if (wait > 0) return { ok: false, retryable: true, retryAfterMs: wait, error: 'rate_limited', durationMs: 0 }
  const origin = appOrigin()
  let body: string
  let deliveryId: string | undefined
  if (hook.kind === 'generic') {
    deliveryId = `test_${randomUUID()}`
    const payload: WebhookPayloadV1 = {
      version: WEBHOOK_PAYLOAD_VERSION,
      id: deliveryId,
      type: 'test',
      occurredAt: new Date().toISOString(),
      workspace: { id: hook.workspaceId, name: workspaceName },
      actor: actor ? { id: actor.id, name: actor.name, via: null } : null,
      url: origin ? `${origin}/w/${hook.workspaceId}` : null,
    }
    body = JSON.stringify(payload)
  } else {
    body = formatPayload(hook.kind, {
      summary: `Test message from Inkling workspace "${workspaceName}". Webhook notifications are working.`,
      excerpt: null,
      link: origin ? `${origin}/w/${hook.workspaceId}` : null,
      title: workspaceName,
    })
  }
  const result = await deliver(hook, body, deliveryId, 'test')
  if (result.ok) {
    await db
      .update(workspaceWebhooks)
      .set({ failureCount: 0, lastError: null, lastSuccessAt: new Date(), failingSince: null })
      .where(eq(workspaceWebhooks.id, hook.id))
  } else {
    await db.update(workspaceWebhooks).set({ lastError: result.error.slice(0, 200) }).where(eq(workspaceWebhooks.id, hook.id))
  }
  await db.execute(sql`
    INSERT INTO webhook_deliveries (hook_id, outbox_id, event, status, attempts, status_code, error, duration_ms, response_excerpt)
    VALUES (${hook.id}::uuid, NULL, 'test', ${result.ok ? 'ok' : 'failed'}, 1, ${(result.status ?? null) as number | null}::int,
            ${result.ok ? null : result.error.slice(0, 300)}::text, ${result.durationMs}::int, ${result.ok ? null : (result.responseExcerpt ?? null)}::text)
  `)
  notePrune(hook.id)
  return result
}

export function initWebhooks(logger: (msg: string) => void): void {
  log = logger
}

/** Exposed for tests/diagnostics: deliveries in flight in this process. */
export function _queueSize(): number {
  return inflight
}

