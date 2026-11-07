import { sql } from 'drizzle-orm'
import type { CollectionField } from '@inkling/shared'
import { db } from '../db/index'
import { liveEditors } from '../context/attribution'
import type { EditActor } from '../context/attribution'
import { splitSections } from '../context/chunker'
import type { AnyBlock } from '../md/convert'
import { emitWebhookEvent } from '../webhooks'
import { notify } from './engine'
import { scanMentions, textMentions } from './mentionScan'

/**
 * Producers that turn writes into notification events (docs/adr/1000-*, 1002-*). Each runs after
 * its write and only queues work (`notify`), so request latency does not depend on recipients.
 */

/** Owner / person-cell assignment: one event, webhook `assigned` for the channel. */
export function notifyAssigned(a: {
  workspaceId: string
  pageId: string
  actorId: string
  via: string | null
  kind: 'page_owner' | 'task_assigned'
  userIds: string[]
  /** 'owner' or the person field's name (shown in the item and the webhook). */
  field: string
}): void {
  const ids = [...new Set(a.userIds)].filter((id) => id !== a.actorId)
  if (!ids.length) return
  notify({
    workspaceId: a.workspaceId,
    pageId: a.pageId,
    actorId: a.actorId,
    via: a.via,
    recipients: ids.map((userId) => ({ userId, kind: a.kind, reason: 'direct' })),
    excerpt: a.field === 'owner' ? null : a.field,
  })
  emitWebhookEvent({ type: 'assigned', workspaceId: a.workspaceId, pageId: a.pageId, actorId: a.actorId, via: a.via, mentionedUserIds: ids, field: a.field })
}

