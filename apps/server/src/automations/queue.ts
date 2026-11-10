import { sql } from 'drizzle-orm'
import type { AutomationTrigger } from '@inkling/shared'
import { db } from '../db/index'
import { enqueue } from '../outbox'
import type { Exec, OutboxRow } from '../outbox'
import { setAutomationEventHook } from '../context/changeLog'
import type { AutomationEventHook } from '../context/changeLog'
import { nextMarker, triggerFires } from './pure'

/**
 * Where database automation runs come from (docs/adr/2240-*).
 *
 * Row writes do not look for rules: every write path already logs `page_added` / `page_props` events
 * in its own transaction (the change feed), and the 'change' consumer calls `queueRuns` for them in
 * the transaction that materialises the feed. So a collection without rules costs its writers
 * nothing, a run is queued once per logged event (exactly once with the consumer's commit), and
 * the run sees the committed row. Bulk inserts mark their events `noAuto`.
 */

/** Payload of an 'automation' outbox row: one rule × one row. */
export interface AutomationJob {
  ruleId: string
  rowId: string
  /** What happened: a row was added, fields changed (`keys`), or a date came up. */
  event: 'added' | 'changed' | 'date'
  keys?: string[]
  /** Who made the write (null for a date). */
  actorId: string | null
  actorVia: string | null
  /** 0 = a person's or agent's write; n = the n-th automation-made write in a chain. */
  depth: number
  /** Rules that already ran in this chain (loop marker, docs/adr/2242-*). */
  chain: string[]
}

type Ev = Parameters<AutomationEventHook>[3][number]

export const queueRuns: AutomationEventHook = async (tx, workspaceId, actor, events, origin) => {
  const relevant = events.filter((e: Ev) => (e.kind === 'page_added' && !e.noAuto) || (e.kind === 'page_props' && e.keys?.length))
  if (relevant.length === 0) return false
  const ids = [...new Set(relevant.map((e) => e.pageId))]
  // One indexed lookup: enabled rules of the collections these rows are in (live rows only).
  const rules = (await tx.execute(sql`
    SELECT p.id AS "rowId", a.id AS "ruleId", a.trigger
      FROM pages p
      JOIN collection_automations a ON a.collection_id = p.parent_id AND a.enabled
     WHERE p.id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND p.deleted_at IS NULL AND p.workspace_id = ${workspaceId}
  `)) as unknown as { rowId: string; ruleId: string; trigger: AutomationTrigger }[]
  if (rules.length === 0) return false
  const marker = nextMarker(actor)
  const rows: OutboxRow[] = []
  for (const e of relevant) {
    for (const r of rules) {
      if (r.rowId !== e.pageId || !triggerFires(r.trigger, e.kind, e.keys)) continue
      const job: AutomationJob = {
        ruleId: r.ruleId,
        rowId: e.pageId,
        event: e.kind === 'page_added' ? 'added' : 'changed',
        ...(e.keys ? { keys: e.keys } : {}),
        actorId: actor?.userId ?? null,
        actorVia: actor?.via ?? null,
        depth: marker.depth,
        chain: marker.chain,
      }
      rows.push({ topic: 'automation', workspaceId, payload: job, origin })
    }
  }
  if (rows.length === 0) return false
  return (await enqueue(tx, rows)) > 0
}

setAutomationEventHook(queueRuns)

/**
 * "Date reached" rules (docs/adr/2240-*): rows whose date field is `daysBefore` days after `today`
 * get one run per rule, row and date — the outbox dedupe key, kept with the finished row for
 * OUTBOX_DONE_RETENTION_MS (7 days), longer than the one day the condition holds. Called from the
 * automation scheduler; several processes may call it at once.
 */
export async function queueDateRuns(today: string, exec: Exec = db): Promise<number> {
  const rules = (await exec.execute(sql`
    SELECT a.id, a.workspace_id AS "workspaceId", a.collection_id AS "collectionId", a.trigger
      FROM collection_automations a
      JOIN pages c ON c.id = a.collection_id AND c.deleted_at IS NULL
     WHERE a.enabled AND a.trigger->>'type' = 'dateReached'
  `)) as unknown as { id: string; workspaceId: string; collectionId: string; trigger: Extract<AutomationTrigger, { type: 'dateReached' }> }[]
  let n = 0
  for (const r of rules) {
    const [y, m, d] = today.split('-').map(Number)
    const target = new Date(Date.UTC(y, m - 1, d + r.trigger.daysBefore)).toISOString().slice(0, 10)
    const due = (await exec.execute(sql`
      SELECT id FROM pages
       WHERE parent_id = ${r.collectionId} AND deleted_at IS NULL
         AND left(props->>${r.trigger.fieldId}, 10) = ${target}
       LIMIT 500
    `)) as unknown as { id: string }[]
    if (!due.length) continue
    n += await enqueue(
      exec,
      due.map((row) => ({
        topic: 'automation' as const,
        workspaceId: r.workspaceId,
        dedupeKey: `auto:date:${r.id}:${row.id}:${target}`,
        payload: { ruleId: r.id, rowId: row.id, event: 'date', actorId: null, actorVia: null, depth: 0, chain: [] } satisfies AutomationJob,
      })),
    )
  }
  return n
}
