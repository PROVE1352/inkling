import { sql } from 'drizzle-orm'
import type { NotificationLevel } from '@inkling/shared'
import { broadcastToUser } from '../collab'
import { db } from '../db/index'
import { mailEnabled } from '../env'
import { liveWorkspace } from '../workspaceLive'
import { decide, KINDS } from './kinds'
import type { NotifyKind, Reason } from './kinds'
import { scheduleInstantMail } from './mailer'

/**
 * Notification engine (docs/adr/1000-*).
 *
 * Producers (comments, owner and person-cell assignment, the document indexer for @mentions, the
 * change log for followed pages) call `notify()` AFTER their write committed. The call only queues:
 * events are resolved in the background, one at a time, a handful of set-based statements each
 * (no per-recipient queries), so the write path never waits for recipients, preferences or mail.
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
const MAX_QUEUE = 5_000
const EXCERPT_MAX = 200

const queue: NotifyInput[] = []
let draining: Promise<void> | null = null
let log: (msg: string) => void = (m) => console.error(m)

export function initNotifications(logger: (msg: string) => void): void {
  log = logger
}

/** Queue an event. Never throws, never blocks the caller. */
export function notify(input: NotifyInput): void {
  if (input.recipients.length === 0 && !input.followers) return
  if (queue.length >= MAX_QUEUE) {
    queue.shift()
    log('[notify] queue full: dropped the oldest event')
  }
  queue.push(input)
  if (!draining) draining = new Promise<void>((r) => setImmediate(r)).then(drain)
}

async function drain(): Promise<void> {
  try {
    while (queue.length) {
      const ev = queue.shift()!
      try {
        await processEvent(ev)
      } catch (err) {
        log(`[notify] event failed: ${String(err)}`)
      }
    }
  } finally {
    draining = null
  }
}

/** Wait until every queued event has been processed (tests, shutdown). */
export async function flushNotifications(): Promise<void> {
  while (draining) await draining
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
  workspaceId: string,
  pageId: string | null,
  targets: string[],
  wantFollowers: boolean,
): Promise<Map<string, NotificationLevel>> {
  const rows = (pageId
    ? await db.execute(sql`
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
    : await db.execute(sql`
        SELECT user_id AS "userId", level FROM notification_prefs
         WHERE workspace_id = ${workspaceId} AND root_page_id IS NULL AND user_id = ANY(${uuidArray(targets)})
      `)) as unknown as { userId: string; level: NotificationLevel }[]
  return new Map(rows.map((r) => [r.userId, r.level]))
}

/** Of `ids`, the members of the workspace that can see the page now (live page, live workspace). */
async function visibleRecipients(workspaceId: string, pageId: string | null, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const rows = (pageId
    ? await db.execute(sql`
        SELECT m.user_id AS "userId" FROM workspace_members m JOIN pages p ON p.id = ${pageId}
         WHERE m.workspace_id = ${workspaceId} AND m.user_id = ANY(${uuidArray(ids)})
           AND p.workspace_id = ${workspaceId} AND p.deleted_at IS NULL
           AND (p.scope = 'shared' OR p.created_by = m.user_id)
           AND ${liveWorkspace(sql`m.workspace_id`)}
      `)
    : await db.execute(sql`
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

async function settingsFor(ids: string[]): Promise<Map<string, Settings>> {
  const rows = (await db.execute(sql`
    SELECT user_id AS "userId", email_instant AS "emailInstant", email_digest AS "emailDigest"
      FROM user_notification_settings WHERE user_id = ANY(${uuidArray(ids)})
  `)) as unknown as ({ userId: string } & Settings)[]
  return new Map(rows.map((r) => [r.userId, { emailInstant: r.emailInstant, emailDigest: r.emailDigest }]))
}

export const DEFAULT_SETTINGS: Settings = { emailInstant: true, emailDigest: 'daily' }

async function hourlyCounts(ids: string[]): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
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

/** Resolve and write one event (exported for tests; producers call `notify`). */
export async function processEvent(ev: NotifyInput): Promise<ProcessResult> {
  const delivered: ProcessResult['delivered'] = new Map()
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
  const levels = await levelsFor(ev.workspaceId, ev.pageId, targets, !!ev.followers)
  if (ev.followers) {
    let n = 0
    for (const [userId, level] of levels) {
      if (level !== 'all' || wanted.has(userId)) continue
      if (++n > MAX_RECIPIENTS) break
      offer(userId, ev.followers, 'activity')
    }
  }
  if (wanted.size === 0) return { delivered }

  const ids = [...wanted.keys()]
  const [visible, settings, counts] = await Promise.all([
    visibleRecipients(ev.workspaceId, ev.pageId, ids),
    settingsFor(ids),
    hourlyCounts(ids),
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
  if (!rows.length) return { delivered }

  const written = (await db.execute(sql`
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

  for (const r of written) {
    delivered.set(r.userId, { kind: r.type, delivery: r.delivery })
    // Quiet rows are listed too: refresh the list, the badge count ignores them.
    broadcastToUser(r.userId, { t: 'notifications' })
    if (r.mailState === 'instant') scheduleInstantMail(r.userId)
  }
  return { delivered }
}
