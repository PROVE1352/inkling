import { sql } from 'drizzle-orm'
import type { CollectionField } from '@inkling/shared'
import { db } from '../db/index'
import { liveEditors } from '../context/attribution'
import type { EditActor } from '../context/attribution'
import { splitSections } from '../context/chunker'
import type { AnyBlock } from '../md/convert'
import { enqueue, kickOutbox, outboxTopics } from '../outbox'
import type { Exec, OutboxRow, OutboxTopic } from '../outbox'
import { enqueueWebhookEvent, webhookOutboxRows } from '../webhooks'
import { enqueueNotify, notifyOutboxRow } from './engine'
import { mayHaveMentions, mentionKey, scanMentions, scanMentionsInDoc, textMentions } from './mentionScan'
import { connectionLiveSql, connectionOwnerSql, connectionsOutsidePage } from '../teamAgents'
import { isAgentVia } from '../agentVia'

/**
 * Producers that turn writes into notification events (docs/adr/1000-*, 1002-*). Each only queues
 * work in the outbox (docs/adr/1081-*), in the transaction of the write (docs/adr/1150-*), so
 * request latency does not depend on recipients and an event commits exactly with its write.
 */

export interface Assignment {
  workspaceId: string
  pageId: string
  actorId: string
  via: string | null
  kind: 'page_owner' | 'task_assigned'
  userIds: string[]
  /** 'owner' or the person field's name (shown in the item and the webhook). */
  field: string
  /** Assigned to this agent connection of the (single) person (docs/adr/1864-*): its inbox only. */
  connection?: string
}

/** Outbox rows of an owner / person-cell assignment: one event, webhook `assigned` for the channel. */
export async function assignmentRows(a: Assignment, exec: Pick<typeof db, 'select'> = db): Promise<OutboxRow[]> {
  // People assign work to their own agents: an agent assignment keeps the actor (docs/adr/1863-*).
  const ids = [...new Set(a.userIds)].filter((id) => !!a.connection || id !== a.actorId)
  if (!ids.length) return []
  const rows: OutboxRow[] = []
  const n = notifyOutboxRow({
    workspaceId: a.workspaceId,
    pageId: a.pageId,
    actorId: a.actorId,
    via: a.via,
    recipients: ids.map((userId) => ({ userId, kind: a.kind, reason: 'direct' })),
    excerpt: a.field === 'owner' ? null : a.field,
    connection: a.connection ?? null,
  })
  if (n) rows.push(n)
  rows.push(
    ...(await webhookOutboxRows({ type: 'assigned', workspaceId: a.workspaceId, pageId: a.pageId, actorId: a.actorId, via: a.via, mentionedUserIds: ids, field: a.field }, exec)),
  )
  return rows
}

/**
 * Queue assignments in the writer's transaction (one INSERT for all of them, docs/adr/1150-*).
 * Returns the topics queued; call `outboxCommitted(topics)` after the commit.
 */
export async function enqueueAssignments(exec: Exec & Pick<typeof db, 'select'>, list: Assignment[]): Promise<OutboxTopic[]> {
  // Sequential on the transaction's connection (hook list on a cache miss).
  const rows: OutboxRow[] = []
  for (const a of list) rows.push(...(await assignmentRows(a, exec)))
  if (!rows.length) return []
  await enqueue(exec, rows)
  return outboxTopics(rows).topics
}

