import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db/index'
import { agentAllowedSql } from '../agentAccess'
import { escapeLike } from '../util'
import type { Candidate, Fragment, Scored, SectionLabel, TermGroup } from './rank'
import { fullLabel, groupTsquery, idf, pack, queryGroups, scoreCandidate, TOP_K, TopK, UNSEEN_WEIGHT } from './rank'
import { headingTail, shortAnchors } from './chunker'
import { isCjkCode } from './tokens'
import { pageInRangeSql } from '../tokenRange'
import { twoFactorBlockedSql } from '../twoFactorPolicy'

/**
 * find_context retrieval (docs/adr/0927-*, 1210-*–1212-*): candidate chunks from three index probes
 * (full-text OR-prefix query on the section index, trigram ILIKE on chunk text, page titles),
 * permission filtered in SQL (live workspaces the user belongs to, live pages, visibleTo), word
 * weights (idf) from the same query, ranked in Node with a size-k heap, diversified per page and
 * packed into a token budget with short section anchors.
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
  /** Benchmarks only: 'full' prints the full anchor and heading path (the pre-1212 location format). */
  location?: 'short' | 'full'
  /** Benchmarks only: receives the word weights and the ranked candidates (never used by routes). */
  explain?: (info: { groups: TermGroup[]; df: number[]; n: number; idf: number[]; ranked: Scored[]; candidates: number }) => void
}

export interface FindContextResult {
  fragments: Fragment[]
  /** Relevant sections that did not fit the budget. */
  more: { pageId: string; title: string; anchor: string; headingPath: string; short: string; heading: string; tokens: number }[]
  /** Pages whose title matches but that have no indexed text (folders, collections, empty pages). */
  titleOnly: { pageId: string; title: string; kind: string }[]
  budget: number
  usedTokens: number
  candidates: number
}

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/**
 * Workspace ids the user is a member of, excluding soft-deleted workspaces, workspaces whose
 * two-step verification requirement blocks the user (docs/adr/1112-*, 1300-*) and, for an agent
 * request, workspaces that blocked that agent connection (docs/adr/0947-*). find_context without a
 * workspace and read_pages read through this list.
 */
