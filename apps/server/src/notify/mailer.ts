import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { mailEnabled } from '../env'
import { resolveLocale, type Locale } from '../i18n'
import { appOrigin, compose, sendMail } from '../mail'
import type { MailContent } from '../mail'
import { liveWorkspace } from '../workspaceLive'
import { twoFactorBlockedSql } from '../twoFactorPolicy'

/**
 * Notification mail (docs/adr/1004-*).
 *
 *  - Instant: direct items (mentions, replies, assignments) are mailed a short while after they
 *    arrive, batched per person, and only if still unread and still visible at send time — reading
 *    the item in the app first cancels the mail.
 *  - Digest: everything waiting with mail_state 'digest' (quiet items, followed-page activity, AI
 *    summaries, direct items of people who turned instant mail off), once a day or once a week.
 *
 * Privacy: a mail carries the page title, who did it and a short plain excerpt (≤ 200 characters
 * of a comment or the mentioning line), never page bodies. Links use APP_URL/PUBLIC_URL only
 * (origin.ts). Without SMTP nothing is queued for mail and everything stays in the app.
 */

let log: (msg: string) => void = (m) => console.error(m)
export function initNotificationMail(logger: (msg: string) => void): void {
  log = logger
}

/** Delay before an instant mail goes out (batches a burst; reading in-app first cancels it). */
function instantDelayMs(): number {
  const v = Number(process.env.NOTIFY_MAIL_DELAY_MS)
  return Number.isFinite(v) && v >= 0 ? v : 120_000
}

const timers = new Map<string, NodeJS.Timeout>()
const inflight = new Map<string, Promise<number>>()

export function scheduleInstantMail(userId: string): void {
  if (!mailEnabled || timers.has(userId)) return
  const t = setTimeout(() => {
    timers.delete(userId)
    void sendInstantMails(userId).catch((err) => log(`[notify] instant mail failed: ${String(err)}`))
  }, instantDelayMs())
  t.unref?.()
  timers.set(userId, t)
}

/** Cancel pending timers (shutdown, tests). */
export function clearMailTimers(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

interface Recipient {
  id: string
  email: string
  name: string
  locale: Locale
}

async function recipient(userId: string): Promise<Recipient | null> {
  const rows = (await db.execute(sql`
    SELECT id, email, name, locale FROM users
     WHERE id = ${userId} AND NOT (must_verify_email AND email_verified_at IS NULL)
  `)) as unknown as { id: string; email: string; name: string; locale: string | null }[]
  const r = rows[0]
  return r ? { id: r.id, email: r.email, name: r.name, locale: resolveLocale(r.locale) } : null
}

export interface MailItem {
  id: string
  seq: number
  type: string
  pageId: string | null
  workspaceId: string | null
  title: string | null
  actor: string | null
  via: string | null
  excerpt: string | null
  count: number
  ok: boolean
}

/**
 * Pending rows of one user in one mail state, with the send-time visibility check. An item of a
 * workspace whose two-step verification requirement blocks the user is not ok: it is dropped from
 * mail like an item that is no longer visible and stays in the app (docs/adr/1300-*).
 */
async function pending(userId: string, state: 'instant' | 'digest', limit: number): Promise<MailItem[]> {
  const rows = (await db.execute(sql`
    SELECT n.id, n.seq::text AS seq, n.type, n.page_id AS "pageId", coalesce(n.workspace_id, p.workspace_id) AS "workspaceId",
           p.title, a.name AS actor, n.via_client AS via, n.excerpt, n.count,
           (${state === 'instant' ? sql`n.read = '0' AND` : sql``}
             (n.page_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL
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
     WHERE n.user_id = ${userId} AND n.mail_state = ${state}
     ORDER BY n.seq
     LIMIT ${limit}
  `)) as unknown as (Omit<MailItem, 'seq'> & { seq: string })[]
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }))
}

async function settle(ids: string[], state: 'sent' | null): Promise<void> {
  if (!ids.length) return
  await db.execute(sql`UPDATE notifications SET mail_state = ${state} WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])`)
}

