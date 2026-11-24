import { sql } from 'drizzle-orm'
import type { SectionProvenanceDTO } from '@inkling/shared'
import { isAgentVia } from './agentVia'
import { readOutline } from './context/sectionSource'
import { db } from './db/index'
import type { PageRow } from './pageDto'
import { revertInfo } from './revert'
import { pageInRangeSql } from './tokenRange'

/**
 * Section marks (docs/adr/1627-*): for each current section of a document page, the newest row of
 * the change log (page_changes) that the user may see, i.e. who changed the section last, when, and
 * whether that change can be reverted from the heading.
 *
 * One DISTINCT ON query on the (page_id, anchor, seq) index, with the visibility of
 * GET /pages/:id/changes. Filters run AFTER picking the newest row per anchor, so a section whose
 * newest change is anonymous typing (no actor, KI CF-2) or a removal shows no mark instead of an
 * older change that is no longer the last one. Anchors that are not in the current outline (removed
 * or renamed away) are dropped; the outline also gives the heading block id the web places the mark by.
 *
 * What the log cannot say: rows are kept 30 days, and one person's (or one agent's) edits of a
 * section within 10 minutes are one row (changeLog.ts MERGE_WINDOW_MS), so "the last change" may
 * be several edits. An accepted suggestion is the accepting person's change (via null).
 */
export async function sectionProvenance(page: PageRow, userId: string): Promise<SectionProvenanceDTO[]> {
  if (page.kind !== 'doc') return []
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (c.anchor)
           c.seq::text AS seq, c.page_id AS "pageId", c.anchor, c.kind, c.heading_path AS "headingPath",
           c.actor_id AS "actorId", u.name AS "actorName", c.via_client AS via, c.changed_at AS "changedAt",
           c.large, (c.before_text IS NOT NULL OR c.after_text IS NOT NULL) AS "hasText"
      FROM page_changes c
      LEFT JOIN users u ON u.id = c.actor_id
     WHERE c.page_id = ${page.id} AND c.anchor IS NOT NULL
       AND (c.scope = 'shared' OR c.owner_id = ${userId})
       AND ${pageInRangeSql(sql`c.page_id`, sql`c.workspace_id`, userId)}
     ORDER BY c.anchor, c.seq DESC
  `)) as unknown as {
    seq: string
    pageId: string
    anchor: string
    kind: string
    headingPath: string
    actorId: string | null
    actorName: string | null
    via: string | null
    changedAt: Date | string
    large: boolean
    hasText: boolean
  }[]
  const kept = rows.filter((r) => r.kind !== 'removed' && r.actorId !== null && r.actorName !== null)
  if (!kept.length) return []
  const outline = await readOutline(page.id)
  const blockOf = new Map(outline.map((s) => [s.anchor, s.blockId]))
  const live = kept.filter((r) => blockOf.has(r.anchor))
  const info = await revertInfo(page.workspaceId, live)
  // in outline order, so the list reads top to bottom like the page
  const order = new Map(outline.map((s, i) => [s.anchor, i]))
  live.sort((a, b) => order.get(a.anchor)! - order.get(b.anchor)!)
  return live.map((r) => {
    const rv = info.get(r.seq)
    return {
      anchor: r.anchor,
      blockId: blockOf.get(r.anchor) ?? null,
      headingPath: r.headingPath,
      seq: r.seq,
      kind: r.kind,
      changedAt: new Date(r.changedAt).toISOString(),
      actor: { id: r.actorId!, name: r.actorName! },
      via: r.via,
      agent: isAgentVia(r.via),
      revertable: rv?.revertable ?? false,
      revertedBy: rv?.revertedBy ?? null,
      isRevert: rv?.isRevert ?? false,
    }
  })
}
