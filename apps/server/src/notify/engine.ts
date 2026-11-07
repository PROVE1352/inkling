import { sql } from 'drizzle-orm'
import type { NotificationLevel } from '@inkling/shared'
import { broadcastToUser } from '../collab'
import { db } from '../db/index'
import { mailEnabled } from '../env'
import { drainOutbox, enqueue, failRow, ownedOrOrphaned, registerOutboxHandler } from '../outbox'
import type { Exec, RetryPolicy } from '../outbox'
import { liveWorkspace } from '../workspaceLive'
import { decide, KINDS } from './kinds'
import type { NotifyKind, Reason } from './kinds'
import { scheduleInstantMail } from './mailer'

/**
 * Notification engine (docs/adr/1000-*).
 *
 * Producers (comments, owner and person-cell assignment, the document indexer for @mentions, the
 * change log for followed pages) queue an event: `enqueueNotify(tx, …)` inside their transaction, or
 * `notify()` (one INSERT, not awaited) right after it. Events live in the outbox table (topic
 * 'notify', docs/adr/1081-*), so a crash before processing loses nothing. The consumer resolves
 * each event with a handful of set-based statements (no per-recipient queries) and deletes the
 * outbox row in the transaction that writes the notification rows: exactly once. Failures retry
 * with exponential backoff (NOTIFY_RETRY) and end as 'dead' rows. The write path never waits for
 * recipients, preferences or mail.
 *
 * Per event and recipient: never the actor → member of the workspace → can see the page now →
 * nearest subscription level (kinds.ts `decide`) → hourly cap → one row per person (the highest
 * priority kind wins) → collapsed into an unread row with the same group key when there is one.
 * Rows that should ping are broadcast to the user's inbox channel; instant mail is scheduled.
 */

export interface Recipient {
  userId: string
  kind: NotifyKind
  reason: Reason
}

export interface NotifyInput {
  workspaceId: string
  /** null only for workspace-level items. */
  pageId: string | null
  actorId: string | null
  /** OAuth client name when the action came through an agent connection. */
  via: string | null
  recipients: Recipient[]
  /** Also reach everyone whose nearest subscription for the page is 'all', with this kind. */
  followers?: Extract<NotifyKind, 'comment' | 'page_update'>
  /** Users never notified by this event (e.g. people typing in the page right now). */
  exclude?: string[]
  commentId?: string | null
  threadId?: string | null
  anchor?: string | null
  excerpt?: string | null
}

/** Recipients of one event (a wall of mentions or a huge follower list is cut here). */
export const MAX_RECIPIENTS = 200
/** Per person and hour: beyond SOFT_CAP rows arrive quietly, beyond HARD_CAP they are dropped. */
export const SOFT_CAP_PER_HOUR = 60
export const HARD_CAP_PER_HOUR = 300
const EXCERPT_MAX = 200
/** Raw excerpt kept in the outbox payload (plainExcerpt reads at most this much). */
const EXCERPT_STORED = 4_000
/** Events per consumer transaction (each in its own savepoint). */
const NOTIFY_BATCH = 50
export const NOTIFY_RETRY: RetryPolicy = { baseMs: 1_000, factor: 2, capMs: 5 * 60_000, maxAttempts: 10 }

let log: (msg: string) => void = (m) => console.error(m)

export function initNotifications(logger: (msg: string) => void): void {
  log = logger
}

/** In-flight `notify()` inserts (flushNotifications waits for them). */
const inserting = new Set<Promise<void>>()

/** Queue an event right after the producer's write. Never throws, never blocks the caller. */
export function notify(input: NotifyInput): void {
  if (input.recipients.length === 0 && !input.followers) return
  const p: Promise<void> = enqueueNotify(db, input).catch((err) => log(`[notify] enqueue failed: ${String(err)}`))
  inserting.add(p)
  void p.finally(() => inserting.delete(p))
}

/** Queue an event in the caller's transaction (kicks the consumer itself when `exec` is `db`). */
export async function enqueueNotify(exec: Exec, input: NotifyInput, origin?: string | null): Promise<void> {
  if (input.recipients.length === 0 && !input.followers) return
  const payload: NotifyInput = {
    ...input,
    recipients: input.recipients.slice(0, MAX_RECIPIENTS),
    excerpt: input.excerpt ? input.excerpt.slice(0, EXCERPT_STORED) : (input.excerpt ?? null),
  }
  await enqueue(exec, [{ topic: 'notify', workspaceId: input.workspaceId, payload, origin }])
}

/** Fault injection for the crash tests: runs after a batch's writes, before its commit. */
export const notifyTestHooks: { beforeCommit?: () => void | Promise<void> } = {}

