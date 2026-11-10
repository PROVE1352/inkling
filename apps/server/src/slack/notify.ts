import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SlackEventKind } from '@inkling/shared'
import { db } from '../db/index'
import { comments, pages, pageTexts, slackIntegrations, slackUserLinks, users, workspaceMembers } from '../db/schema'
import { resolveLocale } from '../i18n'
import type { NotifyInput } from '../notify/engine'
import type { NotifyKind } from '../notify/kinds'
import { backoffMs, drainOutbox, enqueue, kickOutbox, outboxCommitted, ownedOrOrphaned, registerOutboxHandler, wakeAt } from '../outbox'
import type { Exec, OutboxRow, RetryPolicy } from '../outbox'
import { localISODate } from '../review'
import { liveWorkspace } from '../workspaceLive'
import { BLOCKING_ERRORS, slackApi } from './api'
import { botTokenOf, configuredOrigin, eventsOf, invalidateSlackCache, loadIntegration, pageLink, tapConfig } from './config'
import type { IntegrationRow } from './config'
import { esc, linkOr, slackText } from './messages'

/**
 * Slack channel posts and link unfurls (docs/adr/1802-*, 1805-*).
 *
 *  - Source: the notification engine. After it resolved a batch of events, `slackRowsForNotify`
 *    turns each event into at most one channel post (mention > assignment > open suggestion >
 *    reply, the first kind the workspace switched on) and the rows are queued in the consumer's
 *    transaction inside a savepoint: they commit with the notification rows, and a failure here
 *    never fails a notification. Writers (save, comment, edit) never wait for Slack: they only queue
 *    notification events, as before.
 *  - Privacy: re-resolved at delivery. A page that is not shared with the whole workspace (or is
 *    deleted, moved to another workspace, or in a deleted workspace) is never named: the job is
 *    dropped. Posts carry a summary, the title and a link; a short comment excerpt only for replies
 *    and comment mentions (as the Slack webhook does); suggestion text is never sent.
 *  - Delivery: outbox topic 'slack', leased while the HTTP call runs (at-least-once), retries with
 *    capped exponential backoff (Slack's Retry-After honoured), then 'dead'. Refusals that will not
 *    heal (revoked token, bot removed from the channel …) pause the integration (`blocked_reason`)
 *    until an admin saves the settings again or a test passes.
 */

export const SLACK_RETRY: RetryPolicy = { baseMs: 5_000, factor: 3, capMs: 15 * 60_000, maxAttempts: 6 }
export const SLACK_LEASE_MS = 30_000
/** Pending Slack jobs per workspace; beyond this new ones are dropped (flood guard). */
export const SLACK_QUEUE_MAX_PER_WS = 200
const CONCURRENCY = 2
/** Same page, kind, people and thread inside this window: one post. */
const DEDUPE_WINDOW_MS = 10 * 60_000
const DIGEST_LISTED = 10
const DIGEST_PAGES = 50
const EXCERPT_MAX = 140
const UNFURL_TEXT_MAX = 300
const UNFURL_LINKS_MAX = 5

type PostKind = Exclude<SlackEventKind, 'digest'>

export interface SlackPostJob {
  t: 'post'
  kind: PostKind
  pageId: string
  actorId: string | null
  via: string | null
  userIds: string[]
  /** comment mention / reply: the comment (its excerpt is re-read at delivery). */
  commentId: string | null
  anchor: string | null
  /** assignment: 'owner' or the person field's name. */
  field: string | null
  /** mention: page or comment. */
  inComment: boolean
}

export interface SlackDigestJob {
  t: 'digest'
  pageIds: string[]
  changes: number
}

export interface SlackUnfurlJob {
  t: 'unfurl'
  channel: string | null
  ts: string | null
  unfurlId: string | null
  source: string | null
  links: { url: string; pageId: string }[]
}

export type SlackJob = SlackPostJob | SlackDigestJob | SlackUnfurlJob

let log: (msg: string) => void = (m) => console.error(m)

