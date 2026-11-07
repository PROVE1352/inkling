import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db/index'
import { escapeLike } from '../util'
import type { Candidate, Fragment, Scored } from './rank'
import { pack, queryTerms, scoreCandidate, TOP_K, TopK, tsqueryText } from './rank'
import { isCjkCode } from './tokens'

/**
 * find_context retrieval (docs/adr/0927-*): candidate chunks from three index probes (full-text
 * OR-prefix query on the section index, trigram ILIKE on chunk text, page titles), permission
 * filtered in SQL (live workspaces the user belongs to, live pages, visibleTo), ranked in Node with
 * a size-k heap and packed into a token budget.
 */

export const DEFAULT_BUDGET = 3500
export const MAX_BUDGET = 12_000
export const MIN_BUDGET = 300
/** Candidate rows fetched from Postgres (ordered by a coarse SQL score). */
const CANDIDATE_LIMIT = 300
/** Chunks per title-matching page that join the candidate set. */
const TITLE_CHUNKS = 6

export interface FindContextOptions {
  userId: string
  query: string
  /** Workspaces to search (already checked for membership by the caller). */
  workspaceIds: string[]
  budget?: number
  now?: number
}

export interface FindContextResult {
  fragments: Fragment[]
  /** Relevant sections that did not fit the budget. */
  more: { pageId: string; title: string; anchor: string; headingPath: string; tokens: number }[]
  /** Pages whose title matches but that have no indexed text (folders, collections, empty pages). */
  titleOnly: { pageId: string; title: string; kind: string }[]
  budget: number
  usedTokens: number
  candidates: number
}

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/** Workspace ids the user is a member of, excluding soft-deleted workspaces. */
export async function memberWorkspaceIds(userId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT wm.workspace_id AS id FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ${userId} AND w.deleted_at IS NULL
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/** The visibleTo() rule (pageDto.ts) for raw SQL over the alias `p`. */
function visibleSql(userId: string): SQL {
  return sql`(p.scope = 'shared' OR (p.scope = 'private' AND p.created_by = ${userId}))`
}

export async function findContext(opts: FindContextOptions): Promise<FindContextResult> {
  const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(opts.budget ?? DEFAULT_BUDGET)))
  const terms = queryTerms(opts.query)
  const empty: FindContextResult = { fragments: [], more: [], titleOnly: [], budget, usedTokens: 0, candidates: 0 }
  if (terms.length === 0 || opts.workspaceIds.length === 0) return empty

  const ws = uuidArray(opts.workspaceIds)
  const tsq = tsqueryText(terms)
  // Trigram (infix) probes only for CJK terms of 3+ characters: Korean compounds have no spaces,
  // so "최적화" sits inside "성능최적화". Shorter terms have no trigrams (whole-index scan), and for
  // spaced languages the prefix query already finds words; an ILIKE recheck over thousands of
  // chunks was the slowest part of the query (ADR 0927).
  const long = terms.filter((t) => [...t].length >= 3)
  const infix = long.filter((t) => isCjkCode(t.charCodeAt(0)))
  const textLike = infix.length
    ? sql.join(infix.map((t) => sql`c.text ILIKE ${`%${escapeLike(t)}%`}`), sql` OR `)
    : null
  // Coverage: how many query terms a chunk (or its page title) contains — cheap on the stored vector.
  const coverage = sql.join(
    terms.map((t) => {
      const pat = `%${escapeLike(t)}%`
      const inText = infix.includes(t)
        ? sql`(c.tsv @@ to_tsquery('simple', ${`'${t}':*`}) OR c.text ILIKE ${pat})`
        : sql`c.tsv @@ to_tsquery('simple', ${`'${t}':*`})`
      return sql`(${inText} OR p.title ILIKE ${pat})::int`
    }),
    sql` + `,
  )
  const titleLike = long.length
    ? sql.join(long.map((t) => sql`p.title ILIKE ${`%${escapeLike(t)}%`}`), sql` OR `)
    : sql`false`
  const titleCond = sql`(to_tsvector('simple'::regconfig, p.title) @@ q.tsq OR ${titleLike})`

  // Candidates from three index probes; `bonus` marks trigram (infix) and title hits so they are
  // not cut by the coarse ORDER BY, which otherwise only sees ts_rank on the stored vector.
  const rows = (await db.execute(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsq}) AS tsq),
    cand AS (
      SELECT c.page_id, c.ord, 0::float8 AS bonus FROM page_chunks c, q
       WHERE c.workspace_id = ANY(${ws}::uuid[]) AND c.tsv @@ q.tsq
      ${textLike ? sql`UNION ALL SELECT c.page_id, c.ord, 0.05 FROM page_chunks c
       WHERE c.workspace_id = ANY(${ws}::uuid[]) AND (${textLike})` : sql``}
      UNION ALL
      SELECT c.page_id, c.ord, 0.3 FROM pages p JOIN page_chunks c ON c.page_id = p.id, q
       WHERE p.workspace_id = ANY(${ws}::uuid[]) AND p.deleted_at IS NULL AND ${titleCond}
         AND c.ord < ${TITLE_CHUNKS}
    ),
    best AS (
      SELECT cand.page_id, cand.ord, max(cand.bonus) AS bonus FROM cand GROUP BY cand.page_id, cand.ord
    ),
    ranked AS (
      SELECT best.page_id, best.ord, ts_rank(c.tsv, q.tsq) AS rank, best.bonus
        FROM best JOIN page_chunks c ON c.page_id = best.page_id AND c.ord = best.ord
        JOIN pages p ON p.id = c.page_id, q
       WHERE p.deleted_at IS NULL AND ${visibleSql(opts.userId)}
       ORDER BY (${coverage}) + ts_rank(c.tsv, q.tsq) + best.bonus DESC, p.updated_at DESC, best.page_id, best.ord
       LIMIT ${CANDIDATE_LIMIT}
    )
    SELECT c.page_id AS "pageId", p.workspace_id AS "workspaceId", p.title, c.ord, c.anchor,
           c.heading_path AS "headingPath", c.part, c.text, c.token_estimate AS tokens,
           c.section_hash AS version, p.updated_at AS "updatedAt", ranked.rank
      FROM ranked
      JOIN page_chunks c ON c.page_id = ranked.page_id AND c.ord = ranked.ord
      JOIN pages p ON p.id = c.page_id
     ORDER BY c.page_id, c.ord
  `)) as unknown as (Omit<Candidate, 'updatedAt' | 'rank'> & { updatedAt: Date | string; rank: number | string })[]

  // Recency is measured against the newest candidate, not the clock: same documents → same output.
  let newest = 0
  for (const r of rows) newest = Math.max(newest, new Date(r.updatedAt).getTime())
  const now = opts.now ?? newest
  const phrase = opts.query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const top = new TopK<Scored>(TOP_K)
  const scoredAll: Scored[] = []
  for (const r of rows) {
    const c: Candidate = {
      ...r,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt),
      rank: Number(r.rank) || 0,
    }
    const s: Scored = { ...c, score: scoreCandidate(c, { terms, phrase, now }) }
    scoredAll.push(s)
  }

  for (const s of scoredAll) top.push(s)

  const ranked = top.sorted()
  const { fragments, usedTokens, overflow } = pack(ranked, terms, budget)

  // Title-only pages (no indexed text) and the best overflow sections as pointers.
  const titleRows = (await db.execute(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsq}) AS tsq)
    SELECT p.id AS "pageId", p.title, p.kind FROM pages p, q
     WHERE p.workspace_id = ANY(${ws}::uuid[]) AND p.deleted_at IS NULL AND ${visibleSql(opts.userId)}
       AND ${titleCond}
       AND NOT EXISTS (SELECT 1 FROM page_chunks c WHERE c.page_id = p.id)
     ORDER BY p.updated_at DESC, p.id LIMIT 5
  `)) as unknown as { pageId: string; title: string; kind: string }[]

  const shownPages = new Set(fragments.map((f) => `${f.pageId}#${f.anchor}`))
  const more: FindContextResult['more'] = []
  for (const o of overflow) {
    const key = `${o.pageId}#${o.anchor}`
    if (shownPages.has(key)) continue
    shownPages.add(key)
    more.push({ pageId: o.pageId, title: o.title, anchor: o.anchor, headingPath: o.headingPath, tokens: o.tokens })
    if (more.length >= 5) break
  }
  return { fragments, more, titleOnly: titleRows, budget, usedTokens, candidates: rows.length }
}