/** Person ids of a person cell value (a uuid string, or an array of them). */
function personIds(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

/**
 * New assignees per person field: ids in `next` that were not in `prev`. Fields not touched by the
 * write are ignored. Returns [{ field name, user ids }].
 */
export function newAssignees(
  fields: CollectionField[],
  prev: Record<string, unknown>,
  set: Record<string, unknown>,
): { field: string; userIds: string[] }[] {
  const out: { field: string; userIds: string[] }[] = []
  for (const f of fields) {
    if (f.type !== 'person' || !(f.id in set)) continue
    const before = new Set(personIds(prev[f.id]))
    const added = personIds(set[f.id]).filter((id) => !before.has(id))
    if (added.length) out.push({ field: f.name, userIds: [...new Set(added)] })
  }
  return out
}

export function notifyTaskAssignments(a: {
  workspaceId: string
  rowId: string
  actorId: string
  via: string | null
  changes: { field: string; userIds: string[] }[]
}): void {
  for (const c of a.changes) {
    notifyAssigned({ workspaceId: a.workspaceId, pageId: a.rowId, actorId: a.actorId, via: a.via, kind: 'task_assigned', userIds: c.userIds, field: c.field })
  }
}

// ---------------------------------------------------------------------------
// Body @mentions (document indexer)
// ---------------------------------------------------------------------------

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

/** Signature of the mention set, for the indexer's skip cache. */
export function mentionSignature(state: Uint8Array): { sig: string; mentions: ReturnType<typeof scanMentions> } {
  const mentions = scanMentions(state)
  return { sig: [...new Set(mentions.map((m) => m.userId))].sort().join(','), mentions }
}

/**
 * Reconcile the page's mention set with page_mentions and notify the people newly mentioned.
 * Called by the document indexer with the state it just indexed. `actor` is who made the edit
 * (the in-flight REST/MCP writer, else the latest person typing in the page).
 */
export async function syncDocMentions(
  pageId: string,
  blocks: AnyBlock[],
  mentions: ReturnType<typeof scanMentions>,
  actor: EditActor | null,
): Promise<void> {
  const ids = [...new Set(mentions.map((m) => m.userId))].sort()
  const [prevRow] = (await db.execute(sql`
    SELECT p.workspace_id AS "workspaceId", p.kind, m.user_ids AS "userIds", m.page_id IS NOT NULL AS "hasRow"
      FROM pages p LEFT JOIN page_mentions m ON m.page_id = p.id
     WHERE p.id = ${pageId}
  `)) as unknown as { workspaceId: string; kind: string; userIds: string[] | null; hasRow: boolean }[]
  if (!prevRow) return
  const prev = prevRow.hasRow ? prevRow.userIds : []
  if (prev && sameSet(prev, ids)) return
  await db.execute(sql`
    INSERT INTO page_mentions (page_id, user_ids, updated_at) VALUES (${pageId}, ${JSON.stringify(ids)}::jsonb, now())
    ON CONFLICT (page_id) DO UPDATE SET user_ids = EXCLUDED.user_ids, updated_at = now()
  `)
  // Unknown baseline (page older than this index): record silently, no replay of old mentions.
  if (prev === null) return
  const before = new Set(prev)
  const added = ids.filter((id) => !before.has(id))
  if (!added.length) return

  const sections = splitSections(blocks)
  const sectionOf = (top: number) => sections.find((s) => top >= s.start && top < s.end)?.anchor ?? null
  // One event per added person (each gets the line that mentions them).
  for (const userId of added) {
    const m = mentions.find((x) => x.userId === userId)!
    notify({
      workspaceId: prevRow.workspaceId,
      pageId,
      actorId: actor?.userId ?? null,
      via: actor?.via ?? null,
      recipients: [{ userId, kind: 'doc_mention', reason: 'direct' }],
      anchor: sectionOf(m.top) ?? m.blockId,
      excerpt: m.text,
    })
  }
  // People's mentions ping the channel; agent-written ones do not (docs/adr/1002-*).
  // Only members are named in the channel (a chip can carry any user id).
  if (!actor?.via) {
    const members = (await db.execute(sql`
      SELECT user_id AS "userId" FROM workspace_members
       WHERE workspace_id = ${prevRow.workspaceId} AND user_id = ANY(${`{${added.join(',')}}`}::uuid[])
    `)) as unknown as { userId: string }[]
    const named = added.filter((id) => members.some((m) => m.userId === id) && id !== actor?.userId)
    if (named.length) {
      emitWebhookEvent({ type: 'mention', workspaceId: prevRow.workspaceId, pageId, actorId: actor?.userId ?? null, mentionedUserIds: named })
    }
  }
}

// ---------------------------------------------------------------------------
// Followed pages and agent-written "@Name" text (change log)
// ---------------------------------------------------------------------------

export interface ChangedSection {
  anchor: string
  before: string | null
  after: string | null
}

/**
 * After the change log recorded section changes: followers at level 'all' hear about the edit
 * (collapsed per page while unread), and plain-text "@Name" an AGENT added is a quiet mention
 * (agents cannot write mention chips; their mentions never ping, docs/adr/1002-*).
 */
export async function notifyPageEdited(a: {
  pageId: string
  workspaceId: string
  actor: EditActor | null
  sections: ChangedSection[]
}): Promise<void> {
  if (!a.sections.length) return
  const typing = liveEditors(a.pageId)
  const actorId = a.actor?.userId ?? typing[typing.length - 1] ?? null
  const via = a.actor?.via ?? null
  const first = a.sections[0]
  notify({
    workspaceId: a.workspaceId,
    pageId: a.pageId,
    actorId,
    via,
    recipients: [],
    followers: 'page_update',
    exclude: typing,
    anchor: first.anchor,
    excerpt: null,
  })
  if (!via) return
  const added = a.sections.filter((s) => s.after && s.after.includes('@'))
  if (!added.length) return
  const members = (await db.execute(sql`
    SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${a.workspaceId}
  `)) as unknown as { id: string; name: string }[]
  const seen = new Set<string>()
  for (const s of added) {
    const before = new Set(textMentions(s.before ?? '', members))
    for (const userId of textMentions(s.after ?? '', members)) {
      if (before.has(userId) || seen.has(userId)) continue
      seen.add(userId)
      const line = (s.after ?? '').split('\n').find((l) => l.includes('@')) ?? ''
      notify({
        workspaceId: a.workspaceId,
        pageId: a.pageId,
        actorId,
        via,
        recipients: [{ userId, kind: 'doc_mention', reason: 'direct' }],
        anchor: s.anchor,
        excerpt: line,
      })
    }
  }
}