export function initSlack(logger: (msg: string) => void): void {
  log = logger
}

// ---------------------------------------------------------------------------
// Notification events → channel posts
// ---------------------------------------------------------------------------

const ORDER: [PostKind, NotifyKind[]][] = [
  ['mention', ['doc_mention', 'comment_mention']],
  ['assigned', ['task_assigned', 'page_owner']],
  ['suggestion', ['approval_request']],
  ['reply', ['comment_reply']],
]

/** The channel post of one notification event, or null (no page, nothing switched on, nobody). */
export function slackPostFor(ev: NotifyInput, enabled: Set<SlackEventKind>): SlackPostJob | null {
  if (!ev.pageId) return null
  for (const [kind, kinds] of ORDER) {
    if (!enabled.has(kind)) continue
    // An agent's @mention does not ping a channel (same rule as the Slack webhook, docs/adr/1000-*).
    if (kind === 'mention' && ev.via) continue
    const hits = ev.recipients.filter((r) => kinds.includes(r.kind))
    if (!hits.length) continue
    const userIds = [...new Set(hits.map((r) => r.userId).filter((id) => id !== ev.actorId))].slice(0, 10)
    if (kind !== 'suggestion' && !userIds.length) continue
    const ownerOnly = kind === 'assigned' && hits.every((r) => r.kind === 'page_owner')
    return {
      t: 'post',
      kind,
      pageId: ev.pageId,
      actorId: ev.actorId,
      via: ev.via,
      userIds,
      commentId: kind === 'mention' || kind === 'reply' ? (ev.commentId ?? null) : null,
      anchor: ev.anchor ?? null,
      field: kind === 'assigned' ? (ownerOnly ? 'owner' : (ev.excerpt?.slice(0, 60) ?? null)) : null,
      inComment: kind === 'mention' && hits.some((r) => r.kind === 'comment_mention'),
    }
  }
  return null
}

function postKey(workspaceId: string, j: SlackPostJob, now = Date.now()): string {
  const bucket = Math.floor(now / DEDUPE_WINDOW_MS)
  const raw = [workspaceId, j.kind, j.pageId, j.actorId ?? '', j.commentId ?? j.anchor ?? '', [...j.userIds].sort().join(','), bucket].join('|')
  return `slack:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`
}

/** Outbox rows for the events of one notify pass (cached config: no statement for workspaces without Slack). */
export async function slackRowsForNotify(evs: readonly NotifyInput[]): Promise<OutboxRow[]> {
  const rows: OutboxRow[] = []
  for (const ev of evs) {
    if (!ev.pageId) continue
    const cfg = await tapConfig(ev.workspaceId)
    if (!cfg) continue
    const job = slackPostFor(ev, cfg.events)
    if (job) rows.push({ topic: 'slack', workspaceId: ev.workspaceId, payload: job, dedupeKey: postKey(ev.workspaceId, job) })
  }
  return rows
}