const PHRASES: Record<Locale, Record<string, (a: string, t: string) => string>> = {
  en: {
    doc_mention: (a, t) => `${a} mentioned you in "${t}"`,
    comment_mention: (a, t) => `${a} mentioned you in a comment on "${t}"`,
    comment_reply: (a, t) => `${a} replied in a thread on "${t}"`,
    comment: (a, t) => `${a} commented on "${t}"`,
    page_owner: (a, t) => `${a} made you the owner of "${t}"`,
    task_assigned: (a, t) => `${a} assigned you "${t}"`,
    page_update: (a, t) => `${a} edited "${t}"`,
    agent_digest: (_a, t) => `AI edits under "${t}"`,
    approval_request: (a, t) => `${a} asks for your approval on "${t}"`,
    approval_result: (a, t) => `${a} decided on your request on "${t}"`,
    reminder: (_a, t) => `Due today: "${t}"`,
  },
  ko: {
    doc_mention: (a, t) => `${a}님이 "${t}"에서 회원님을 멘션했습니다`,
    comment_mention: (a, t) => `${a}님이 "${t}" 댓글에서 회원님을 멘션했습니다`,
    comment_reply: (a, t) => `${a}님이 "${t}"의 스레드에 답글을 남겼습니다`,
    comment: (a, t) => `${a}님이 "${t}"에 댓글을 남겼습니다`,
    page_owner: (a, t) => `${a}님이 회원님을 "${t}"의 담당자로 지정했습니다`,
    task_assigned: (a, t) => `${a}님이 "${t}"을(를) 회원님에게 배정했습니다`,
    page_update: (a, t) => `${a}님이 "${t}"을(를) 수정했습니다`,
    agent_digest: (_a, t) => `"${t}" 아래의 AI 수정`,
    approval_request: (a, t) => `${a}님이 "${t}"에 대한 승인을 요청했습니다`,
    approval_result: (a, t) => `${a}님이 "${t}" 요청에 대해 결정했습니다`,
    reminder: (_a, t) => `오늘 마감: "${t}"`,
  },
}

const WORDS = {
  en: { someone: 'Someone', untitled: 'Untitled', workspace: 'the workspace', via: 'via', times: (n: number) => ` (${n}×)` },
  ko: { someone: '누군가', untitled: '제목 없음', workspace: '워크스페이스', via: '경유', times: (n: number) => ` (${n}회)` },
}

export function describeItem(i: Pick<MailItem, 'type' | 'actor' | 'via' | 'title' | 'count' | 'pageId'>, L: Locale): string {
  const w = WORDS[L]
  const actor = i.actor ? (i.via ? (L === 'ko' ? `${i.actor}(${i.via} ${w.via})` : `${i.actor} via ${i.via}`) : i.actor) : i.via ? i.via : w.someone
  const title = i.pageId ? (i.title?.trim() || w.untitled) : w.workspace
  const f = PHRASES[L][i.type] ?? PHRASES[L].comment
  return f(actor, title) + (i.count > 1 ? w.times(i.count) : '')
}

function itemLink(origin: string, i: MailItem): string {
  if (i.pageId && i.workspaceId) return `${origin}/w/${i.workspaceId}/p/${i.pageId}`
  if (i.workspaceId) return `${origin}/w/${i.workspaceId}`
  return `${origin}/`
}

const TEXT = {
  en: {
    instantSubject1: (s: string) => `[Inkling] ${s}`,
    instantSubjectN: (n: number) => `[Inkling] ${n} new notifications`,
    open: 'Open in Inkling',
    instantFooter: 'You get this because instant notification mail is on. Change it in Settings → Notifications.',
    digestSubject: (n: number, weekly: boolean) => `[Inkling] ${weekly ? 'Weekly' : 'Daily'} summary: ${n} update${n === 1 ? '' : 's'}`,
    digestIntro: (name: string) => `Hi ${name}, here is what happened since your last summary.`,
    more: (n: number) => `…and ${n} more in the app.`,
    digestFooter: 'You get this summary because it is on in Settings → Notifications (daily or weekly, or off).',
  },
  ko: {
    instantSubject1: (s: string) => `[Inkling] ${s}`,
    instantSubjectN: (n: number) => `[Inkling] 새 알림 ${n}건`,
    open: 'Inkling에서 열기',
    instantFooter: '즉시 알림 메일이 켜져 있어서 보내는 메일입니다. 설정 → 알림에서 바꿀 수 있습니다.',
    digestSubject: (n: number, weekly: boolean) => `[Inkling] ${weekly ? '주간' : '일일'} 요약: 업데이트 ${n}건`,
    digestIntro: (name: string) => `${name}님, 지난 요약 이후 있었던 일입니다.`,
    more: (n: number) => `…그 밖에 ${n}건은 앱에서 확인하세요.`,
    digestFooter: '설정 → 알림에서 켠 요약 메일입니다(매일·매주·끄기).',
  },
}

export function instantMail(r: Recipient, items: MailItem[], origin: string): MailContent {
  const L = r.locale
  const t = TEXT[L]
  const lines: string[] = []
  for (const i of items.slice(0, 10)) {
    lines.push(describeItem(i, L))
    if (i.excerpt) lines.push(`“${i.excerpt}”`)
  }
  if (items.length > 10) lines.push(t.more(items.length - 10))
  const subject = items.length === 1 ? t.instantSubject1(describeItem(items[0], L)) : t.instantSubjectN(items.length)
  return compose({ subject: subject.slice(0, 200), lines, link: { label: t.open, url: itemLink(origin, items[0]) }, footer: t.instantFooter })
}

