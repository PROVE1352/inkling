import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { shortAnchors } from '../context/chunker'
import { memberWorkspaceIds } from '../context/retrieve'
import { withSsdPlanCosts } from '../db/index'
import { requireMembership } from '../helpers'
import { pageInRangeSql } from '../tokenRange'
import { escapeLike } from '../util'
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, searchSnippet, wholeWordPattern } from './agentSearchText'
import type { AgentSearchHit, AgentSearchResponse, SearchMatch } from './agentSearchText'

/**
 * Agent search (docs/adr/2183-*): GET /api/search?q&workspaceId&limit. One statement over every
 * workspace the caller may search (or the one given), ranked by where the text matched and how:
 *
 *   0 title equals the query (case-insensitive)   1 title contains it as a whole word
 *   2 title contains it                           3 a heading contains it as a whole word
 *   4 a heading contains it                       5 the body contains it as a whole word
 *   6 the body contains it
 *
 * then updatedAt desc (a tie-break only), then id: the same documents give the same order
 * (docs/adr/0937-*). The match set is the old route's (title or page_texts ILIKE, trigram probes from
 * 3 characters, docs/adr/0755-*); only the order, the cap and the counts differ. Per workspace match
 * counts come from the same statement, so the MCP tool can say how many more there are and where.
 *
 * GET /api/workspaces/:id/search (the web app's search) is unchanged.
 */

const querySchema = z.object({
  // blank after trimming: an empty answer, as the web search route gives (not a validation error)
  q: z.string().trim().max(200),
  workspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
})

const GRADE: { match: SearchMatch; exact: boolean }[] = [
  { match: 'title', exact: true },
  { match: 'title', exact: true },
  { match: 'title', exact: false },
  { match: 'heading', exact: true },
  { match: 'heading', exact: false },
  { match: 'body', exact: true },
  { match: 'body', exact: false },
]

interface Row {
  id: string
  workspaceId: string
  title: string
  kind: string
  scope: string
  updatedAt: Date | string
  grade: number
  anchor: string | null
  headingPath: string | null
  anchors: string[] | null
  win: string | null
  winStart: number | null
  textLen: number | null
  counts: { id: string; name: string; n: number }[] | string | null
}

/**
 * The search itself (exported for the benchmark). `workspaceIds` are already checked for membership.
 * The visibility rule is pageDto.ts visibleTo (private pages are the author's) plus the connection
 * range and guest scope (tokenRange.ts pageInRangeSql), as in find_context.
 */