/**
 * One consumer pass: up to NOTIFY_BATCH due events in one transaction. Fast path without
 * savepoints; if an event fails, the pass is redone with a savepoint per event so only the
 * failing ones are retried (with backoff).
 */
export async function runNotifyBatch(): Promise<number> {
  try {
    return await notifyPass(false)
  } catch (err) {
    log(`[notify] batch failed, isolating events: ${String(err)}`)
    return notifyPass(true)
  }
}

async function notifyPass(isolate: boolean): Promise<number> {
  const written: Written[] = []
  const n = await db.transaction(async (tx) => {
    // Fast path claims by deleting (one statement); the delete commits only with the rows written.
    const claim = isolate
      ? sql`
          SELECT id::text AS id, payload, attempts FROM outbox
           WHERE topic = 'notify' AND state = 'pending' AND available_at <= now() AND ${ownedOrOrphaned()}
           ORDER BY outbox.id LIMIT ${NOTIFY_BATCH}
             FOR UPDATE SKIP LOCKED`
      : sql`
          DELETE FROM outbox WHERE id IN (
            SELECT id FROM outbox
             WHERE topic = 'notify' AND state = 'pending' AND available_at <= now() AND ${ownedOrOrphaned()}
             ORDER BY id LIMIT ${NOTIFY_BATCH}
               FOR UPDATE SKIP LOCKED)
          RETURNING id::text AS id, payload, attempts`
    const rows = ((await tx.execute(claim)) as unknown as { id: string; payload: NotifyInput; attempts: number }[])
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id))
    if (rows.length === 0) return 0
    if (!isolate) {
      for (const r of rows) written.push(...(await resolveAndWrite(r.payload, tx)).written)
      await notifyTestHooks.beforeCommit?.()
      return rows.length
    }
    const done: string[] = []
    for (const r of rows) {
      try {
        const res = await tx.transaction((sp) => resolveAndWrite(r.payload, sp))
        written.push(...res.written)
        done.push(r.id)
      } catch (err) {
        const s = await failRow(tx, 'notify', Number(r.id), r.attempts + 1, err, NOTIFY_RETRY)
        log(`[notify] event ${r.id} failed (${s}): ${String(err)}`)
      }
    }
    if (done.length) await tx.execute(sql`DELETE FROM outbox WHERE id = ANY(${`{${done.join(',')}}`}::bigint[])`)
    await notifyTestHooks.beforeCommit?.()
    return done.length
  })
  // After the commit: the client refetches and must see the rows.
  sideEffects(written)
  return n
}

registerOutboxHandler('notify', runNotifyBatch, NOTIFY_BATCH)

/**
 * Wait until every queued event has been processed (tests, shutdown, digest): in-flight inserts,
 * then the change log (it queues "page you follow changed"), then the notification rows.
 */
export async function flushNotifications(): Promise<void> {
  while (inserting.size) await Promise.allSettled([...inserting])
  await drainOutbox('change')
  await drainOutbox('notify')
}

export function plainExcerpt(s: string | null | undefined, max = EXCERPT_MAX): string | null {
  if (!s) return null
  const t = s
    .slice(0, 4000)
    .replace(/\[([^\]\n]{0,200})\]\([^)\s]{0,500}\)/g, '$1')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function groupKeyOf(kind: NotifyKind, ev: NotifyInput): string | null {
  switch (kind) {
    case 'doc_mention':
      return ev.pageId ? `dm:${ev.pageId}` : null
    case 'comment_mention':
      return ev.threadId ? `cm:${ev.threadId}` : null
    case 'comment_reply':
      return ev.threadId ? `cr:${ev.threadId}` : null
    case 'comment':
      return ev.threadId ? `c:${ev.threadId}` : null
    case 'task_assigned':
      return ev.pageId ? `ta:${ev.pageId}` : null
    case 'page_update':
      return ev.pageId ? `pu:${ev.pageId}` : null
    default:
      return null
  }
}