/** Person-cell assignments of one row, one per field: see `newAssignees`. */
export function taskAssignments(a: {
  workspaceId: string
  rowId: string
  actorId: string
  via: string | null
  changes: { field: string; userIds: string[] }[]
}): Assignment[] {
  return a.changes.map((c) => ({
    workspaceId: a.workspaceId,
    pageId: a.rowId,
    actorId: a.actorId,
    via: a.via,
    kind: 'task_assigned' as const,
    userIds: c.userIds,
    field: c.field,
  }))
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

// ---------------------------------------------------------------------------
// Body @mentions (document indexer)
// ---------------------------------------------------------------------------

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

/** Signature of the mention set, for the indexer's skip cache. */
export function mentionSignature(
  state: Uint8Array,
  decoded?: import('yjs').Doc,
): { sig: string; mentions: ReturnType<typeof scanMentions> } {
  // `decoded` = the same state already applied to a throwaway doc (the indexer decodes once, docs/adr/1102-*).
  const mentions = !mayHaveMentions(state) ? [] : decoded ? scanMentionsInDoc(decoded) : scanMentions(state)
  return { sig: [...new Set(mentions.map((m) => mentionKey(m)))].sort().join(','), mentions }
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
  // People by id; agent chips by `<person>/<connection>` (docs/adr/1861-*), so handing a page line to
  // a person's agent and mentioning the person are separate entries of the set.
  const ids = [...new Set(mentions.map((m) => mentionKey(m)))].sort()
  // The mention set and the events it causes commit together: no lost or replayed mention.
  const queued = await db.transaction(async (tx) => {
    const [prevRow] = (await tx.execute(sql`
      SELECT p.workspace_id AS "workspaceId", p.kind, m.user_ids AS "userIds", m.page_id IS NOT NULL AS "hasRow"
        FROM pages p LEFT JOIN page_mentions m ON m.page_id = p.id
       WHERE p.id = ${pageId}
    `)) as unknown as { workspaceId: string; kind: string; userIds: string[] | null; hasRow: boolean }[]
    if (!prevRow) return false
    const prev = prevRow.hasRow ? prevRow.userIds : []
    if (prev && sameSet(prev, ids)) return false
    await tx.execute(sql`
      INSERT INTO page_mentions (page_id, user_ids, updated_at) VALUES (${pageId}, ${JSON.stringify(ids)}::jsonb, now())
      ON CONFLICT (page_id) DO UPDATE SET user_ids = EXCLUDED.user_ids, updated_at = now()
    `)
    // Unknown baseline (page older than this index): record silently, no replay of old mentions.
    if (prev === null) return false
    const before = new Set(prev)
    const added = ids.filter((id) => !before.has(id))
    if (!added.length) return false

    const sections = splitSections(blocks)
    const sectionOf = (top: number) => sections.find((s) => top >= s.start && top < s.end)?.anchor ?? null
    // Agent chips (docs/adr/1863-*, 1864-*): to that connection's inbox while it is live in the
    // workspace; otherwise (revoked, expired, blocked, person left) to the person. A chip in a to-do
    // is an assignment of the task.
    const agentKeys = added.filter((k) => k.includes('/'))
    const live = new Set<string>()
    if (agentKeys.length) {
      const conns = [...new Set(agentKeys.map((k) => k.slice(k.indexOf('/') + 1)))]
      const rows = (await tx.execute(sql`
        SELECT c.key, ${connectionOwnerSql(sql`c.key`)} AS owner FROM unnest(${`{${conns.join(',')}}`}::text[]) AS c(key)
         WHERE ${connectionLiveSql(sql`c.key`, sql`${prevRow.workspaceId}::uuid`)}
      `)) as unknown as { key: string; owner: string | null }[]
      // a chip naming another person's connection is that person's chip, never the connection's; a
      // connection whose subtree range leaves this page out would never see the item: the person gets it
      const outside = await connectionsOutsidePage(rows.map((r) => r.key), pageId, tx)
      for (const r of rows) if (r.owner && !outside.has(r.key)) live.add(`${r.owner}/${r.key}`)
    }
    for (const key of agentKeys) {
      const m = mentions.find((x) => mentionKey(x) === key)!
      const toAgent = live.has(key)
      await enqueueNotify(tx, {
        workspaceId: prevRow.workspaceId,
        pageId,
        actorId: actor?.userId ?? null,
        via: actor?.via ?? null,
        recipients: [{ userId: m.userId, kind: m.inTask ? 'task_assigned' : 'doc_mention', reason: 'direct' }],
        connection: toAgent ? m.connection! : null,
        anchor: sectionOf(m.top) ?? m.blockId,
        excerpt: m.text,
      })
    }
    // One event per added person (each gets the line that mentions them).
    for (const userId of added.filter((k) => !k.includes('/'))) {
      const m = mentions.find((x) => !x.connection && x.userId === userId)!
      await enqueueNotify(tx, {
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
    const people = added.filter((k) => !k.includes('/'))
    if (!isAgentVia(actor?.via) && people.length) {
      const members = (await tx.execute(sql`
        SELECT user_id AS "userId" FROM workspace_members
         WHERE workspace_id = ${prevRow.workspaceId} AND user_id = ANY(${`{${people.join(',')}}`}::uuid[])
      `)) as unknown as { userId: string }[]
      const named = people.filter((id) => members.some((m) => m.userId === id) && id !== actor?.userId)
      if (named.length) {
        await enqueueWebhookEvent(tx, { type: 'mention', workspaceId: prevRow.workspaceId, pageId, actorId: actor?.userId ?? null, mentionedUserIds: named })
      }
    }
    return true
  })
  if (queued) {
    kickOutbox('notify')
    kickOutbox('webhook')
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
export async function notifyPageEdited(
  a: {
    pageId: string
    workspaceId: string
    actor: EditActor | null
    sections: ChangedSection[]
    /** People typing in the page when the change was logged (default: now). */
    typing?: string[]
  },
  /** The change-log consumer's transaction: the events commit with the log rows. */
  exec: Exec = db,
  /** Outbox affinity of the change that caused this (the instance that saw the edit). */
  origin?: string | null,
): Promise<void> {
  if (!a.sections.length) return
  const typing = a.typing ?? liveEditors(a.pageId)
  const actorId = a.actor?.userId ?? typing[typing.length - 1] ?? null
  const via = a.actor?.via ?? null
  const first = a.sections[0]
  await enqueueNotify(
    exec,
    {
      workspaceId: a.workspaceId,
      pageId: a.pageId,
      actorId,
      via,
      recipients: [],
      followers: 'page_update',
      exclude: typing,
      anchor: first.anchor,
      excerpt: null,
    },
    origin,
  )
  if (!isAgentVia(via)) return
  const added = a.sections.filter((s) => s.after && s.after.includes('@'))
  if (!added.length) return
  const members = (await exec.execute(sql`
    SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ${a.workspaceId}
  `)) as unknown as { id: string; name: string }[]
  const seen = new Set<string>()
  for (const s of added) {
    const before = new Set(textMentions(s.before ?? '', members))
    for (const userId of textMentions(s.after ?? '', members)) {
      if (before.has(userId) || seen.has(userId)) continue
      seen.add(userId)
      const line = (s.after ?? '').split('\n').find((l) => l.includes('@')) ?? ''
      await enqueueNotify(
        exec,
        {
          workspaceId: a.workspaceId,
          pageId: a.pageId,
          actorId,
          via,
          recipients: [{ userId, kind: 'doc_mention', reason: 'direct' }],
          anchor: s.anchor,
          excerpt: line,
        },
        origin,
      )
    }
  }
}
