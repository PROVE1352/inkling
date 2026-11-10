import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { cachedFindContext } from '../context/contextCache'
import { memberWorkspaceIds } from '../context/retrieve'
import { db } from '../db/index'
import { slackIntegrations, slackLinkCodes, slackUserLinks } from '../db/schema'
import { localeOfUser, resolveLocale } from '../i18n'
import type { Locale } from '../i18n'
import { liveWorkspace } from '../workspaceLive'
import { slackApi } from './api'
import type { SlackUserInfo } from './api'
import { botTokenOf, configuredOrigin, invalidateSlackCache, loadIntegration, pageLink, signingSecretOf } from './config'
import type { IntegrationRow } from './config'
import { esc, linkOr, slackText } from './messages'
import { enqueueSlack } from './notify'
import type { SlackUnfurlJob } from './notify'
import { replayKey, verifySlackSignature } from './signature'

/**
 * Requests from Slack (docs/adr/1803-*, 1804-*, 1805-*): the `/inkling` slash command and the Events
 * API (link unfurls, uninstall). Every request is checked in this order before anything is read
 * from it: integration of the URL's workspace exists, is live and its signing secret can be read →
 * v0 signature over the raw body with a 5-minute timestamp window → the team in the body is the
 * team the token belongs to → the signature was not seen before (replay). Failures answer 401 with
 * no detail.
 */

export const LINK_CODE_TTL_MS = 10 * 60_000
const SEARCH_BUDGET = 1_500
const SEARCH_RESULTS = 5
const SNIPPET_MAX = 200

export type Inbound = { ok: true; integ: IntegrationRow } | { ok: false; status: 401 | 404 }

