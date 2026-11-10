import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { pageInRangeSql } from '../tokenRange'
import { headingTail, shortAnchors } from './chunker'
import type { ExtraItem, ExtraList } from './multiQuery'
import type { Fragment } from './rank'
import { semanticCandidates } from './semantic'
import { semanticConfig } from './semanticConfig'
import { estimateTokens } from './tokens'

/**
 * Semantic candidates as extra ranked lists of the find_context merge (docs/adr/1723-*; join point
 * docs/adr/1722-*, candidates docs/adr/1743-*).
 *
 *   - Only while semantic search is on (`semanticOn()`); off, the route keeps the single-query path
 *     and nothing here runs.
 *   - One list per query, labelled with the query's number ("1".."5"), so `matched:` keeps meaning
 *     "which phrasings found it". A query whose candidates are null (endpoint down, backing off) adds
 *     no list: that query is answered lexically.
 *   - Candidates below SEMANTIC_RELATIVE_FLOOR × the query's best cosine are dropped.
 *   - Each item carries a text fragment (the section's first chunk, the same row find_context packs),
 *     so a section found only by meaning is shown like a lexical result, not as a bare pointer.
 *
 * Runs inside the request scope: semanticCandidates and the fragment statement both apply the
 * connection range and guest scope (pageInRangeSql), membership, agent blocks and the 2FA rule.
 */

/** Semantic candidates per query (one list each). */
export const SEMANTIC_PER_QUERY = 8
/**
 * A candidate is kept when its cosine is at least this share of the query's best one (and above 0):
 * nearest neighbours always exist, also for a question nothing in the notes is about. The same
 * relative rule as the lexical floor (rank.ts FLOOR.relative).
 */
export const SEMANTIC_RELATIVE_FLOOR = 0.6

export function semanticOn(): boolean {
  return semanticConfig() !== null
}

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

interface ChunkRow {
  pageId: string
  workspaceId: string
  title: string
  anchor: string
  headingPath: string
  ord: number
  text: string
  tokens: number
  version: string
}

/**
 * Fragments for (pageId, anchor) pairs: the first chunk of each section, with the short anchor and
 * heading tail find_context prints (docs/adr/1212-*). Visibility is checked again in the statement.
 */
async function sectionFragments(userId: string, workspaceIds: string[], keys: { pageId: string; anchor: string }[]): Promise<Map<string, Fragment>> {
  const out = new Map<string, Fragment>()
  if (!keys.length) return out
  const pageIds = [...new Set(keys.map((k) => k.pageId))]
  const wanted = new Set(keys.map((k) => `${k.pageId}#${k.anchor}`))
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (c.page_id, c.anchor)
           c.page_id AS "pageId", p.workspace_id AS "workspaceId", p.title, c.anchor,
           c.heading_path AS "headingPath", c.ord, c.text, c.token_estimate AS tokens, c.section_hash AS version
      FROM page_chunks c JOIN pages p ON p.id = c.page_id
     WHERE c.page_id = ANY(${uuidArray(pageIds)}::uuid[])
       AND p.workspace_id = ANY(${uuidArray(workspaceIds)}::uuid[]) AND p.deleted_at IS NULL
       AND (p.scope = 'shared' OR (p.scope = 'private' AND p.created_by = ${userId}))
       AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)}
     ORDER BY c.page_id, c.anchor, c.ord
  `)) as unknown as ChunkRow[]
  const hits = rows.filter((r) => wanted.has(`${r.pageId}#${r.anchor}`))
  if (!hits.length) return out
  // short anchors need every anchor of the page (as retrieve.ts sectionLabels)
  const anchorRows = (await db.execute(sql`
    SELECT page_id AS "pageId", anchor FROM page_chunks
     WHERE page_id = ANY(${uuidArray([...new Set(hits.map((r) => r.pageId))])}::uuid[]) AND part = 0
     ORDER BY page_id, ord
  `)) as unknown as { pageId: string; anchor: string }[]
  const byPage = new Map<string, string[]>()
  for (const r of anchorRows) byPage.set(r.pageId, [...(byPage.get(r.pageId) ?? []), r.anchor])
  const shorts = new Map([...byPage].map(([id, anchors]) => [id, shortAnchors(anchors)]))
  for (const r of hits) {
    const short = shorts.get(r.pageId)?.get(r.anchor) ?? r.anchor
    const heading = headingTail(r.headingPath, short.split('/').length)
    out.set(`${r.pageId}#${r.anchor}`, {
      pageId: r.pageId,
      workspaceId: r.workspaceId,
      title: r.title,
      anchor: r.anchor,
      headingPath: r.headingPath,
      sections: [{ anchor: r.anchor, headingPath: r.headingPath, version: r.version, short, heading }],
      ords: [r.ord],
      text: r.text,
      tokens: estimateTokens(r.text),
      score: 0,
      truncated: false,
    })
  }
  return out
}

/**
 * The `extraLists` callback of cachedFindContextMulti (contextCache.ts): semantic candidates of
 * every query, each with its fragment. [] when the feature is off.
 */
export async function semanticExtraLists(scope: { userId: string; workspaceIds: string[]; queries: string[] }): Promise<ExtraList[]> {
  if (!semanticOn() || !scope.workspaceIds.length) return []
  const perQuery = (
    await Promise.all(
      scope.queries.map((query) => semanticCandidates({ workspaceIds: scope.workspaceIds, query, limit: SEMANTIC_PER_QUERY, userId: scope.userId })),
    )
  ).map((list) => {
    if (!list) return null
    const floor = Math.max(0, (list[0]?.score ?? 0) * SEMANTIC_RELATIVE_FLOOR)
    return list.filter((c) => c.score > 0 && c.score >= floor)
  })
  const keys = new Map<string, { pageId: string; anchor: string }>()
  for (const list of perQuery) for (const c of list ?? []) if (c.anchor !== null) keys.set(`${c.pageId}#${c.anchor}`, { pageId: c.pageId, anchor: c.anchor })
  const fragments = await sectionFragments(scope.userId, scope.workspaceIds, [...keys.values()])
  const lists: ExtraList[] = []
  perQuery.forEach((list, i) => {
    if (!list) return
    const items: ExtraItem[] = []
    for (const c of list) {
      if (c.anchor === null) continue
      // a section edited or hidden since its vector was read has no fragment: left out
      const fragment = fragments.get(`${c.pageId}#${c.anchor}`)
      if (fragment) items.push({ pageId: c.pageId, anchor: c.anchor, score: c.score, title: fragment.title, tokens: fragment.tokens, fragment })
    }
    if (items.length) lists.push({ label: String(i + 1), items })
  })
  return lists
}
