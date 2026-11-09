import { asc, inArray, sql } from 'drizzle-orm'
import { wrapUntrusted } from '../mcpTools/trust'
import { db } from '../db/index'
import { pageChanges, pageChunks } from '../db/schema'
import { env } from '../env'
import { visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { agentAllowedSql } from '../agentAccess'
import { reserveCursor } from './changeLog'
import { diffText } from './diff'
import type { WorkBudget } from './diff'
import { estimateTokens, truncateToTokens } from './tokens'
import { pageInRangeSql } from '../tokenRange'
import { twoFactorBlockedSql } from '../twoFactorPolicy'

/**
 * Change feed reader: `changes_since(cursor)` (docs/adr/0932-*, diff: 0933-*).
 *
 * 1. Rows after the cursor, up to the end reserved now, at most FEED_MAX_ROWS. Permissions are SQL:
 *    live membership, the row's visibility AT LOG TIME (scope/owner_id: rows the caller could not
 *    see then are skipped entirely), and the page's visibility NOW (title/text only when visible).
 * 2. Fold per page and per section into NET changes: the state at the cursor (before of the first
 *    row) against now (after of the last row) — add-then-delete cancels, repeated edits collapse,
 *    renames are followed across anchors. Only metadata and md5s are read in this pass.
 * 3. Pack into the token budget greedily in log order, fetching texts in batches; the entry that
 *    overflows is truncated and the rest are listed without detail; when even the one-line list
 *    no longer fits, output stops and the next cursor points just before the first unlisted entry.
 */

export const FEED_DEFAULT_BUDGET = 3_000
export const FEED_MAX_BUDGET = 12_000
export const FEED_MIN_BUDGET = 300
export const FEED_MAX_ROWS = 2_000
/** Share of the budget kept for the one-line list of the entries after the detailed ones. */
const LIST_RESERVE = 0.25
/** Fixed allowance for the header/footer lines. */
const FRAME_TOKENS = 110 // +20 for the <untrusted_content> wrapper (docs/adr/0976-*)
const TEXT_BATCH = 40
const PAGE_TEXT_BATCH = 5
const MAX_ACTORS_SHOWN = 3
/**
 * Diff work for all entries of one call (deterministic counter, ~10× one diff's cap); once spent,
 * remaining modified entries say "large change".
 */
const CALL_DIFF_WORK = 40_000_000

export type FeedDetail = 'none' | 'diff' | 'full'

export class FeedError extends Error {
  constructor(
    public code: 'INVALID_CURSOR' | 'CURSOR_WORKSPACE',
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

export interface FeedCursor {
  /** Every row with seq ≤ this was delivered (or never visible to the holder). */
  seq: number
  /** Database time (ms) no later than the change time of any row after `seq` (retention check). */
  at: number
  /** Workspace filter the cursor was issued for (null = all workspaces). */
  ws: string | null
}

const CURSOR_RE = /^c1\.(\d{1,15})\.(\d{1,15})\.([0-9a-f-]{36})?$/

export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(`c1.${c.seq}.${c.at}.${c.ws ?? ''}`, 'utf8').toString('base64url')
}

export function decodeCursor(s: string): FeedCursor | null {
  if (typeof s !== 'string' || s.length > 128 || !/^[A-Za-z0-9_-]+$/.test(s)) return null
  const m = CURSOR_RE.exec(Buffer.from(s, 'base64url').toString('utf8'))
  if (!m) return null
  return { seq: Number(m[1]), at: Number(m[2]), ws: m[3] ?? null }
}

// ---------------------------------------------------------------------------
// fold (pure)
// ---------------------------------------------------------------------------

export interface FeedRow {
  seq: number
  pageId: string
  anchor: string | null
  prevAnchor: string | null
  headingPath: string
  kind: string
  hasBefore: boolean
  hasAfter: boolean
  bh: string | null
  ah: string | null
  /** before/after for page-level kinds and moved rows (short values). */
  smallBefore: string | null
  smallAfter: string | null
  actorName: string | null
  via: string | null
  changedAt: number
  visibleNow: boolean
  title: string | null
}

interface SecGroup {
  anchor: string
  origAnchor: string
  headingPath: string
  firstSeq: number
  textRows: number
  beforeSeq: number
  afterSeq: number
  existedBefore: boolean
  existsNow: boolean
  beforeMissing: boolean
  afterMissing: boolean
  bh: string | null
  ah: string | null
  headingChanged: boolean
  moveFrom: string | null
  moveTo: string | null
}

interface PageAgg {
  pageId: string
  visibleNow: boolean
  title: string | null
  firstSeq: number
  added: boolean
  pageLevelSeq: number | null
  titleFrom?: string | null
  titleTo?: string | null
  parentFrom?: string | null
  parentTo?: string | null
  trashedAtStart: boolean | null
  trashedAtEnd: boolean | null
  scopeFrom?: string | null
  scopeTo?: string | null
  groups: SecGroup[]
  open: Map<string, SecGroup>
  actors: Map<string, { name: string | null; via: string | null }>
}

export type UnitKind = 'gone' | 'page_added' | 'page' | 'added' | 'modified' | 'removed' | 'renamed' | 'moved'

export interface FeedUnit {
  kind: UnitKind
  page: PageAgg
  firstSeq: number
  group?: SecGroup
  /** modified/renamed: the body changed (renamed may be heading-only). */
  textChanged?: boolean
  moved?: boolean
  large?: boolean
}

const TEXT_KINDS = new Set(['added', 'modified', 'removed', 'renamed'])

function newGroup(anchor: string, origAnchor: string, row: FeedRow): SecGroup {
  return {
    anchor,
    origAnchor,
    headingPath: row.headingPath,
    firstSeq: row.seq,
    textRows: 0,
    beforeSeq: 0,
    afterSeq: 0,
    existedBefore: true,
    existsNow: true,
    beforeMissing: false,
    afterMissing: false,
    bh: null,
    ah: null,
    headingChanged: false,
    moveFrom: null,
    moveTo: null,
  }
}

/** Rows (seq order) → net units, ordered by the first seq of each page then of each unit. */
export function foldRows(rows: FeedRow[]): FeedUnit[] {
  const byPage = new Map<string, PageAgg>()
  for (const r of rows) {
    let p = byPage.get(r.pageId)
    if (!p) {
      p = {
        pageId: r.pageId,
        visibleNow: r.visibleNow,
        title: r.title,
        firstSeq: r.seq,
        added: false,
        pageLevelSeq: null,
        trashedAtStart: null,
        trashedAtEnd: null,
        groups: [],
        open: new Map(),
        actors: new Map(),
      }
      byPage.set(r.pageId, p)
    }
    if (r.actorName || r.via) p.actors.set(`${r.actorName ?? ''}\u0000${r.via ?? ''}`, { name: r.actorName, via: r.via })

    if (r.anchor === null) {
      p.pageLevelSeq ??= r.seq
      switch (r.kind) {
        case 'page_added':
          p.added = true
          break
        case 'page_renamed':
          if (p.titleFrom === undefined) p.titleFrom = r.smallBefore
          p.titleTo = r.smallAfter
          break
        case 'page_moved':
          if (p.parentFrom === undefined) p.parentFrom = r.smallBefore
          p.parentTo = r.smallAfter
          break
        case 'page_trashed':
        case 'page_restored':
          p.trashedAtStart ??= r.kind === 'page_restored'
          p.trashedAtEnd = r.kind === 'page_trashed'
          break
        case 'page_visibility':
          if (p.scopeFrom === undefined) p.scopeFrom = r.smallBefore
          p.scopeTo = r.smallAfter
          break
      }
      continue
    }

    let g: SecGroup | undefined
    if (r.kind === 'renamed' && r.prevAnchor && r.prevAnchor !== r.anchor) {
      g = p.open.get(r.prevAnchor)
      if (g) p.open.delete(r.prevAnchor)
      else {
        g = newGroup(r.anchor, r.prevAnchor, r)
        p.groups.push(g)
      }
      g.anchor = r.anchor
      p.open.set(r.anchor, g) // an older group under the same anchor stays in p.groups, closed
    } else {
      g = p.open.get(r.anchor)
      if (!g) {
        g = newGroup(r.anchor, r.anchor, r)
        p.groups.push(g)
        p.open.set(r.anchor, g)
      }
    }
    g.headingPath = r.headingPath
    if (r.kind === 'moved') {
      if (g.moveFrom === null) g.moveFrom = r.smallBefore
      g.moveTo = r.smallAfter
      continue
    }
    if (!TEXT_KINDS.has(r.kind)) continue
    if (r.kind === 'renamed' && r.prevAnchor === r.anchor) g.headingChanged = true
    if (g.textRows === 0) {
      g.existedBefore = r.kind !== 'added'
      g.beforeSeq = r.seq
      g.bh = r.bh
      g.beforeMissing = g.existedBefore && !r.hasBefore
    }
    g.textRows++
    g.afterSeq = r.seq
    g.existsNow = r.kind !== 'removed'
    g.ah = r.ah
    g.afterMissing = g.existsNow && !r.hasAfter
  }

  // Explicit total order (seq is unique; pageId/anchor only break impossible ties) — never Map order.
  const pagesInOrder = [...byPage.values()].sort((a, b) => a.firstSeq - b.firstSeq || cmp(a.pageId, b.pageId))
  const units: FeedUnit[] = []
  for (const p of pagesInOrder) {
    if (!p.visibleNow) {
      // Created and gone within the window: the holder never knew it existed.
      if (!p.added) units.push({ kind: 'gone', page: p, firstSeq: p.firstSeq })
      continue
    }
    if (p.added) {
      units.push({ kind: 'page_added', page: p, firstSeq: p.firstSeq })
      continue
    }
    if (hasPageLevelChange(p)) units.push({ kind: 'page', page: p, firstSeq: p.pageLevelSeq ?? p.firstSeq })
    const secUnits: FeedUnit[] = []
    for (const g of p.groups) {
      const moved = g.moveFrom !== null && g.moveFrom !== g.moveTo
      if (g.textRows === 0) {
        if (moved) secUnits.push({ kind: 'moved', page: p, firstSeq: g.firstSeq, group: g })
        continue
      }
      if (!g.existedBefore && !g.existsNow) continue
      if (!g.existedBefore) {
        secUnits.push({ kind: 'added', page: p, firstSeq: g.firstSeq, group: g, large: g.afterMissing })
        continue
      }
      if (!g.existsNow) {
        secUnits.push({ kind: 'removed', page: p, firstSeq: g.firstSeq, group: g })
        continue
      }
      const large = g.beforeMissing || g.afterMissing
      const textChanged = large || g.bh !== g.ah
      const renamed = g.origAnchor !== g.anchor || g.headingChanged
      if (renamed) secUnits.push({ kind: 'renamed', page: p, firstSeq: g.firstSeq, group: g, textChanged, moved, large })
      else if (textChanged) secUnits.push({ kind: 'modified', page: p, firstSeq: g.firstSeq, group: g, textChanged, moved, large })
      else if (moved) secUnits.push({ kind: 'moved', page: p, firstSeq: g.firstSeq, group: g })
    }
    secUnits.sort((a, b) => a.firstSeq - b.firstSeq || cmp(a.group?.anchor ?? '', b.group?.anchor ?? ''))
    units.push(...secUnits)
  }
  return units
}

/** Code-unit order (locale-independent, so output never depends on the server's locale). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function hasPageLevelChange(p: PageAgg): boolean {
  return (
    (p.titleFrom !== undefined && p.titleFrom !== p.titleTo) ||
    (p.parentFrom !== undefined && p.parentFrom !== p.parentTo) ||
    (p.trashedAtStart === true && p.trashedAtEnd === false) ||
    (p.scopeFrom !== undefined && p.scopeFrom !== p.scopeTo)
  )
}

// ---------------------------------------------------------------------------
// formatting (pure)
// ---------------------------------------------------------------------------

const quote = (s: string | null | undefined) => `"${(s ?? '').replace(/\s+/g, ' ').trim() || 'Untitled'}"`

function provenance(p: PageAgg): string {
  const parts: string[] = []
  for (const a of p.actors.values()) {
    if (a.name && a.via) parts.push(`by ${a.name} via ${a.via}`)
    else if (a.name) parts.push(`by ${a.name}`)
    else if (a.via) parts.push(`via ${a.via}`)
  }
  if (parts.length === 0) return ''
  parts.sort(cmp)
  const shown = parts.slice(0, MAX_ACTORS_SHOWN).join('; ')
  return ` (${shown}${parts.length > MAX_ACTORS_SHOWN ? `; +${parts.length - MAX_ACTORS_SHOWN} more` : ''})`
}

export function pageHeader(p: PageAgg): string {
  return `page ${quote(p.title)} ${p.pageId}${provenance(p)}`
}

const hp = (g: SecGroup) => (g.headingPath ? ` (${g.headingPath})` : '')

/** First line of a unit (indented under its page header, except page-level units). */
export function unitHead(u: FeedUnit, parentTitles: Map<string, string>): string[] {
  const p = u.page
  const g = u.group
  switch (u.kind) {
    case 'gone':
      return [`page ${p.pageId}: removed (no longer visible)`]
    case 'page_added':
      return [`page added: ${quote(p.title)} ${p.pageId}${provenance(p)}`]
    case 'page': {
      const out: string[] = []
      if (p.titleFrom !== undefined && p.titleFrom !== p.titleTo) out.push(`  title: ${quote(p.titleFrom)} → ${quote(p.titleTo)}`)
      if (p.parentFrom !== undefined && p.parentFrom !== p.parentTo) {
        const to = p.parentTo ? parentTitles.get(p.parentTo) : undefined
        out.push(p.parentTo ? `  moved under ${to ? quote(to) : 'another page'}${to ? ` ${p.parentTo}` : ''}` : '  moved to the top level')
      }
      if (p.trashedAtStart === true && p.trashedAtEnd === false) out.push('  restored from trash')
      if (p.scopeFrom !== undefined && p.scopeFrom !== p.scopeTo) out.push(`  visibility: ${p.scopeFrom ?? '?'} → ${p.scopeTo ?? '?'}`)
      return out
    }
    case 'added':
      return [`  added ${g!.anchor}${hp(g!)}${u.large ? ': large change, read section' : ''}`]
    case 'removed':
      return [`  removed ${g!.origAnchor}${hp(g!)}`]
    case 'moved':
      return [`  moved ${g!.anchor}${hp(g!)}: position ${Number(g!.moveFrom) + 1} → ${Number(g!.moveTo) + 1}`]
    case 'modified':
      return [`  modified ${g!.anchor}${hp(g!)}${u.moved ? ', moved' : ''}${u.large ? ': large change, read section' : ''}`]
    case 'renamed': {
      const name = g!.origAnchor !== g!.anchor ? `${g!.origAnchor} → ${g!.anchor}` : `${g!.anchor} (heading text)`
      const extra = u.textChanged ? (u.large ? ', body changed: large change, read section' : ', body changed') : ''
      return [`  renamed ${name}${hp(g!)}${u.moved ? ', moved' : ''}${extra}`]
    }
  }
}

const indent = (lines: string[], pad = '    ') => lines.map((l) => (l === '' ? '' : pad + l))

/** Detail lines of a unit given its texts; null = no detail for this kind. */
export function unitBody(
  u: FeedUnit,
  detail: FeedDetail,
  before: string | null,
  after: string | null,
  pageContent: string | null,
  work: WorkBudget = { left: Infinity },
): string[] | null {
  if (detail === 'none' || u.large) return null
  switch (u.kind) {
    case 'page_added':
      return pageContent ? indent(pageContent.split('\n'), '  ') : null
    case 'added':
      return after !== null && after !== '' ? indent(after.split('\n')) : null
    case 'modified':
    case 'renamed': {
      if (!u.textChanged || before === null || after === null) return null
      if (detail === 'full') return indent(after.split('\n'))
      const d = diffText(before, after, undefined, work)
      if (d.large) return ['    (large change, read section)']
      return indent(d.lines)
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// read (SQL)
// ---------------------------------------------------------------------------

export interface FeedOptions {
  cursor?: string
  workspaceId?: string
  budget?: number
  detail?: FeedDetail
}

export interface FeedResult {
  status: 'start' | 'ok' | 'resync_required'
  cursor: string
  text: string
  /** Net changes listed / with detail / without detail. */
  changes: number
  detailed: number
  listedOnly: number
  /** Log rows read. */
  rows: number
  /** True when more changes remain after the returned cursor. */
  more: boolean
}

const DAY_MS = 24 * 60 * 60 * 1_000
const HOUR_MS = 60 * 60 * 1_000

/**
 * Cursor time is floored to the hour: still ≤ the change time of every later row (safe for the
 * retention check, at most an hour conservative), and the cursor string stays identical while
 * nothing is logged within the hour (prompt-cache friendly output).
 */
const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS

// Output layout: stable text first, the cursor alone on the LAST line (it is the only part that
// varies between two calls over the same document state).
function startText(cursor: string): string {
  return (
    'Start tracking from here: store this cursor. In a later session call changes_since with it and update only ' +
    'what changed instead of re-reading pages; every call returns the next cursor.\n' +
    `cursor: ${cursor}`
  )
}

function resyncText(cursor: string, why: string): string {
  return (
    `resync_required: ${why}\n` +
    'Store the fresh cursor below FIRST, then resync: list_pages for each workspace and re-read what you need with ' +
    'find_context / read_pages. Afterwards call changes_since with the fresh cursor; nothing that changes during the ' +
    'resync is lost.\n' +
    `fresh cursor: ${cursor}`
  )
}

async function loadRows(userId: string, from: number, to: number, workspaceId: string | null): Promise<FeedRow[]> {
  const wsFilter = workspaceId ? sql`AND m.workspace_id = ${workspaceId}` : sql``
  const visibleNow = sql`(pages.id IS NOT NULL AND pages.deleted_at IS NULL AND ${visibleTo(userId)})`
  const rows = (await db.execute(sql`
    SELECT c.seq::text AS seq, c.page_id AS "pageId", c.anchor, c.prev_anchor AS "prevAnchor",
           c.heading_path AS "headingPath", c.kind,
           c.before_text IS NOT NULL AS "hasBefore", c.after_text IS NOT NULL AS "hasAfter",
           md5(c.before_text) AS bh, md5(c.after_text) AS ah,
           CASE WHEN c.anchor IS NULL OR c.kind = 'moved' THEN left(c.before_text, 400) END AS "smallBefore",
           CASE WHEN c.anchor IS NULL OR c.kind = 'moved' THEN left(c.after_text, 400) END AS "smallAfter",
           u.name AS "actorName", c.via_client AS via,
           (extract(epoch from c.changed_at) * 1000)::float8 AS "changedAt",
           ${visibleNow} AS "visibleNow",
           CASE WHEN ${visibleNow} THEN pages.title END AS title
      FROM page_changes c
      LEFT JOIN pages ON pages.id = c.page_id
      LEFT JOIN users u ON u.id = c.actor_id
     WHERE c.seq > ${from}::bigint AND c.seq <= ${to}::bigint
       AND c.workspace_id IN (
             SELECT m.workspace_id FROM workspace_members m
              WHERE m.user_id = ${userId} ${wsFilter} AND ${liveWorkspace(sql`m.workspace_id`)}
                AND ${agentAllowedSql(sql`m.workspace_id`)}
                -- a workspace whose 2FA requirement blocks the user is left out (docs/adr/1112-*, 1300-*)
                AND NOT ${twoFactorBlockedSql(sql`m.workspace_id`, userId)})
       AND (c.scope = 'shared' OR c.owner_id = ${userId})
       -- a range-limited connection sees only changes of pages in its range (docs/adr/1200-*)
       AND ${pageInRangeSql(sql`c.page_id`, sql`c.workspace_id`, userId)}
     ORDER BY c.seq
     LIMIT ${FEED_MAX_ROWS + 1}
  `)) as unknown as (Omit<FeedRow, 'seq' | 'changedAt'> & { seq: string; changedAt: number })[]
  return rows.map((r) => ({ ...r, seq: Number(r.seq), changedAt: Number(r.changedAt) }))
}

/** Titles of visible pages (for "moved under …"). */
async function visibleTitles(userId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const rows = (await db.execute(sql`
    SELECT pages.id, pages.title FROM pages
     WHERE pages.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND pages.deleted_at IS NULL AND ${visibleTo(userId)} AND ${liveWorkspace(sql`pages.workspace_id`)}
  `)) as unknown as { id: string; title: string }[]
  for (const r of rows) out.set(r.id, r.title)
  return out
}

/** Lazy text loader for the packer: texts by seq and current page content, in batches. */
class TextLoader {
  private texts = new Map<number, { before: string | null; after: string | null }>()
  private content = new Map<string, string>()
  constructor(private units: FeedUnit[]) {}

  async ensure(i: number): Promise<void> {
    const u = this.units[i]
    if (u.kind === 'page_added') {
      if (this.content.has(u.page.pageId)) return
      const ids: string[] = []
      for (let j = i; j < this.units.length && ids.length < PAGE_TEXT_BATCH; j++) {
        const v = this.units[j]
        if (v.kind === 'page_added' && !this.content.has(v.page.pageId)) ids.push(v.page.pageId)
      }
      const rows = await db
        .select({ pageId: pageChunks.pageId, anchor: pageChunks.anchor, headingPath: pageChunks.headingPath, part: pageChunks.part, text: pageChunks.text })
        .from(pageChunks)
        .where(inArray(pageChunks.pageId, ids))
        .orderBy(asc(pageChunks.pageId), asc(pageChunks.ord))
      const acc = new Map<string, string[]>(ids.map((id) => [id, []]))
      for (const r of rows) {
        const lines = acc.get(r.pageId)!
        if (r.part === 0 && r.headingPath) lines.push(`# ${r.headingPath}`)
        lines.push(r.text)
      }
      for (const [id, lines] of acc) this.content.set(id, lines.join('\n'))
      return
    }
    const g = u.group
    if (!g || g.textRows === 0 || this.texts.has(g.afterSeq)) return
    const seqs = new Set<number>()
    for (let j = i; j < this.units.length && seqs.size < TEXT_BATCH * 2; j++) {
      const v = this.units[j].group
      if (!v || v.textRows === 0) continue
      if (!this.texts.has(v.beforeSeq)) seqs.add(v.beforeSeq)
      if (!this.texts.has(v.afterSeq)) seqs.add(v.afterSeq)
    }
    const rows = await db
      .select({ seq: pageChanges.seq, before: pageChanges.beforeText, after: pageChanges.afterText })
      .from(pageChanges)
      .where(inArray(pageChanges.seq, [...seqs]))
    for (const r of rows) this.texts.set(Number(r.seq), { before: r.before, after: r.after })
  }

  before(u: FeedUnit): string | null {
    return u.group ? (this.texts.get(u.group.beforeSeq)?.before ?? null) : null
  }
  after(u: FeedUnit): string | null {
    return u.group ? (this.texts.get(u.group.afterSeq)?.after ?? null) : null
  }
  pageContent(u: FeedUnit): string | null {
    return this.content.get(u.page.pageId) ?? null
  }
}

function clampBudget(b: number | undefined): number {
  if (b === undefined || !Number.isFinite(b)) return FEED_DEFAULT_BUDGET
  return Math.min(FEED_MAX_BUDGET, Math.max(FEED_MIN_BUDGET, Math.floor(b)))
}

export async function readChangeFeed(userId: string, opts: FeedOptions): Promise<FeedResult> {
  const ws = opts.workspaceId ?? null
  const detail = opts.detail ?? 'diff'
  const budget = clampBudget(opts.budget)
  const empty = { changes: 0, detailed: 0, listedOnly: 0, rows: 0, more: false }

  if (!opts.cursor) {
    const r = await reserveCursor()
    const cursor = encodeCursor({ seq: r.seq, at: floorHour(r.at), ws })
    return { status: 'start', cursor, text: startText(cursor), ...empty }
  }
  const c = decodeCursor(opts.cursor)
  if (!c) {
    throw new FeedError('INVALID_CURSOR', 'invalid cursor: call changes_since without a cursor to get a fresh one')
  }
  if (c.ws && c.ws !== ws) {
    throw new FeedError(
      'CURSOR_WORKSPACE',
      `this cursor was issued for workspace ${c.ws}: call changes_since with workspaceId ${c.ws}, or without a cursor to start over`,
    )
  }
  const end = await reserveCursor()
  const retentionMs = env.changeFeedRetentionDays * DAY_MS
  if (c.at < end.at - retentionMs || c.seq > end.seq) {
    const cursor = encodeCursor({ seq: end.seq, at: floorHour(end.at), ws })
    const why =
      c.seq > end.seq
        ? 'this cursor does not match this server’s change history (restored or different server).'
        : `this cursor is older than the ${env.changeFeedRetentionDays}-day change history.`
    return { status: 'resync_required', cursor, text: resyncText(cursor, why), ...empty }
  }

  let rows = await loadRows(userId, c.seq, end.seq, ws)
  const capped = rows.length > FEED_MAX_ROWS
  if (capped) rows = rows.slice(0, FEED_MAX_ROWS)
  const scanEnd = capped ? rows[rows.length - 1].seq : end.seq

  const units = foldRows(rows)
  const parentIds = new Set<string>()
  for (const u of units) if (u.kind === 'page' && u.page.parentTo) parentIds.add(u.page.parentTo)
  const parentTitles = await visibleTitles(userId, [...parentIds])

  // ---- pack ----
  const heads = units.map((u) => unitHead(u, parentTitles))
  const headTokens = heads.map((h) => estimateTokens(h.join('\n')) + 1)
  const suffix = new Array<number>(units.length + 1).fill(0)
  for (let i = units.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + headTokens[i]
  const reserveCap = Math.floor(budget * LIST_RESERVE)
  const loader = new TextLoader(units)
  const out: string[] = []
  let used = FRAME_TOKENS
  let mode: 'detail' | 'list' = detail === 'none' ? 'list' : 'detail'
  let lastPage: string | null = null
  let detailed = 0
  let listedOnly = 0
  let truncatedOne = false
  let cutAt = -1
  const diffWork: WorkBudget = { left: CALL_DIFF_WORK }
  // Progress guarantee: never cut before the unit holding the smallest first seq is listed (a page's
  // page-level unit precedes its section units but may have a larger seq); otherwise the next
  // cursor would not advance past the given one and an agent following it would loop.
  let globalMinSeq = Infinity
  for (const u of units) globalMinSeq = Math.min(globalMinSeq, u.firstSeq)
  let listedMinSeq = Infinity
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const needsHeader = (u.kind === 'page' || isSectionUnit(u.kind)) && lastPage !== u.page.pageId
    const header = needsHeader ? [pageHeader(u.page)] : []
    const head = [...header, ...heads[i]]
    const hTok = estimateTokens(head.join('\n')) + 1
    if (mode === 'detail') {
      await loader.ensure(i)
      const body = unitBody(u, detail, loader.before(u), loader.after(u), loader.pageContent(u), diffWork)
      const bTok = body ? estimateTokens(body.join('\n')) + 1 : 0
      const rest = Math.min(suffix[i + 1], reserveCap)
      if (used + hTok + bTok + rest <= budget) {
        out.push(...head, ...(body ?? []))
        used += hTok + bTok
        lastPage = u.page.pageId
        listedMinSeq = Math.min(listedMinSeq, u.firstSeq)
        if (body) detailed++
        continue
      }
      mode = 'list'
      const room = budget - used - hTok - rest
      if (body && room >= 40) {
        const cut = truncateToTokens(body.join('\n'), room - 12)
        out.push(...head, cut.text, '    … (cut to fit the budget: read the section for the rest)')
        used += hTok + estimateTokens(cut.text) + 12
        lastPage = u.page.pageId
        listedMinSeq = Math.min(listedMinSeq, u.firstSeq)
        detailed++
        truncatedOne = true
        continue
      }
    }
    if (used + hTok > budget && listedMinSeq === globalMinSeq) {
      cutAt = i
      break
    }
    out.push(...head)
    used += hTok
    lastPage = u.page.pageId
    listedMinSeq = Math.min(listedMinSeq, u.firstSeq)
    const hasDetail = detail !== 'none' && !u.large && (u.kind === 'added' || u.kind === 'page_added' || u.textChanged)
    if (hasDetail) listedOnly++
  }

  // ---- next cursor ----
  let nextSeq = scanEnd
  if (cutAt >= 0) {
    let minFirst = Infinity
    for (let i = cutAt; i < units.length; i++) minFirst = Math.min(minFirst, units[i].firstSeq)
    nextSeq = Math.min(scanEnd, minFirst - 1)
  }
  let nextAt = c.at
  if (nextSeq === end.seq) nextAt = end.at
  else {
    // Rows after nextSeq were logged no earlier than the last row at or before it (seq order == commit order).
    for (const r of rows) {
      if (r.seq > nextSeq) break
      nextAt = Math.floor(r.changedAt)
    }
  }
  const cursor = encodeCursor({ seq: nextSeq, at: floorHour(nextAt), ws })
  const more = capped || cutAt >= 0
  const shown = cutAt >= 0 ? cutAt : units.length

  const pagesShown = new Set(units.slice(0, shown).map((u) => u.page.pageId)).size
  const lines: string[] = []
  if (shown === 0 && !more) {
    lines.push('No changes since the cursor.')
  } else {
    lines.push(`${shown} change${shown === 1 ? '' : 's'} in ${pagesShown} page${pagesShown === 1 ? '' : 's'}.`)
    // Titles, headings and diffs are member-written: one data block (docs/adr/0976-*).
    if (out.length) lines.push(wrapUntrusted(out.join('\n'), { source: 'changes' }))
    if (listedOnly > 0 || truncatedOne) {
      lines.push(
        `truncated: ${listedOnly} change${listedOnly === 1 ? '' : 's'} listed without detail${truncatedOne ? ' and one cut short' : ''} (budget ${budget} tokens): read those sections with read_pages, or call again with the same cursor and a larger budget.`,
      )
    }
    if (more) lines.push('more changes remain: call changes_since with the next cursor.')
  }
  lines.push(`next cursor: ${cursor}`)
  return {
    status: 'ok',
    cursor,
    text: lines.join('\n'),
    changes: shown,
    detailed,
    listedOnly,
    rows: rows.length,
    more,
  }
}

function isSectionUnit(k: UnitKind): boolean {
  return k === 'added' || k === 'modified' || k === 'removed' || k === 'renamed' || k === 'moved'
}
