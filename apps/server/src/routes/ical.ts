/**
 * iCal subscription feed (docs/adr/0303-ical-subscription-token.md, 0304-ical-feed-format.md).
 *
 *   GET    /api/me/ical          token status (never returns the token)
 *   POST   /api/me/ical          issue / regenerate → returns the feed URL once
 *   DELETE /api/me/ical          revoke
 *   GET    /ical/<token>.ics     the feed (no session — the unguessable token is the credential)
 *
 * The feed contains every dated item the user can see in every workspace they belong to:
 * collection date properties, page date properties, daily notes and dated tasks — the same
 * module (collectDateItems) and the same visibility rules (visibleTo) as the in-app calendar.
 */
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DateItemDTO, IcalIssueDTO, IcalStatusDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { icalTokens, workspaceMembers, workspaces } from '../db/schema'
import { twoFactorBlockedSql } from '../twoFactorPolicy'
import { collectDateItems } from '../md/dateItems'
import { publicOrigin } from '../oauth'

const TOKEN_RE = /^([A-Za-z0-9_-]{43})\.ics$/
const PAST_DAYS = 90
const FUTURE_DAYS = 400
/** lastUsedAt is refreshed at most this often (calendar clients poll frequently) */
const TOUCH_MS = 60 * 60 * 1000

export function hashIcalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ---------------------------------------------------------------------------
// RFC 5545 helpers
// ---------------------------------------------------------------------------

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Fold a content line at 75 octets (RFC 5545 §3.1). Splits on code-point boundaries so a
 * multi-byte UTF-8 character is never cut; continuation lines start with one space.
 */
export function icsFold(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  let limit = 75
  for (const ch of line) {
    const b = enc.encode(ch).length
    if (curBytes + b > limit) {
      out.push(cur)
      cur = ''
      curBytes = 0
      limit = 74 // the leading space of a continuation line counts as one octet
    }
    cur += ch
    curBytes += b
  }
  if (cur) out.push(cur)
  return out.join('\r\n ')
}

function ymd(date: string): string {
  return date.replace(/-/g, '')
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function dayOffset(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const KIND_LABEL: Record<DateItemDTO['kind'], string> = {
  row: 'Database',
  page: 'Page date',
  daily: 'Daily note',
  task: 'Task',
}

/** Stable UID: independent of the date so moving an item updates the same event. */
export function icsUid(item: DateItemDTO, host: string): string {
  const part = item.kind === 'task' ? item.blockId ?? '' : item.fieldId ?? ''
  return `${item.kind}-${item.pageId}${part ? `-${part}` : ''}@${host}`
}

export function buildCalendar(
  items: (DateItemDTO & { workspaceId: string; workspaceName: string })[],
  origin: string,
  dtstamp: string,
): string {
  const host = (() => {
    try {
      return new URL(origin).hostname || 'inkling'
    } catch {
      return 'inkling'
    }
  })()
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inkling//Calendar feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Inkling',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ]
  const seen = new Set<string>()
  for (const it of items) {
    const uid = icsUid(it, host)
    if (seen.has(uid)) continue // one event per (item, field) — first date wins
    seen.add(uid)
    const summary = `${it.done ? '✓ ' : ''}${it.title || 'Untitled'}`
    const context = [KIND_LABEL[it.kind], it.collectionTitle, it.pageTitle, it.parentPath, it.workspaceName]
      .filter(Boolean)
      .join(' · ')
    const url = `${origin}/w/${it.workspaceId}/p/${it.pageId}`
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd(it.date)}`,
      `DTEND;VALUE=DATE:${nextDay(it.date)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(`${context}\n${url}`)}`,
      `URL:${url}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(icsFold).join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function statusOf(row: { createdAt: Date; lastUsedAt: Date | null } | undefined): IcalStatusDTO {
  return {
    active: !!row,
    createdAt: row ? row.createdAt.toISOString() : null,
    lastUsedAt: row?.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  }
}

/** Token management — registered inside the /api prefix. */
export async function registerIcalApiRoutes(api: FastifyInstance): Promise<void> {
  api.get('/me/ical', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const row = (await db.select().from(icalTokens).where(eq(icalTokens.userId, user.id)).limit(1))[0]
    return { ical: statusOf(row) }
  })

  api.post('/me/ical', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const token = randomBytes(32).toString('base64url') // 43 chars, 256 bits
    const values = { tokenHash: hashIcalToken(token), createdAt: new Date(), lastUsedAt: null }
    await db
      .insert(icalTokens)
      .values({ userId: user.id, ...values })
      .onConflictDoUpdate({ target: icalTokens.userId, set: values })
    const out: IcalIssueDTO = {
      ...statusOf({ createdAt: values.createdAt, lastUsedAt: null }),
      url: `${publicOrigin(req)}/ical/${token}.ics`,
    }
    return { ical: out }
  })

  api.delete('/me/ical', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    await db.delete(icalTokens).where(eq(icalTokens.userId, user.id))
    return reply.code(204).send()
  })
}

/** The feed itself — registered at the root (outside /api). */
export async function registerIcalFeedRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/ical/:file',
    {
      // Unauthenticated endpoint: keep it cheap to refuse. The global limiter skips non-/api GETs,
      // so this route sets its own limit.
      config: { rateLimit: { max: 30, timeWindow: '1 minute', allowList: () => false } },
    },
    async (req, reply) => {
      const file = String((req.params as { file?: string }).file ?? '')
      const m = TOKEN_RE.exec(file)
      const notFound = () =>
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Calendar feed not found' } })
      if (!m) return notFound()
      const row = (
        await db.select().from(icalTokens).where(eq(icalTokens.tokenHash, hashIcalToken(m[1]))).limit(1)
      )[0]
      if (!row) return notFound()
      const userId = row.userId

      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_MS) {
        await db.update(icalTokens).set({ lastUsedAt: new Date() }).where(eq(icalTokens.userId, userId))
      }

      const memberships = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            isNull(workspaces.deletedAt),
            // the feed leaves out workspaces whose 2FA requirement blocks the user (docs/adr/1112-*)
            sql`not ${twoFactorBlockedSql(workspaces.id, userId)}`,
          ),
        )
      const from = dayOffset(-PAST_DAYS)
      const to = dayOffset(FUTURE_DAYS)
      const items: (DateItemDTO & { workspaceId: string; workspaceName: string })[] = []
      for (const ws of memberships) {
        const list = await collectDateItems(ws.id, userId, { from, to, rowFields: 'all' })
        for (const it of list) items.push({ ...it, workspaceId: ws.id, workspaceName: ws.name })
      }
      items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

      // DTSTAMP = start of the current UTC day → the body (and ETag) only changes with content.
      const dtstamp = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}T000000Z`
      const body = buildCalendar(items, publicOrigin(req), dtstamp)
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`

      reply
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', etag)
        .header('X-Robots-Tag', 'noindex')
        .header('Referrer-Policy', 'no-referrer')
      const inm = req.headers['if-none-match']
      if (inm && inm.split(',').some((t) => t.trim() === etag)) return reply.code(304).send()
      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'inline; filename="inkling.ics"')
        .send(body)
    },
  )
}