/** Drop rows of workspaces whose Slack queue is full (one statement). */
async function underCap(exec: Exec, rows: OutboxRow[]): Promise<OutboxRow[]> {
  const ws = [...new Set(rows.map((r) => r.workspaceId).filter((x): x is string => !!x))]
  if (!ws.length) return rows
  const full = (await exec.execute(sql`
    SELECT workspace_id::text AS id FROM outbox
     WHERE topic = 'slack' AND state = 'pending' AND workspace_id = ANY(${`{${ws.join(',')}}`}::uuid[])
     GROUP BY workspace_id HAVING count(*) >= ${SLACK_QUEUE_MAX_PER_WS}
  `)) as unknown as { id: string }[]
  if (!full.length) return rows
  const skip = new Set(full.map((f) => f.id))
  return rows.filter((r) => !r.workspaceId || !skip.has(r.workspaceId))
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Queue Slack rows in the notify consumer's transaction, in a savepoint so that any failure here
 * leaves the notification rows untouched. Returns whether rows were queued (call
 * `outboxCommitted(['slack'])` after the commit).
 */
export async function enqueueSlackInTx(tx: Tx, evs: readonly NotifyInput[]): Promise<boolean> {
  try {
    const rows = await slackRowsForNotify(evs)
    if (!rows.length) return false
    return await tx.transaction(async (sp) => (await enqueue(sp, await underCap(sp, rows))) > 0)
  } catch (err) {
    log(`[slack] queueing channel posts failed: ${String(err)}`)
    return false
  }
}

/** After the consumer's commit. */
export function slackCommitted(queued: boolean): void {
  if (queued) outboxCommitted(['slack'])
}

/** Queue rows outside a transaction (unfurls, digests). */
export async function enqueueSlack(rows: OutboxRow[]): Promise<number> {
  if (!rows.length) return 0
  return enqueue(db, await underCap(db, rows))
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface Claimed {
  id: string
  workspaceId: string
  payload: SlackJob
  attempts: number
}

let inflight = 0
const running = new Set<Promise<void>>()

export async function runSlackPass(): Promise<number> {
  const free = CONCURRENCY - inflight
  if (free <= 0) return 0
  const rows = (await db.execute(sql`
    UPDATE outbox SET locked_until = now() + make_interval(secs => ${SLACK_LEASE_MS / 1000}), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
        WHERE topic = 'slack' AND state = 'pending' AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now()) AND ${ownedOrOrphaned()}
        ORDER BY id LIMIT ${free}
          FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id, workspace_id AS "workspaceId", payload, attempts
  `)) as unknown as Claimed[]
  for (const r of rows) {
    inflight++
    const p = runJob(r).finally(() => {
      inflight--
      running.delete(p)
      kickOutbox('slack')
    })
    running.add(p)
  }
  if (rows.length === 0) await armNextWake()
  return rows.length
}

registerOutboxHandler('slack', runSlackPass, CONCURRENCY)

async function armNextWake(): Promise<void> {
  const [r] = (await db.execute(sql`
    SELECT (extract(epoch from min(greatest(available_at, coalesce(locked_until, available_at))) - now()) * 1000)::float8 AS ms
      FROM outbox WHERE topic = 'slack' AND state = 'pending'
  `)) as unknown as { ms: number | null }[]
  if (r?.ms !== null && r?.ms !== undefined) wakeAt('slack', Math.min(30_000, Math.max(0, Number(r.ms)) + 5))
}

/** Tests, shutdown: run passes until nothing due is left and no delivery of this process is in flight. */
export async function flushSlack(maxRounds = 100): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    // serialised with passes the outbox scheduler started (kicks), so none is half-way through a claim
    await drainOutbox('slack', 5)
    if (running.size) {
      await Promise.allSettled([...running])
      continue
    }
    const [r] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM outbox WHERE topic = 'slack' AND state = 'pending' AND available_at <= now()
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
  wakeAt('slack', delayMs)
}

/** Token-level refusals pause everything; channel-level ones only matter for channel posts. */
const TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'secret_unreadable', 'org_login_required'])

export async function recordSlackError(workspaceId: string, error: string, block: boolean): Promise<void> {
  await db
    .update(slackIntegrations)
    .set({ lastError: error.slice(0, 200), lastErrorAt: new Date(), ...(block ? { blockedReason: error.slice(0, 200) } : {}) })
    .where(eq(slackIntegrations.workspaceId, workspaceId))
  if (block) invalidateSlackCache(workspaceId)
}

async function recordSuccess(workspaceId: string): Promise<void> {
  await db.execute(sql`
    UPDATE slack_integrations SET last_success_at = now()
     WHERE workspace_id = ${workspaceId} AND (last_success_at IS NULL OR last_success_at < now() - interval '1 minute')`)
}