/** Insert a nonce; false when it was there already (a replay or a retried event). */
export async function claimNonce(nonce: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    INSERT INTO slack_request_nonces (nonce) VALUES (${nonce}) ON CONFLICT (nonce) DO NOTHING RETURNING nonce
  `)) as unknown as unknown[]
  return rows.length > 0
}

/** Signature, team and replay checks of one request to `/api/slack/w/:workspaceId/…`. */
export async function acceptSlackRequest(
  workspaceId: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  teamId: string | undefined,
): Promise<Inbound> {
  const [live] = await db
    .select({ id: slackIntegrations.workspaceId })
    .from(slackIntegrations)
    .where(and(eq(slackIntegrations.workspaceId, workspaceId), liveWorkspace(slackIntegrations.workspaceId)))
    .limit(1)
  const integ = live ? await loadIntegration(workspaceId) : null
  if (!integ) return { ok: false, status: 401 }
  const secret = signingSecretOf(integ)
  if (!secret) return { ok: false, status: 401 }
  if (!verifySlackSignature(secret, timestamp, signature, rawBody).ok) return { ok: false, status: 401 }
  if (!teamId || teamId !== integ.teamId) return { ok: false, status: 401 }
  if (!(await claimNonce(replayKey(timestamp!, signature!)))) return { ok: false, status: 401 }
  return { ok: true, integ }
}

// ---------------------------------------------------------------------------
// Slack user → Inkling member
// ---------------------------------------------------------------------------

export type Resolved = { kind: 'member'; userId: string } | { kind: 'unlinked' } | { kind: 'not_member'; userId: string }

async function isMember(userId: string, workspaceId: string): Promise<boolean> {
  // Same list find_context searches: live workspaces, not blocked by a 2FA requirement; guests are not members.
  return (await memberWorkspaceIds(userId)).includes(workspaceId)
}

/**
 * The Inkling member behind a Slack user: an explicit link, else a remembered or new email match
 * (Slack says the address is confirmed, the Inkling account with that address is a member).
 */
export async function resolveSlackUser(integ: IntegrationRow, slackUserId: string): Promise<Resolved> {
  const [link] = await db
    .select({ userId: slackUserLinks.userId })
    .from(slackUserLinks)
    .where(and(eq(slackUserLinks.workspaceId, integ.workspaceId), eq(slackUserLinks.teamId, integ.teamId), eq(slackUserLinks.slackUserId, slackUserId)))
    .limit(1)
  if (link) return (await isMember(link.userId, integ.workspaceId)) ? { kind: 'member', userId: link.userId } : { kind: 'not_member', userId: link.userId }
  const token = botTokenOf(integ)
  if (!token) return { kind: 'unlinked' }
  const info = await slackApi<SlackUserInfo>('users.info', token, { user: slackUserId }, { timeoutMs: 1_500 })
  if (!info.ok) return { kind: 'unlinked' }
  const u = info.data.user
  const email = u?.profile?.email?.trim().toLowerCase()
  if (!u || u.id !== slackUserId || u.deleted || u.is_bot || u.is_email_confirmed === false || !email) return { kind: 'unlinked' }
  const rows = (await db.execute(sql`
    SELECT u.id FROM users u JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ${integ.workspaceId}
     WHERE lower(u.email) = ${email}
     LIMIT 2
  `)) as unknown as { id: string }[]
  if (rows.length !== 1) return { kind: 'unlinked' }
  const userId = rows[0].id
  if (!(await isMember(userId, integ.workspaceId))) return { kind: 'not_member', userId }
  // Remember the match (an Inkling account already linked to another Slack user keeps that link).
  await db
    .insert(slackUserLinks)
    .values({ workspaceId: integ.workspaceId, teamId: integ.teamId, slackUserId, userId, method: 'email' })
    .onConflictDoNothing()
  return { kind: 'member', userId }
}

// ---------------------------------------------------------------------------
// /inkling
// ---------------------------------------------------------------------------

export interface SlashReply {
  response_type: 'ephemeral'
  text: string
}

const reply = (text: string): SlashReply => ({ response_type: 'ephemeral', text })

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * Answer one slash command (already verified). Every answer is ephemeral: only the person who typed
 * it sees it. Results are what that person's Inkling account may read (find_context with their id).
 */
export async function handleSlashCommand(integ: IntegrationRow, form: Record<string, string>, fallbackOrigin: string): Promise<SlashReply> {
  const slackUserId = form.user_id ?? ''
  const text = (form.text ?? '').trim()
  const base = slackText(resolveLocale(null))
  if (integ.enabled !== '1') return reply(base.disabled)
  if (!/^[UW][A-Z0-9]{2,30}$/.test(slackUserId)) return reply(base.notLinked)
  const word = text.toLowerCase()
  // help needs no account
  if (!text || word === 'help') return reply(base.help)

  if (word === 'link') {
    const origin = configuredOrigin() ?? fallbackOrigin
    if (!origin) return reply(base.linkNoOrigin)
    const code = randomBytes(24).toString('base64url')
    await db.insert(slackLinkCodes).values({
      codeHash: hashLinkCode(code),
      workspaceId: integ.workspaceId,
      teamId: integ.teamId,
      slackUserId,
      expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
    })
    // The code rides in the fragment: browsers never send it to the server, so it reaches no access log.
    return reply(base.linkCode(`${origin}/slack/link#code=${code}`))
  }
  if (word === 'unlink') {
    const gone = await db
      .delete(slackUserLinks)
      .where(and(eq(slackUserLinks.workspaceId, integ.workspaceId), eq(slackUserLinks.teamId, integ.teamId), eq(slackUserLinks.slackUserId, slackUserId)))
      .returning({ userId: slackUserLinks.userId })
    return reply(gone.length ? base.unlinked : base.nothingToUnlink)
  }

  const who = await resolveSlackUser(integ, slackUserId)
  if (who.kind === 'unlinked') return reply(base.notLinked)
  const t = slackText(await localeOfUser(who.userId))
  if (who.kind === 'not_member') return reply(t.notMember)
  return reply(await searchAnswer(t, who.userId, integ.workspaceId, text.slice(0, 300)))
}