export async function memberWorkspaceIds(userId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT wm.workspace_id AS id FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ${userId} AND w.deleted_at IS NULL AND ${agentAllowedSql(sql`wm.workspace_id`)}
       AND NOT ${twoFactorBlockedSql(sql`wm.workspace_id`, userId)}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/** The visibleTo() rule (pageDto.ts) for raw SQL over the alias `p`, connection range included (docs/adr/1200-*). */
function visibleSql(userId: string): SQL {
  return sql`(p.scope = 'shared' OR (p.scope = 'private' AND p.created_by = ${userId})) AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)}`
}

export async function findContext(opts: FindContextOptions): Promise<FindContextResult> {
  const budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(opts.budget ?? DEFAULT_BUDGET)))
  const groups = queryGroups(opts.query)
  const terms = groups.flatMap((g) => g.variants)
  const empty: FindContextResult = { fragments: [], more: [], titleOnly: [], budget, usedTokens: 0, candidates: 0 }
  if (terms.length === 0 || opts.workspaceIds.length === 0) return empty

  const ws = uuidArray(opts.workspaceIds)
  // Prefixes, whole-word particle forms and split compounds of every group (docs/adr/1700-*).
  const tsq = groups.map(groupTsquery).join(' | ')
  // Trigram (infix) probes only for CJK terms of 3+ characters: Korean compounds have no spaces,
  // so "최적화" sits inside "성능최적화". Shorter terms have no trigrams (whole-index scan), and for
  // spaced languages the prefix query already finds words; an ILIKE recheck over thousands of
  // chunks was the slowest part of the query (ADR 0927).
  const isInfix = (t: string) => [...t].length >= 3 && isCjkCode(t.charCodeAt(0))
  const long = terms.filter((t) => [...t].length >= 3)
  const infix = long.filter(isInfix)
  const textLike = infix.length
    ? sql.join(infix.map((t) => sql`c.text ILIKE ${`%${escapeLike(t)}%`}`), sql` OR `)
    : null
  // A page's aliases are other names for it and count as its title (docs/adr/1701-*). jsonb text
  // keeps non-ASCII characters as they are; brackets and quotes are word separators for the parser.
  // Most pages have none, so the alias test runs only where the array is not empty.
  const hasAliases = sql`p.aliases <> '[]'::jsonb`
  const inTitle = (cond: (field: SQL) => SQL) => sql`(${cond(sql`p.title`)} OR (${hasAliases} AND ${cond(sql`p.aliases::text`)}))`
  const likeIn = (field: SQL, pattern: string) => sql`${field} ILIKE ${`%${escapeLike(pattern)}%`}`
  const titleLike = long.length ? sql.join(long.map((t) => inTitle((f) => likeIn(f, t))), sql` OR `) : sql`false`
  const titleCond = sql`(${inTitle((f) => sql`to_tsvector('simple'::regconfig, ${f}) @@ q.tsq`)} OR ${titleLike})`

  // Per query word (all its forms): does the chunk contain it (stored vector, + infix ILIKE), does
  // the page title contain it. Computed once per candidate row; the document frequencies and the
  // coarse order both come from these flags (docs/adr/1210-*).
  // Each group's tsquery is parsed once in the `q` row instead of once per candidate row (to_tsquery
  // is STABLE, not folded; with the particle forms a group's query has up to ~20 lexemes).
  const groupQ = sql.join(groups.map((g, i) => sql`to_tsquery('simple', ${groupTsquery(g)}) AS ${sql.raw(`g${i}`)}`), sql`, `)
  const textMatch = groups.map((g, i) => {
    const likes = g.variants.filter(isInfix).map((v) => sql`c.text ILIKE ${`%${escapeLike(v)}%`}`)
    const tsv = sql`c.tsv @@ ${sql.raw(`q.g${i}`)}`
    return likes.length ? sql`(${tsv} OR ${sql.join(likes, sql` OR `)})` : tsv
  })
  // Whole-word particle forms and split compounds in a title or heading path (docs/adr/1700-*).
  // These flags only steer the coarse order (Node checks word boundaries exactly), so a substring
  // test is enough: the bare stem, or head + space + tail (a to_tsvector per row was measurably slower).
  const patterns = (g: (typeof groups)[number]) => [
    ...g.variants,
    ...(g.exact?.length ? [g.exact.reduce((a, b) => (b.length < a.length ? b : a))] : []),
    ...(g.splits ?? []).map(([a, b]) => `${a} ${b}`),
  ]
  const titleMatch = groups.map((g) => inTitle((f) => sql`(${sql.join(patterns(g).map((v) => likeIn(f, v)), sql` OR `)})`))
  const headingMatch = groups.map((g) => sql`(${sql.join(patterns(g).map((v) => likeIn(sql`c.heading_path`, v)), sql` OR `)})`)
  const col = (prefix: string, i: number) => sql.raw(`${prefix}${i}`)
  const mCols = sql.join(
    groups.map((_, i) => sql`(${textMatch[i]})::int AS ${col('m', i)}, (${headingMatch[i]})::int AS ${col('h', i)}`),
    sql`, `,
  )
  const tCols = sql.join(titleMatch.map((t, i) => sql`(${t})::int AS ${col('t', i)}`), sql`, `)
  const dfCols = sql.join(groups.map((_, i) => sql.raw(`coalesce(sum(m${i}), 0)::int AS d${i}`)), sql`, `)
  // Same formula as rank.ts idf(), including the df = 0 weight.
  const wCols = sql.join(
    groups.map((_, i) => sql.raw(`CASE WHEN df.d${i} = 0 THEN ${UNSEEN_WEIGHT}::float8 ELSE ln(1 + (scope.n - df.d${i} + 0.5) / (df.d${i} + 0.5)) END AS w${i}`)),
    sql`, `,
  )
  const wSum = sql.raw(groups.map((_, i) => `w.w${i}`).join(' + '))
  // Coarse order before the 300-row cut: idf-weighted share of words found (text or title) plus
  // idf-weighted title and heading shares, so a rare word outweighs several common ones here too.
  // Only integer flags and the precomputed weights: no tsvector is read here.
  const coarse = sql.raw(groups.map((_, i) => `w.w${i} * (GREATEST(matched.m${i}, t.t${i}) + 0.3::float8 * (t.t${i} + matched.h${i}))`).join(' + '))

  // Candidates from three index probes; `bonus` marks trigram (infix) hits so they are not cut by
  // the coarse ORDER BY. N = chunks in the searched workspaces and df = chunks containing the word
  // are workspace statistics (not filtered by page visibility; they only weigh words).
  const rows = (await db.execute(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsq}) AS tsq, ${groupQ}),
    cand AS (
      SELECT c.page_id, c.ord, 0::float8 AS bonus FROM page_chunks c, q
       WHERE c.workspace_id = ANY(${ws}::uuid[]) AND c.tsv @@ q.tsq
      ${textLike ? sql`UNION ALL SELECT c.page_id, c.ord, 0.05 FROM page_chunks c
       WHERE c.workspace_id = ANY(${ws}::uuid[]) AND (${textLike})` : sql``}
      UNION ALL
      SELECT c.page_id, c.ord, 0 FROM pages p JOIN page_chunks c ON c.page_id = p.id, q
       WHERE p.workspace_id = ANY(${ws}::uuid[]) AND p.deleted_at IS NULL AND ${titleCond}
         AND c.ord < ${TITLE_CHUNKS}
    ),
    best AS (
      SELECT cand.page_id, cand.ord, max(cand.bonus) AS bonus FROM cand GROUP BY cand.page_id, cand.ord
    ),
    matched AS (
      SELECT best.page_id, best.ord, best.bonus, ${mCols}
        FROM best JOIN page_chunks c ON c.page_id = best.page_id AND c.ord = best.ord CROSS JOIN q
    ),
    df AS (SELECT ${dfCols} FROM matched),
    scope AS (SELECT count(*)::float8 AS n FROM page_chunks c WHERE c.workspace_id = ANY(${ws}::uuid[])),
    w AS MATERIALIZED (SELECT ${wCols} FROM df, scope),
    ranked AS (
      SELECT matched.page_id, matched.ord
        FROM matched JOIN pages p ON p.id = matched.page_id
        CROSS JOIN LATERAL (SELECT ${tCols}) t, w
       WHERE p.deleted_at IS NULL AND ${visibleSql(opts.userId)}
       ORDER BY (${coarse}) / (${wSum}) + matched.bonus DESC, p.updated_at DESC, matched.page_id, matched.ord
       LIMIT ${CANDIDATE_LIMIT}
    )
    SELECT c.page_id AS "pageId", p.workspace_id AS "workspaceId", p.title, c.ord, c.anchor,
           c.heading_path AS "headingPath", c.part, c.text, c.token_estimate AS tokens,
           c.section_hash AS version, p.updated_at AS "updatedAt", p.aliases,
           scope.n AS "scopeChunks", to_json(df) AS df
      FROM ranked
      JOIN page_chunks c ON c.page_id = ranked.page_id AND c.ord = ranked.ord
      JOIN pages p ON p.id = c.page_id, df, scope
     ORDER BY c.page_id, c.ord
  `)) as unknown as (Omit<Candidate, 'updatedAt' | 'aliases'> & { updatedAt: Date | string; aliases: unknown; scopeChunks: number | string; df: Record<string, number> | string })[]

  // Word weights from the statistics every row carries (the same for all rows).
  const stats = rows[0]
  const dfRow = stats ? (typeof stats.df === 'string' ? (JSON.parse(stats.df) as Record<string, number>) : stats.df) : {}
  const n = stats ? Number(stats.scopeChunks) : 0
  const weights = groups.map((_, i) => idf(n, Number(dfRow[`d${i}`]) || 0))

  // Recency is measured against the newest candidate, not the clock: same documents → same output.
  let newest = 0
  for (const r of rows) newest = Math.max(newest, new Date(r.updatedAt).getTime())
  const now = opts.now ?? newest
  const phrase = opts.query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const top = new TopK<Scored>(TOP_K)
  for (const r of rows) {
    const c: Candidate = {
      pageId: r.pageId,
      workspaceId: r.workspaceId,
      title: r.title,
      ord: r.ord,
      anchor: r.anchor,
      headingPath: r.headingPath,
      part: r.part,
      text: r.text,
      tokens: r.tokens,
      version: r.version,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt),
      aliases: aliasText(r.aliases),
    }
    top.push({ ...c, score: scoreCandidate(c, { groups, idf: weights, phrase, now }) })
  }
  const ranked = top.sorted()
  opts.explain?.({ groups, df: groups.map((_, i) => Number(dfRow[`d${i}`]) || 0), n, idf: weights, ranked, candidates: rows.length })

  // Short anchors need every anchor of the pages that may be shown (docs/adr/1212-*). These page
  // ids passed the permission filter above.
  const labels = await sectionLabels([...new Set(ranked.map((c) => c.pageId))])
  const label = (c: { pageId: string; anchor: string; headingPath: string }): SectionLabel => {
    if (opts.location === 'full') return fullLabel(c)
    const short = labels.get(c.pageId)?.get(c.anchor) ?? c.anchor
    return { short, heading: headingTail(c.headingPath, short.split('/').length) }
  }
  const { fragments, usedTokens, overflow } = pack(ranked, terms, budget, { label })

  // Title-only pages (no indexed text) and the best overflow sections as pointers.
  const titleRows = (await db.execute(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsq}) AS tsq)
    SELECT p.id AS "pageId", p.title, p.kind FROM pages p, q
     WHERE p.workspace_id = ANY(${ws}::uuid[]) AND p.deleted_at IS NULL AND ${visibleSql(opts.userId)}
       AND ${titleCond}
       AND NOT EXISTS (SELECT 1 FROM page_chunks c WHERE c.page_id = p.id)
     ORDER BY p.updated_at DESC, p.id LIMIT 5
  `)) as unknown as { pageId: string; title: string; kind: string }[]

  // Every section already shown (all sections of merged fragments, not only the first).
  const shown = new Set(fragments.flatMap((f) => f.sections.map((s) => `${f.pageId}#${s.anchor}`)))
  const more: FindContextResult['more'] = []
  for (const o of overflow) {
    const key = `${o.pageId}#${o.anchor}`
    if (shown.has(key)) continue
    shown.add(key)
    const l = label(o)
    more.push({ pageId: o.pageId, title: o.title, anchor: o.anchor, headingPath: o.headingPath, short: l.short, heading: l.heading, tokens: o.tokens })
    if (more.length >= 5) break
  }
  return { fragments, more, titleOnly: titleRows, budget, usedTokens, candidates: rows.length }
}

/** pages.aliases (jsonb string[]) as one newline-separated string; '' when none. */
function aliasText(v: unknown): string {
  const arr = typeof v === 'string' ? (JSON.parse(v) as unknown) : v
  return Array.isArray(arr) ? arr.filter((a): a is string => typeof a === 'string').join('\n') : ''
}

/** Per page: anchor → short anchor (shortest suffix unique on that page). */
async function sectionLabels(pageIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>()
  if (pageIds.length === 0) return out
  const rows = (await db.execute(sql`
    SELECT page_id AS "pageId", anchor FROM page_chunks
     WHERE page_id = ANY(${uuidArray(pageIds)}::uuid[]) AND part = 0
     ORDER BY page_id, ord
  `)) as unknown as { pageId: string; anchor: string }[]
  const byPage = new Map<string, string[]>()
  for (const r of rows) {
    const list = byPage.get(r.pageId) ?? []
    list.push(r.anchor)
    byPage.set(r.pageId, list)
  }
  for (const [id, anchors] of byPage) out.set(id, shortAnchors(anchors))
  return out
}