export function digestMail(r: Recipient, items: MailItem[], total: number, weekly: boolean, origin: string): MailContent {
  const L = r.locale
  const t = TEXT[L]
  const lines = [t.digestIntro(r.name)]
  for (const i of items) lines.push(`• ${describeItem(i, L)}${i.excerpt ? ` — ${i.excerpt}` : ''}`)
  if (total > items.length) lines.push(t.more(total - items.length))
  return compose({ subject: t.digestSubject(total, weekly), lines, link: { label: t.open, url: `${origin}/` }, footer: t.digestFooter })
}

/** Send one user's pending instant items as one mail. Returns the number of items mailed. */
export function sendInstantMails(userId: string): Promise<number> {
  const cur = inflight.get(userId)
  if (cur) return cur.then(() => sendInstantMails(userId))
  const job = (async () => {
    if (!mailEnabled) return 0
    const items = await pending(userId, 'instant', 50)
    if (!items.length) return 0
    const ok = items.filter((i) => i.ok)
    const r = ok.length ? await recipient(userId) : null
    if (!r || !ok.length) {
      await settle(items.map((i) => i.id), null)
      return 0
    }
    // Claim first so a concurrent sweep cannot mail the same rows twice; a failed send moves them to the digest.
    await settle(ok.map((i) => i.id), 'sent')
    await settle(items.filter((i) => !i.ok).map((i) => i.id), null)
    try {
      await sendMail(r.email, instantMail(r, ok, appOrigin()), log)
    } catch {
      await db.execute(sql`UPDATE notifications SET mail_state = 'digest' WHERE id = ANY(${`{${ok.map((i) => i.id).join(',')}}`}::uuid[])`)
      return 0
    }
    return ok.length
  })()
  inflight.set(userId, job)
  void job.finally(() => {
    if (inflight.get(userId) === job) inflight.delete(userId)
  }).catch(() => {})
  return job
}

/** Housekeeping: instant items whose timer was lost (restart) are sent after the delay passed. */
export async function sweepInstantMails(now = new Date()): Promise<number> {
  if (!mailEnabled) return 0
  const rows = (await db.execute(sql`
    SELECT DISTINCT user_id AS "userId" FROM notifications
     WHERE mail_state = 'instant' AND created_at < ${now.toISOString()}::timestamptz - make_interval(secs => ${instantDelayMs() / 1000})
     LIMIT 500
  `)) as unknown as { userId: string }[]
  let n = 0
  for (const r of rows) n += await sendInstantMails(r.userId)
  return n
}

const DIGEST_LISTED = 25
/** Local hour from which daily/weekly digests go out. */
const DIGEST_HOUR = 8

/**
 * Digest mail for every user who is due (housekeeping, hourly). `force` ignores the hour gate and
 * the interval (tests, manual runs).
 */
export async function runMailDigests(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  if (!mailEnabled) return 0
  if (!opts.force && now.getHours() < DIGEST_HOUR) return 0
  const iso = now.toISOString()
  const due = (await db.execute(sql`
    SELECT u.id, coalesce(s.email_digest, 'daily') AS mode
      FROM users u LEFT JOIN user_notification_settings s ON s.user_id = u.id
     WHERE EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.mail_state = 'digest')
       AND coalesce(s.email_digest, 'daily') <> 'off'
       AND (${!!opts.force}::boolean OR s.digest_sent_at IS NULL OR s.digest_sent_at < ${iso}::timestamptz -
            CASE WHEN s.email_digest = 'weekly' THEN interval '167 hours' ELSE interval '23 hours' END)
     LIMIT 200
  `)) as unknown as { id: string; mode: string }[]
  let mails = 0
  for (const u of due) {
    try {
      const items = await pending(u.id, 'digest', 500)
      const ok = items.filter((i) => i.ok)
      await settle(items.filter((i) => !i.ok).map((i) => i.id), null)
      if (!ok.length) continue
      const r = await recipient(u.id)
      if (!r) {
        await settle(ok.map((i) => i.id), null)
        continue
      }
      await settle(ok.map((i) => i.id), 'sent')
      await db.execute(sql`
        INSERT INTO user_notification_settings (user_id, digest_sent_at) VALUES (${u.id}, ${iso}::timestamptz)
        ON CONFLICT (user_id) DO UPDATE SET digest_sent_at = EXCLUDED.digest_sent_at
      `)
      try {
        await sendMail(r.email, digestMail(r, ok.slice(0, DIGEST_LISTED), ok.length, u.mode === 'weekly', appOrigin()), log)
        mails++
      } catch {
        await db.execute(sql`UPDATE notifications SET mail_state = 'digest' WHERE id = ANY(${`{${ok.map((i) => i.id).join(',')}}`}::uuid[])`)
      }
    } catch (err) {
      log(`[notify] digest failed for a user: ${String(err)}`)
    }
  }
  return mails
}