async function searchAnswer(t: ReturnType<typeof slackText>, userId: string, workspaceId: string, query: string): Promise<string> {
  try {
    const r = await cachedFindContext(userId, query, workspaceId, SEARCH_BUDGET)
    const origin = configuredOrigin()
    const lines: string[] = []
    const seen = new Set<string>()
    for (const f of r.fragments) {
      if (lines.length >= SEARCH_RESULTS) break
      const key = `${f.pageId}#${f.anchor}`
      if (seen.has(key)) continue
      seen.add(key)
      const heading = f.headingPath ? ` › ${esc(snip(f.headingPath, 80))}` : ''
      const body = snip(f.text, SNIPPET_MAX)
      lines.push(`• ${linkOr(pageLink(origin, workspaceId, f.pageId), esc(f.title.trim() || t.untitled))}${heading}${body ? `\n> ${esc(body)}` : ''}`)
    }
    for (const p of r.titleOnly) {
      if (lines.length >= SEARCH_RESULTS) break
      if ([...seen].some((k) => k.startsWith(`${p.pageId}#`))) continue
      seen.add(`${p.pageId}#`)
      lines.push(`• ${linkOr(pageLink(origin, workspaceId, p.pageId), esc(p.title.trim() || t.untitled))}`)
    }
    const q = esc(snip(query, 80))
    return lines.length ? [t.results(q), ...lines].join('\n') : t.noResults(q)
  } catch {
    return t.searchFailed
  }
}

function snip(s: string, max: number): string {
  const x = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return x.length > max ? x.slice(0, max - 1) + '…' : x
}

// ---------------------------------------------------------------------------
// Events API
// ---------------------------------------------------------------------------

const PAGE_PATH = /^\/w\/([0-9a-f-]{36})\/p\/([0-9a-f-]{36})\/?$/i

/** Page links of this Inkling (same host as PUBLIC_URL / APP_URL, or the request host) in this workspace. */
export function pageLinksOf(links: unknown, workspaceId: string, origin: string | null): { url: string; pageId: string }[] {
  if (!Array.isArray(links) || !origin) return []
  const host = new URL(origin).host.toLowerCase()
  const out: { url: string; pageId: string }[] = []
  for (const l of links.slice(0, 10)) {
    const url = typeof (l as { url?: unknown })?.url === 'string' ? (l as { url: string }).url : null
    if (!url || url.length > 2000) continue
    try {
      const u = new URL(url)
      if (u.host.toLowerCase() !== host) continue
      const m = PAGE_PATH.exec(u.pathname)
      if (!m || m[1].toLowerCase() !== workspaceId.toLowerCase()) continue
      out.push({ url, pageId: m[2].toLowerCase() })
    } catch {
      // not a URL
    }
  }
  return out
}

/**
 * One verified Events API callback. `link_shared` queues an unfurl job (answered later, through the
 * outbox, with the shared-page rule applied at delivery); uninstall / revoked tokens pause the
 * integration. Slack re-signs its retries, so events are deduplicated by `event_id`.
 */
export async function handleEventCallback(integ: IntegrationRow, body: Record<string, unknown>, fallbackOrigin: string): Promise<void> {
  const eventId = typeof body.event_id === 'string' ? body.event_id.slice(0, 100) : null
  if (eventId && !(await claimNonce(`evt:${integ.workspaceId}:${eventId}`))) return
  const ev = (body.event ?? {}) as Record<string, unknown>
  if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
    await db.update(slackIntegrations).set({ blockedReason: String(ev.type), lastError: String(ev.type), lastErrorAt: new Date() }).where(eq(slackIntegrations.workspaceId, integ.workspaceId))
    invalidateSlackCache(integ.workspaceId)
    return
  }
  if (ev.type !== 'link_shared' || integ.enabled !== '1' || integ.blockedReason) return
  const links = pageLinksOf(ev.links, integ.workspaceId, configuredOrigin() ?? (fallbackOrigin || null))
  if (!links.length) return
  const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null)
  const job: SlackUnfurlJob = {
    t: 'unfurl',
    channel: str(ev.channel, /^[A-Z0-9]{2,40}$/),
    ts: str(ev.message_ts, /^\d{1,12}\.\d{1,8}$/),
    unfurlId: str(ev.unfurl_id, /^[A-Za-z0-9._-]{1,200}$/),
    source: str(ev.source, /^[a-z_]{1,40}$/),
    links,
  }
  if (!(job.channel && job.ts) && !(job.unfurlId && job.source)) return
  await enqueueSlack([{ topic: 'slack', workspaceId: integ.workspaceId, payload: job }])
}