export async function agentSearch(opts: { userId: string; q: string; workspaceIds: string[]; limit: number }): Promise<AgentSearchResponse> {
  const term = opts.q.trim()
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(opts.limit)))
  const empty: AgentSearchResponse = { results: [], total: 0, workspaces: [], limit }
  if (!term || opts.workspaceIds.length === 0) return empty
  const ws = `{${opts.workspaceIds.join(',')}}`
  const pat = `%${escapeLike(term)}%`
  const re = wholeWordPattern(term)
  const visible = sql`(p.scope = 'shared' OR (p.scope = 'private' AND p.created_by = ${opts.userId})) AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, opts.userId)}`
  // ≥ 3 characters: candidates from the two trigram-indexable probes (title, body); shorter terms
  // have no trigrams and the OR form is faster there (docs/adr/0755-*, same split as the web search).
  const matchIds: SQL =
    [...term].length >= 3
      ? sql`p.id IN (
          SELECT p2.id FROM pages p2 WHERE p2.workspace_id = ANY(${ws}::uuid[]) AND p2.title ILIKE ${pat}
          UNION
          SELECT t2.page_id FROM page_texts t2 WHERE t2.text ILIKE ${pat}
        )`
      : sql`(p.title ILIKE ${pat} OR t.text ILIKE ${pat})`

  // Grades are tested cheapest first (CASE stops at the first true branch): title tests, then the
  // heading flags, then the body regex (computed with the candidate row, skipped for title matches,
  // so each body is read once). Heading flags come from one
  // grouped join of the candidates' section rows (the planner picks index probes for a few
  // candidates, a hash join for thousands), not from two correlated probes per candidate: those
  // cost ~10 µs a row, 100 ms for 10k candidates (docs/adr/2183-*).
  const rows = (await withSsdPlanCosts((tx) =>
    tx.execute(sql`
      WITH cand AS MATERIALIZED (
        SELECT p.id, p.workspace_id, p.title, p.kind, p.scope, p.updated_at,
               -- whole word in the body, read while the row's text is at hand (title matches skip it)
               CASE WHEN p.title ILIKE ${pat} THEN NULL ELSE t.text ~* ${re} END AS body_exact
          FROM pages p LEFT JOIN page_texts t ON t.page_id = p.id
         WHERE p.workspace_id = ANY(${ws}::uuid[]) AND p.deleted_at IS NULL AND ${visible} AND ${matchIds}
      ),
      hd AS (
        SELECT c.page_id, bool_or(c.heading_path ~* ${re}) AS exact
          FROM page_chunks c
         WHERE c.page_id IN (SELECT cand.id FROM cand) AND c.heading_path ILIKE ${pat}
         GROUP BY c.page_id
      ),
      m AS (
        SELECT cand.id, cand.workspace_id, cand.title, cand.kind, cand.scope, cand.updated_at,
               CASE
                 WHEN lower(cand.title) = lower(${term}) THEN 0
                 WHEN cand.title ~* ${re} THEN 1
                 WHEN cand.title ILIKE ${pat} THEN 2
                 WHEN hd.exact THEN 3
                 WHEN hd.page_id IS NOT NULL THEN 4
                 WHEN cand.body_exact THEN 5
                 ELSE 6
               END AS grade
          FROM cand LEFT JOIN hd ON hd.page_id = cand.id
      ),
      counts AS (SELECT m.workspace_id, count(*)::int AS n FROM m GROUP BY m.workspace_id),
      top AS (SELECT * FROM m ORDER BY m.grade, m.updated_at DESC, m.id LIMIT ${limit})
      SELECT top.id, top.workspace_id AS "workspaceId", top.title, top.kind, top.scope,
             top.updated_at AS "updatedAt", top.grade,
             sec.anchor, sec.heading_path AS "headingPath",
             CASE WHEN sec.anchor IS NOT NULL THEN
               (SELECT array_agg(c3.anchor ORDER BY c3.ord) FROM page_chunks c3 WHERE c3.page_id = top.id)
             END AS anchors,
             body.win, body.win_start AS "winStart", body.text_len AS "textLen",
             (SELECT json_agg(json_build_object('id', counts.workspace_id, 'name', w.name, 'n', counts.n)
                              ORDER BY counts.n DESC, counts.workspace_id)
                FROM counts JOIN workspaces w ON w.id = counts.workspace_id) AS counts
        FROM top
        LEFT JOIN LATERAL (
          SELECT c.anchor, c.heading_path FROM page_chunks c
           WHERE c.page_id = top.id AND CASE top.grade
             WHEN 3 THEN c.heading_path ~* ${re}
             WHEN 4 THEN c.heading_path ILIKE ${pat}
             WHEN 5 THEN c.text ~* ${re}
             WHEN 6 THEN c.text ILIKE ${pat}
             ELSE false END
           ORDER BY c.ord LIMIT 1
        ) sec ON true
        LEFT JOIN LATERAL (
          SELECT greatest(1, pos.at - 160) AS win_start,
                 substr(t.text, greatest(1, pos.at - 160), char_length(${term}) + 320) AS win,
                 char_length(t.text) AS text_len
            FROM page_texts t
            CROSS JOIN LATERAL (
              SELECT CASE WHEN top.grade = 5 THEN regexp_instr(t.text, ${re}, 1, 1, 0, 'i')
                          ELSE strpos(lower(t.text), lower(${term})) END AS at
            ) pos
           WHERE t.page_id = top.id AND top.grade >= 5
        ) body ON true
       ORDER BY top.grade, top.updated_at DESC, top.id
    `),
  )) as unknown as Row[]

  if (rows.length === 0) return empty
  const rawCounts = rows[0].counts
  const counts = (typeof rawCounts === 'string' ? JSON.parse(rawCounts) : rawCounts ?? []) as { id: string; name: string; n: number }[]
  const results = rows.map((r): AgentSearchHit => {
    const g = GRADE[r.grade] ?? GRADE[6]
    const hit: AgentSearchHit = {
      id: r.id,
      workspaceId: r.workspaceId,
      title: r.title,
      kind: r.kind,
      scope: r.scope,
      updatedAt: new Date(r.updatedAt).toISOString(),
      match: g.match,
      exact: g.exact,
    }
    if (r.anchor) {
      hit.anchor = r.anchor
      hit.shortAnchor = shortAnchors(r.anchors ?? [r.anchor]).get(r.anchor) ?? r.anchor
      hit.headingPath = r.headingPath ?? ''
    }
    if (g.match === 'body' && r.win !== null && r.win !== undefined) {
      const start = Number(r.winStart ?? 1)
      hit.snippet = searchSnippet(r.win, term, {
        exact: g.exact,
        atStart: start <= 1,
        atEnd: start - 1 + [...r.win].length >= Number(r.textLen ?? 0),
      })
    }
    return hit
  })
  return {
    results,
    total: counts.reduce((n, c) => n + Number(c.n), 0),
    workspaces: counts.map((c) => ({ id: c.id, name: c.name, matches: Number(c.n) })),
    limit,
  }
}

export async function registerAgentSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { q, workspaceId, limit } = querySchema.parse(req.query)
    // One workspace: the same membership, range, 2FA and agent-block checks (and errors) as the
    // web search route. All: the workspaces find_context searches (retrieve.ts memberWorkspaceIds).
    let workspaceIds: string[]
    if (workspaceId) {
      await requireMembership(workspaceId, user.id)
      workspaceIds = [workspaceId]
    } else workspaceIds = await memberWorkspaceIds(user.id)
    return agentSearch({ userId: user.id, q, workspaceIds, limit: limit ?? SEARCH_DEFAULT_LIMIT })
  })
}