const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`

/** Nearest subscription level per user for a page (or the workspace), plus everyone at 'all'. */
async function levelsFor(
  exec: Exec,
  workspaceId: string,
  pageId: string | null,
  targets: string[],
  wantFollowers: boolean,
): Promise<Map<string, NotificationLevel>> {
  const rows = (pageId
    ? await exec.execute(sql`
        WITH RECURSIVE up AS (
          SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${pageId}
          UNION ALL
          SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
        ), cover AS (
          SELECT np.user_id, np.level, CASE WHEN np.root_page_id IS NULL THEN 100000 ELSE up.depth END AS d
            FROM notification_prefs np LEFT JOIN up ON up.id = np.root_page_id
           WHERE np.workspace_id = ${workspaceId}
             AND (np.root_page_id IS NULL OR (up.id IS NOT NULL AND (up.depth = 0 OR np.subtree)))
             AND (np.user_id = ANY(${uuidArray(targets)}) OR ${wantFollowers})
        )
        SELECT DISTINCT ON (user_id) user_id AS "userId", level FROM cover ORDER BY user_id, d
      `)
    : await exec.execute(sql`
        SELECT user_id AS "userId", level FROM notification_prefs
         WHERE workspace_id = ${workspaceId} AND root_page_id IS NULL AND user_id = ANY(${uuidArray(targets)})
      `)) as unknown as { userId: string; level: NotificationLevel }[]
  return new Map(rows.map((r) => [r.userId, r.level]))
}

/** Of `ids`, the members of the workspace that can see the page now (live page, live workspace). */
async function visibleRecipients(exec: Exec, workspaceId: string, pageId: string | null, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = (pageId
    ? await exec.execute(sql`
        SELECT m.user_id AS "userId" FROM workspace_members m JOIN pages p ON p.id = ${pageId}
         WHERE m.workspace_id = ${workspaceId} AND m.user_id = ANY(${uuidArray(ids)})
           AND p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL
           AND (p.scope = 'shared' OR p.created_by = m.user_id)
           AND ${liveWorkspace(sql`m.workspace_id`)}
      `)
    : await exec.execute(sql`
        SELECT m.user_id AS "userId" FROM workspace_members m
         WHERE m.workspace_id = ${workspaceId} AND m.user_id = ANY(${uuidArray(ids)})
           AND ${liveWorkspace(sql`m.workspace_id`)}
      `)) as unknown as { userId: string }[]
  return new Set(rows.map((r) => r.userId))
}

interface Settings {
  emailInstant: boolean
  emailDigest: 'off' | 'daily' | 'weekly'
}

async function settingsFor(exec: Exec, ids: string[]): Promise<Map<string, Settings>> {
  const rows = (await exec.execute(sql`
    SELECT user_id AS "userId", email_instant AS "emailInstant", email_digest AS "emailDigest"
      FROM user_notification_settings WHERE user_id = ANY(${uuidArray(ids)})
  `)) as unknown as ({ userId: string } & Settings)[]
  return new Map(rows.map((r) => [r.userId, { emailInstant: r.emailInstant, emailDigest: r.emailDigest }]))
}

export const DEFAULT_SETTINGS: Settings = { emailInstant: true, emailDigest: 'daily' }

async function hourlyCounts(exec: Exec, ids: string[]): Promise<Map<string, number>> {
  const rows = (await exec.execute(sql`
    SELECT user_id AS "userId", count(*)::int AS n FROM notifications
     WHERE user_id = ANY(${uuidArray(ids)}) AND created_at > now() - interval '1 hour'
     GROUP BY user_id
  `)) as unknown as { userId: string; n: number }[]
  return new Map(rows.map((r) => [r.userId, r.n]))
}

export interface ProcessResult {
  /** userId → delivery of the row written (inserted or collapsed). */
  delivered: Map<string, { kind: NotifyKind; delivery: 'now' | 'quiet' }>
}

interface Written {
  userId: string
  mailState: string | null
}

function sideEffects(written: Written[]): void {
  for (const r of written) {
    // Quiet rows are listed too: refresh the list, the badge count ignores them.
    broadcastToUser(r.userId, { t: 'notifications' })
    if (r.mailState === 'instant') scheduleInstantMail(r.userId)
  }
}

/** Resolve and write one event right away (tests; producers queue through `notify`). */
export async function processEvent(ev: NotifyInput): Promise<ProcessResult> {
  const res = await resolveAndWrite(ev, db)
  sideEffects(res.written)
  return { delivered: res.delivered }
}

/** Resolve one event and write its rows with `exec`; side effects are the caller's (after commit). */
async function resolveAndWrite(ev: NotifyInput, exec: Exec): Promise<ProcessResult & { written: Written[] }> {
  const delivered: ProcessResult['delivered'] = new Map()
  const written: Written[] = []
  const excluded = new Set([...(ev.exclude ?? []), ...(ev.actorId ? [ev.actorId] : [])])

  // One kind per person: the highest priority wins (a mention beats a reply beats a comment).
  const wanted = new Map<string, { kind: NotifyKind; reason: Reason }>()
  const offer = (userId: string, kind: NotifyKind, reason: Reason) => {
    if (excluded.has(userId)) return
    const cur = wanted.get(userId)
    if (!cur || KINDS[kind].priority > KINDS[cur.kind].priority) wanted.set(userId, { kind, reason })
  }
  for (const r of ev.recipients.slice(0, MAX_RECIPIENTS)) offer(r.userId, r.kind, r.reason)

  const targets = [...wanted.keys()]
  const levels = await levelsFor(exec, ev.workspaceId, ev.pageId, targets, !!ev.followers)
  if (ev.followers) {
    let n = 0
    for (const [userId, level] of levels) {
      if (level !== 'all' || wanted.has(userId)) continue
      if (++n > MAX_RECIPIENTS) break
      offer(userId, ev.followers, 'activity')
    }
  }
  if (wanted.size === 0) return { delivered, written }

  const ids = [...wanted.keys()]
  const [visible, settings, counts] = await Promise.all([
    visibleRecipients(exec, ev.workspaceId, ev.pageId, ids),
    settingsFor(exec, ids),
    hourlyCounts(exec, ids),
  ])
  const agent = !!ev.via
  const rows: Record<string, unknown>[] = []
  for (const [userId, w] of wanted) {
    if (!visible.has(userId)) continue
    const level = levels.get(userId) ?? 'mentions'
    const d = decide(w.kind, w.reason, level, agent)
    if (!d.deliver) continue
    const spec = KINDS[w.kind]
    const recent = counts.get(userId) ?? 0
    if (recent >= HARD_CAP_PER_HOUR && !spec.bypassMute) continue
    const delivery = recent >= SOFT_CAP_PER_HOUR && !spec.bypassMute ? 'quiet' : d.delivery
    const s = settings.get(userId) ?? DEFAULT_SETTINGS
    // Mail: direct items right away when allowed; the rest waits for the digest; "nothing" never mails.
    let mailState: 'instant' | 'digest' | null = null
    if (mailEnabled && level !== 'nothing') {
      if (delivery === 'now' && spec.instantMail && s.emailInstant) mailState = 'instant'
      else if (s.emailDigest !== 'off') mailState = 'digest'
    }
    rows.push({
      user_id: userId,
      type: w.kind,
      page_id: ev.pageId,
      workspace_id: ev.workspaceId,
      actor_id: ev.actorId,
      comment_id: ev.commentId ?? null,
      via_client: ev.via ? ev.via.slice(0, 100) : null,
      delivery,
      mail_state: mailState,
      group_key: groupKeyOf(w.kind, ev),
      excerpt: plainExcerpt(ev.excerpt),
      anchor: ev.anchor ? ev.anchor.slice(0, 200) : null,
    })
  }
  if (!rows.length) return { delivered, written }

  const out = (await exec.execute(sql`
    INSERT INTO notifications (user_id, type, page_id, workspace_id, actor_id, comment_id, via_client, delivery, mail_state, group_key, excerpt, anchor)
    SELECT x.user_id, x.type, x.page_id, x.workspace_id, x.actor_id, x.comment_id, x.via_client, x.delivery, x.mail_state, x.group_key, x.excerpt, x.anchor
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        user_id uuid, type text, page_id uuid, workspace_id uuid, actor_id uuid, comment_id uuid, via_client text,
        delivery text, mail_state text, group_key text, excerpt text, anchor text)
    ON CONFLICT (user_id, group_key) WHERE read = '0' AND group_key IS NOT NULL
    DO UPDATE SET
      count = notifications.count + 1,
      created_at = now(),
      seq = nextval(pg_get_serial_sequence('notifications', 'seq')),
      actor_id = EXCLUDED.actor_id,
      via_client = EXCLUDED.via_client,
      comment_id = coalesce(EXCLUDED.comment_id, notifications.comment_id),
      excerpt = coalesce(EXCLUDED.excerpt, notifications.excerpt),
      anchor = coalesce(EXCLUDED.anchor, notifications.anchor),
      delivery = CASE WHEN notifications.delivery = 'now' OR EXCLUDED.delivery = 'now' THEN 'now' ELSE 'quiet' END,
      mail_state = CASE
        WHEN EXCLUDED.mail_state = 'instant' OR notifications.mail_state = 'instant' THEN 'instant'
        WHEN EXCLUDED.mail_state = 'digest' OR notifications.mail_state = 'digest' THEN 'digest'
        ELSE notifications.mail_state END,
      acked_at = NULL
    RETURNING user_id AS "userId", type, delivery, mail_state AS "mailState"
  `)) as unknown as { userId: string; type: NotifyKind; delivery: 'now' | 'quiet'; mailState: string | null }[]

  for (const r of out) {
    delivered.set(r.userId, { kind: r.type, delivery: r.delivery })
    written.push({ userId: r.userId, mailState: r.mailState })
  }
  return { delivered, written }
}
