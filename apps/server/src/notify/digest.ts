import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { localISODate } from '../review'
import { emitWebhookEvent } from '../webhooks'
import { liveWorkspace } from '../workspaceLive'
import { flushNotifications, notify } from './engine'
import { runMailDigests, sweepInstantMails } from './mailer'

/**
 * Daily AI-edit summaries (docs/adr/1004-*), run from housekeeping.
 *
 *  - Personal: a subscription row with agent_digest = true gets one in-app `agent_digest` item a day
 *    listing the pages agent connections changed under its root (only pages the person can see,
 *    only rows they could see when logged). The item then rides the mail digest like any other.
 *  - Workspace: hooks subscribed to `agent_digest` get one message a day naming the shared pages
 *    agents changed (same privacy gate as every webhook: re-checked at delivery).
 */

const SUMMARY_LISTED = 5
const MAX_PREFS_PER_RUN = 500

export async function runAgentSummaries(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  const iso = now.toISOString()
  const rows = (await db.execute(sql`
    WITH RECURSIVE due AS (
      SELECT id, user_id, workspace_id, root_page_id,
             coalesce(agent_digest_sent_at, ${iso}::timestamptz - interval '1 day') AS since
        FROM notification_prefs
       WHERE agent_digest
         AND (${!!opts.force}::boolean OR agent_digest_sent_at IS NULL OR agent_digest_sent_at < ${iso}::timestamptz - interval '23 hours')
       ORDER BY id
       LIMIT ${MAX_PREFS_PER_RUN}
    ), tree AS (
      SELECT d.id AS pref, p.id AS page, 0 AS depth FROM due d JOIN pages p ON p.id = d.root_page_id
      UNION ALL
      SELECT t.pref, c.id, t.depth + 1 FROM pages c JOIN tree t ON c.parent_id = t.page WHERE t.depth < 64
    )
    SELECT d.id AS pref, d.user_id AS "userId", d.workspace_id AS "workspaceId", d.root_page_id AS "rootId",
           c.page_id AS "pageId", pg.title, count(*)::int AS n, max(c.seq)::text AS last
      FROM due d
      JOIN page_changes c ON c.workspace_id = d.workspace_id AND c.via_client IS NOT NULL
                         AND c.changed_at > d.since AND c.changed_at <= ${iso}::timestamptz
                         AND (c.scope = 'shared' OR c.owner_id = d.user_id)
      JOIN pages pg ON pg.id = c.page_id AND pg.deleted_at IS NULL AND (pg.scope = 'shared' OR pg.created_by = d.user_id)
      JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id
     WHERE (d.root_page_id IS NULL OR c.page_id IN (SELECT page FROM tree WHERE tree.pref = d.id))
       AND ${liveWorkspace(sql`d.workspace_id`)}
     GROUP BY d.id, d.user_id, d.workspace_id, d.root_page_id, c.page_id, pg.title
     ORDER BY d.id, max(c.seq) DESC
  `)) as unknown as { pref: string; userId: string; workspaceId: string; rootId: string | null; pageId: string; title: string; n: number }[]

  const byPref = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byPref.get(r.pref) ?? []
    list.push(r)
    byPref.set(r.pref, list)
  }
  let made = 0
  for (const list of byPref.values()) {
    const first = list[0]
    const edits = list.reduce((s, r) => s + r.n, 0)
    const names = list.slice(0, SUMMARY_LISTED).map((r) => r.title.trim() || 'Untitled')
    const more = list.length - names.length
    notify({
      workspaceId: first.workspaceId,
      pageId: first.rootId,
      actorId: null,
      via: null,
      recipients: [{ userId: first.userId, kind: 'agent_digest', reason: 'direct' }],
      excerpt: `${list.length} page(s), ${edits} change(s): ${names.join(' · ')}${more > 0 ? ` (+${more})` : ''}`,
    })
    made++
  }
  // Every due row moves its window, with or without changes.
  await db.execute(sql`
    UPDATE notification_prefs SET agent_digest_sent_at = ${iso}::timestamptz
     WHERE id IN (
       SELECT id FROM notification_prefs
        WHERE agent_digest
          AND (${!!opts.force}::boolean OR agent_digest_sent_at IS NULL OR agent_digest_sent_at < ${iso}::timestamptz - interval '23 hours')
        ORDER BY id LIMIT ${MAX_PREFS_PER_RUN})
  `)
  return made
}

const WEBHOOK_PAGES = 50

/** Once a day per workspace with a hook on `agent_digest`: shared pages agents changed in the last day. */
export async function runAgentWebhookDigests(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  const today = localISODate(now)
  const iso = now.toISOString()
  const candidates = (await db.execute(sql`
    SELECT w.id FROM workspaces w
     WHERE w.deleted_at IS NULL
       AND (${!!opts.force}::boolean OR w.agent_digest_sent_on IS DISTINCT FROM ${today})
       AND EXISTS (SELECT 1 FROM workspace_webhooks h WHERE h.workspace_id = w.id AND h.enabled = '1' AND h.events ? 'agent_digest')
     LIMIT 500
  `)) as unknown as { id: string }[]
  let sent = 0
  for (const ws of candidates) {
    const claimed = (await db.execute(sql`
      UPDATE workspaces SET agent_digest_sent_on = ${today}
       WHERE id = ${ws.id} AND (${!!opts.force}::boolean OR agent_digest_sent_on IS DISTINCT FROM ${today})
      RETURNING id
    `)) as unknown as { id: string }[]
    if (!claimed.length) continue
    const pages = (await db.execute(sql`
      SELECT c.page_id AS "pageId" FROM page_changes c JOIN pages p ON p.id = c.page_id
       WHERE c.workspace_id = ${ws.id} AND c.via_client IS NOT NULL AND c.scope = 'shared'
         AND c.changed_at > ${iso}::timestamptz - interval '1 day' AND c.changed_at <= ${iso}::timestamptz
         AND p.deleted_at IS NULL AND p.scope = 'shared'
       GROUP BY c.page_id ORDER BY max(c.seq) DESC LIMIT ${WEBHOOK_PAGES}
    `)) as unknown as { pageId: string }[]
    if (!pages.length) continue
    emitWebhookEvent({ type: 'agent_digest', workspaceId: ws.id, pageId: pages[0].pageId, pageIds: pages.map((p) => p.pageId) })
    sent++
  }
  return sent
}

/** Hourly: lost instant mails, AI summaries, then digests (AI summaries first so they ride along). */
export async function runNotificationHousekeeping(now: Date, log: (msg: string) => void): Promise<void> {
  try {
    const swept = await sweepInstantMails(now)
    const summaries = await runAgentSummaries(now)
    const hooks = await runAgentWebhookDigests(now)
    // Let the queued AI summaries land before the digest reads them.
    await flushNotifications()
    const mails = await runMailDigests(now)
    if (swept || summaries || hooks || mails) {
      log(`[inkling] notifications: ${swept} delayed instant item(s) mailed, ${summaries} AI summaries, ${hooks} AI webhook digest(s), ${mails} digest mail(s)`)
    }
  } catch (err) {
    log(`[inkling] notification housekeeping failed: ${String(err)}`)
  }
}