async function runJob(r: Claimed): Promise<void> {
  const job = r.payload
  try {
    const [live] = await db
      .select({ id: slackIntegrations.workspaceId })
      .from(slackIntegrations)
      .where(and(eq(slackIntegrations.workspaceId, r.workspaceId), liveWorkspace(slackIntegrations.workspaceId)))
      .limit(1)
    const integ = live ? await loadIntegration(r.workspaceId) : null
    if (!integ || integ.enabled !== '1') return await settle(r, 'done', 'skipped: integration gone or off')
    if (integ.blockedReason) return await settle(r, 'done', 'skipped: integration paused')
    if (job.t === 'post' && !eventsOf(integ.events).includes(job.kind)) return await settle(r, 'done', 'skipped: kind switched off')
    if (job.t === 'digest' && !eventsOf(integ.events).includes('digest')) return await settle(r, 'done', 'skipped: kind switched off')
    const token = botTokenOf(integ)
    if (!token) {
      await recordSlackError(integ.workspaceId, 'secret_unreadable', true)
      return await settle(r, 'dead', 'secret_unreadable')
    }
    const call = await buildCall(job, integ)
    if (!call) return await settle(r, 'done', 'skipped: not deliverable')
    const res = await slackApi(call.method, token, call.params)
    if (res.ok) {
      await settle(r, 'done', null)
      await recordSuccess(integ.workspaceId)
      return
    }
    if (res.retryable && r.attempts < SLACK_RETRY.maxAttempts) {
      await retryLater(r, res.retryAfterMs ?? backoffMs(r.attempts, SLACK_RETRY), res.error)
      return
    }
    await settle(r, 'dead', res.error)
    const block = job.t === 'unfurl' ? TOKEN_ERRORS.has(res.error) : BLOCKING_ERRORS.has(res.error)
    await recordSlackError(integ.workspaceId, res.error, block)
  } catch (err) {
    log(`[slack] job ${r.id} failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
    try {
      if (r.attempts < SLACK_RETRY.maxAttempts) await retryLater(r, backoffMs(r.attempts, SLACK_RETRY), 'internal error')
      else await settle(r, 'dead', 'internal error')
    } catch {
      // the lease expires and another pass takes the row again
    }
  }
}

// ---------------------------------------------------------------------------
// Jobs → Web API calls (the privacy gate)
// ---------------------------------------------------------------------------

/** Only pages shared with the whole workspace, alive, in the integration's workspace. */
async function sharedPages(workspaceId: string, ids: string[]) {
  if (!ids.length) return []
  return db
    .select({ id: pages.id, title: pages.title, kind: pages.kind })
    .from(pages)
    .where(and(inArray(pages.id, ids.slice(0, 100)), eq(pages.workspaceId, workspaceId), eq(pages.scope, 'shared'), sql`${pages.deletedAt} is null`))
}

function plain(s: string, max: number): string {
  const t = s
    .slice(0, 4000)
    .replace(/\[([^\]\n]{0,200})\]\([^)\s]{0,500}\)/g, '$1')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

interface Call {
  method: string
  params: Record<string, unknown>
}

async function buildCall(job: SlackJob, integ: IntegrationRow): Promise<Call | null> {
  if (job.t === 'post') return buildPost(job, integ)
  if (job.t === 'digest') return buildDigest(job, integ)
  return buildUnfurl(job, integ)
}

async function memberNames(workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, workspaceId)))
    .where(inArray(users.id, [...new Set(ids)].slice(0, 50)))
  for (const r of rows) out.set(r.id, r.name)
  return out
}

async function buildPost(job: SlackPostJob, integ: IntegrationRow): Promise<Call | null> {
  const [page] = await sharedPages(integ.workspaceId, [job.pageId])
  if (!page) return null
  const t = slackText(resolveLocale(null))
  const names = await memberNames(integ.workspaceId, [...(job.actorId ? [job.actorId] : []), ...job.userIds])
  const links = job.userIds.length
    ? await db
        .select({ userId: slackUserLinks.userId, slackUserId: slackUserLinks.slackUserId })
        .from(slackUserLinks)
        .where(and(eq(slackUserLinks.workspaceId, integ.workspaceId), eq(slackUserLinks.teamId, integ.teamId), inArray(slackUserLinks.userId, job.userIds)))
    : []
  const slackOf = new Map(links.map((l) => [l.userId, l.slackUserId]))
  const who = job.userIds
    .filter((id) => names.has(id))
    .slice(0, 5)
    .map((id) => {
      const s = slackOf.get(id)
      return s && /^[UW][A-Z0-9]{2,30}$/.test(s) ? `<@${s}>` : esc(names.get(id)!)
    })
  if (job.kind !== 'suggestion' && who.length === 0) return null
  const actorName = esc((job.actorId && names.get(job.actorId)) || t.someone)
  const actor = job.via ? t.via(actorName, esc(plain(job.via, 60))) : actorName
  const title = linkOr(pageLink(configuredOrigin(), integ.workspaceId, page.id), esc(page.title.trim() || t.untitled))
  let excerpt: string | null = null
  if (job.commentId) {
    const [c] = await db.select({ body: comments.body, pageId: comments.pageId }).from(comments).where(eq(comments.id, job.commentId)).limit(1)
    if (!c || c.pageId !== page.id) return null
    excerpt = plain(c.body, EXCERPT_MAX) || null
  }
  const list = who.join(', ')
  let text: string
  switch (job.kind) {
    case 'mention':
      text = job.inComment ? t.mentionInComment(actor, list, title) : t.mention(actor, list, title)
      break
    case 'assigned':
      text = t.assigned(actor, list, title, job.field && job.field !== 'owner' ? esc(plain(job.field, 60)) : null)
      break
    case 'suggestion':
      text = t.suggestion(actor, title, job.anchor ? esc(`§${plain(job.anchor, 60)}`) : null)
      break
    default:
      text = t.reply(actor, title)
  }
  if (excerpt) text += `\n> ${esc(excerpt)}`
  return { method: 'chat.postMessage', params: { channel: integ.channelId, text, unfurl_links: false, unfurl_media: false } }
}

async function buildDigest(job: SlackDigestJob, integ: IntegrationRow): Promise<Call | null> {
  const rows = await sharedPages(integ.workspaceId, job.pageIds)
  if (!rows.length) return null
  const order = new Map(job.pageIds.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const t = slackText(resolveLocale(null))
  const origin = configuredOrigin()
  const listed = rows.slice(0, DIGEST_LISTED).map((p) => `• ${linkOr(pageLink(origin, integ.workspaceId, p.id), esc(p.title.trim() || t.untitled))}`)
  const more = rows.length - listed.length
  const text = [t.digest(rows.length, Math.max(job.changes, rows.length)), ...listed, ...(more > 0 ? [t.more(more)] : [])].join('\n')
  return { method: 'chat.postMessage', params: { channel: integ.channelId, text, unfurl_links: false, unfurl_media: false } }
}

/** First paragraph of a page's indexed text: the first line long enough to be prose, capped. */
export function firstParagraph(text: string, title: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== title.trim())
  if (!lines.length) return null
  const prose = lines.find((l) => l.length >= 20) ?? lines[0]
  return plain(prose, UNFURL_TEXT_MAX) || null
}

async function buildUnfurl(job: SlackUnfurlJob, integ: IntegrationRow): Promise<Call | null> {
  const ids = [...new Set(job.links.map((l) => l.pageId))]
  const shared = await sharedPages(integ.workspaceId, ids)
  if (!shared.length) return null
  const texts = await db.select({ pageId: pageTexts.pageId, text: pageTexts.text }).from(pageTexts).where(inArray(pageTexts.pageId, shared.map((p) => p.id)))
  const textOf = new Map(texts.map((x) => [x.pageId, x.text]))
  const byId = new Map(shared.map((p) => [p.id, p]))
  const t = slackText(resolveLocale(null))
  const origin = configuredOrigin()
  const unfurls: Record<string, unknown> = {}
  for (const l of job.links.slice(0, UNFURL_LINKS_MAX)) {
    const p = byId.get(l.pageId)
    if (!p) continue
    const title = esc(p.title.trim() || t.untitled)
    const para = p.kind === 'doc' ? firstParagraph(textOf.get(p.id) ?? '', p.title) : null
    const link = pageLink(origin, integ.workspaceId, p.id) ?? l.url
    unfurls[l.url] = {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${linkOr(link, title)}${para ? `\n${esc(para)}` : ''}` } }],
    }
  }
  if (!Object.keys(unfurls).length) return null
  const target = job.unfurlId && job.source ? { unfurl_id: job.unfurlId, source: job.source } : { channel: job.channel, ts: job.ts }
  return { method: 'chat.unfurl', params: { ...target, unfurls } }
}

