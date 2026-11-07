import { sql } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import { recordCreatedVia } from '../context/changeLog'
import { db } from '../db/index'

/**
 * Agent provenance of created pages (docs/adr/1005-*, resolves KNOWN-ISSUES AGENT-E5).
 *
 * Bulk creators (Markdown import, import-folder, templates) insert pages deep inside shared code;
 * for an agent request the route marks the created pages afterwards: pages.created_via, and the
 * `page_added` change-log rows that the same request wrote without a client name. Browser requests
 * (no `via`) do nothing. Rows still in the change-log outbox are relabelled by a queued 'relabel'
 * entry that the consumer applies after them (docs/adr/1080-*).
 */
export async function markCreatedVia(pageIds: string[], user: Pick<AuthUser, 'id' | 'via'>): Promise<void> {
  const via = user.via?.slice(0, 100)
  if (!via || pageIds.length === 0) return
  const ids = sql`${`{${pageIds.join(',')}}`}::uuid[]`
  await db.execute(sql`UPDATE pages SET created_via = ${via} WHERE id = ANY(${ids}) AND created_via IS NULL`)
  await db.execute(sql`
    UPDATE page_changes SET via_client = ${via}, actor_id = coalesce(actor_id, ${user.id}::uuid)
     WHERE page_id = ANY(${ids}) AND kind = 'page_added' AND via_client IS NULL
  `)
  await recordCreatedVia(pageIds, via, user.id)
}