// ---------------------------------------------------------------------------
// Daily change summary, housekeeping
// ---------------------------------------------------------------------------

/**
 * Once a local day per workspace whose Slack app has `digest` on: the shared pages that changed in
 * the last day (people and agents). Claimed with `digest_sent_on` before it is queued.
 */
export async function runSlackDigests(now = new Date(), opts: { force?: boolean; workspaceIds?: string[] } = {}): Promise<number> {
  const today = localISODate(now)
  const iso = now.toISOString()
  const only = opts.workspaceIds?.length ? sql`AND s.workspace_id = ANY(${`{${opts.workspaceIds.join(',')}}`}::uuid[])` : sql``
  const candidates = (await db.execute(sql`
    SELECT s.workspace_id::text AS id FROM slack_integrations s JOIN workspaces w ON w.id = s.workspace_id
     WHERE w.deleted_at IS NULL AND s.enabled = '1' AND s.blocked_reason IS NULL AND s.events ? 'digest'
       AND (${!!opts.force}::boolean OR s.digest_sent_on IS DISTINCT FROM ${today}) ${only}
     LIMIT 500
  `)) as unknown as { id: string }[]
  let sent = 0
  for (const ws of candidates) {
    const claimed = (await db.execute(sql`
      UPDATE slack_integrations SET digest_sent_on = ${today}
       WHERE workspace_id = ${ws.id} AND (${!!opts.force}::boolean OR digest_sent_on IS DISTINCT FROM ${today})
      RETURNING workspace_id
    `)) as unknown as unknown[]
    if (!claimed.length) continue
    const changed = (await db.execute(sql`
      SELECT c.page_id AS "pageId", count(*)::int AS n FROM page_changes c JOIN pages p ON p.id = c.page_id
       WHERE c.workspace_id = ${ws.id} AND c.scope = 'shared'
         AND c.changed_at > ${iso}::timestamptz - interval '1 day' AND c.changed_at <= ${iso}::timestamptz
         AND p.deleted_at IS NULL AND p.scope = 'shared' AND p.workspace_id = ${ws.id}
       GROUP BY c.page_id ORDER BY max(c.seq) DESC LIMIT ${DIGEST_PAGES}
    `)) as unknown as { pageId: string; n: number }[]
    if (!changed.length) continue
    const job: SlackDigestJob = { t: 'digest', pageIds: changed.map((c) => c.pageId), changes: changed.reduce((s, c) => s + Number(c.n), 0) }
    sent += await enqueueSlack([{ topic: 'slack', workspaceId: ws.id, payload: job, dedupeKey: `slack:digest:${ws.id}:${today}${opts.force ? `:${iso}` : ''}` }])
  }
  return sent
}

/** Hourly: forget replay nonces past the window and expired link codes. */
export async function pruneSlackState(): Promise<void> {
  await db.execute(sql`DELETE FROM slack_request_nonces WHERE seen_at < now() - interval '15 minutes'`)
  await db.execute(sql`DELETE FROM slack_link_codes WHERE expires_at < now()`)
}

/** Hourly from the notification housekeeping; never throws. */
export async function runSlackHousekeeping(now: Date, logger: (msg: string) => void): Promise<void> {
  try {
    const n = await runSlackDigests(now)
    await pruneSlackState()
    if (n) logger(`[inkling] slack: ${n} daily change summar${n === 1 ? 'y' : 'ies'} queued`)
  } catch (err) {
    logger(`[inkling] slack housekeeping failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
}

