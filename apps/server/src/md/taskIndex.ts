import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { bumpIndexEpoch } from '../versions'
import { pageDocs, pageTaskIndex, pageTasks, pages } from '../db/schema'
import { stateToBlocks } from './convert'
import type { AnyBlock } from './convert'

/**
 * Index of tasks (checklists) inside documents.
 *
 * Only BlockNote `checkListItem` blocks whose text contains a date are extracted into page_tasks.
 * The document (Yjs) is the source of truth; this table is a derived index for calendar/due queries —
 * extraction never touches the document.
 *
 * Date syntax (by priority; only the first match in a block is used and that token is removed from the display text):
 *   1) Obsidian Tasks   `📅 2026-09-30`
 *   2) With year        `2026-09-30` · `2026.9.30` · `2026/9/30` · `2026년 9월 30일` (Korean "Y년 M월 D일")
 *   3) Without year     `9/30` · `9월 30일` → the "upcoming" date (this year, or next year if more than 60 days past)
 *   Within one priority, the earliest in the text wins. Relative words such as today/tomorrow
 *   (Korean `오늘`/`내일`/`모레`) are not parsed, because their meaning changes as time passes. BlockNote has
 *   no date mention in its schema (mentions are user/page only).
 *
 * The Korean date forms (년/월/일) and Korean Dataview keys are input syntax that existing documents
 * already use, so they keep being recognised exactly as before. English month-name dates ("Sep 30")
 * are not parsed: words like "May" or "March" would match ordinary prose.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** Max tasks per page (runaway guard) · max display text length. */
const MAX_TASKS_PER_PAGE = 500
const MAX_TEXT_LEN = 500
/** A yearless date more than this many days in the past is taken to mean next year. */
const PAST_GRACE_DAYS = 60

/** Whether the date exists on a real calendar (filters out 2/30 etc.) — judged from local fields only. */
function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

/** Day difference (b - a) between two 'YYYY-MM-DD' values, by local midnight. */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const ta = new Date(ay, am - 1, ad).getTime()
  const tb = new Date(by, bm - 1, bd).getTime()
  return Math.round((tb - ta) / 86_400_000)
}

/** Today in server local time, 'YYYY-MM-DD'. */
export function todayYmd(): string {
  const n = new Date()
  return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate())
}

/** Yearless month/day → the upcoming date (this year, or next year if more than 60 days past). null if invalid. */
export function resolveYearless(m: number, d: number, today: string): string | null {
  const y = Number(today.slice(0, 4))
  if (validYmd(y, m, d)) {
    const cand = ymd(y, m, d)
    if (dayDiff(cand, today) <= PAST_GRACE_DAYS) return cand
  }
  if (validYmd(y + 1, m, d)) return ymd(y + 1, m, d)
  return null
}

/** Token style — remembered so a reschedule keeps the format the user originally wrote. */
export type TokenStyle = 'dataview' | 'tasks' | 'iso' | 'dot' | 'slashY' | 'korY' | 'slash' | 'kor'

export interface DateToken {
  /** Start offset within the text (UTF-16) */
  index: number
  /** Token length */
  length: number
  /** Resolved date 'YYYY-MM-DD' */
  date: string
  style: TokenStyle
}

// Number boundaries: a digit/dot/slash/hyphen on either side means part of a longer number, so ignore it (version 1.2.3, path a/9/30, ...).
const B_BEFORE = '(?<![\\d./\\-])'
const B_AFTER = '(?![\\d/\\-]|\\.\\d)'

const RE_TASKS = /📅️?\s*(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/u
// Obsidian Dataview inline field `[due:: 2026-07-24]` / `(due:: …)` — users' Obsidian documents use this syntax.
// The whole bracketed field is one token (a reschedule rewrites it with only the date inside changed).
// '마감' / '기한' are Korean field names (both mean "due") that existing documents use; kept for compatibility.
const RE_DATAVIEW = /[[(](?:due|deadline|마감|기한)::\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*[\])]/iu
// Other Dataview fields removed from the display text (`[priority:: high]` etc.) — the document itself is untouched.
const RE_DV_FIELD = /[[(][\p{L}\w-]+::[^\])]*[\])]/gu
// '년' / '월' / '일' (year / month / day) below are Korean date syntax that existing documents use — input data, kept.
const RE_FULL = new RegExp(
  `${B_BEFORE}(?:(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{4})\\.\\s?(\\d{1,2})\\.\\s?(\\d{1,2})\\.?|(\\d{4})/(\\d{1,2})/(\\d{1,2})|(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일)${B_AFTER}`,
  'gu',
)
const RE_YEARLESS = new RegExp(
  `${B_BEFORE}(?:(\\d{1,2})/(\\d{1,2})|(\\d{1,2})월\\s*(\\d{1,2})일)${B_AFTER}`,
  'gu',
)

/**
 * Find one date token in the text (priority: 📅 > with year > without year; ties go to the earliest).
 * Candidates that cannot be resolved (nonexistent dates) are skipped.
 */
export function findDateToken(text: string, today: string = todayYmd()): DateToken | null {
  const dv = RE_DATAVIEW.exec(text)
  if (dv) {
    const [y, m, d] = [Number(dv[1]), Number(dv[2]), Number(dv[3])]
    if (validYmd(y, m, d)) {
      return { index: dv.index, length: dv[0].length, date: ymd(y, m, d), style: 'dataview' }
    }
  }
  const t = RE_TASKS.exec(text)
  if (t) {
    const [y, m, d] = [Number(t[1]), Number(t[2]), Number(t[3])]
    if (validYmd(y, m, d)) {
      return { index: t.index, length: t[0].length, date: ymd(y, m, d), style: 'tasks' }
    }
  }
  for (const f of text.matchAll(RE_FULL)) {
    let y: number, m: number, d: number, style: TokenStyle
    if (f[1]) [y, m, d, style] = [Number(f[1]), Number(f[2]), Number(f[3]), 'iso']
    else if (f[4]) [y, m, d, style] = [Number(f[4]), Number(f[5]), Number(f[6]), 'dot']
    else if (f[7]) [y, m, d, style] = [Number(f[7]), Number(f[8]), Number(f[9]), 'slashY']
    else [y, m, d, style] = [Number(f[10]), Number(f[11]), Number(f[12]), 'korY']
    if (validYmd(y, m, d)) {
      return { index: f.index ?? 0, length: f[0].length, date: ymd(y, m, d), style }
    }
  }
  for (const s of text.matchAll(RE_YEARLESS)) {
    const slash = !!s[1]
    const m = Number(slash ? s[1] : s[3])
    const d = Number(slash ? s[2] : s[4])
    const date = resolveYearless(m, d, today)
    if (date) {
      return { index: s.index ?? 0, length: s[0].length, date, style: slash ? 'slash' : 'kor' }
    }
  }
  return null
}

/**
 * Write the new date in the existing token's format. A yearless format is kept only if it would be
 * read back as the same date; otherwise ISO is written (e.g. when the year rolls over).
 * The Korean formats ('korY', 'kor') are only written back where the user already wrote Korean dates.
 */
export function formatDateToken(date: string, style: TokenStyle, today: string = todayYmd()): string {
  const [y, m, d] = date.split('-').map(Number)
  switch (style) {
    case 'dataview':
      return `[due:: ${date}]`
    case 'tasks':
      return `📅 ${date}`
    case 'iso':
      return date
    case 'dot':
      return `${y}.${m}.${d}`
    case 'slashY':
      return `${y}/${m}/${d}`
    case 'korY':
      return `${y}년 ${m}월 ${d}일`
    case 'slash':
      return resolveYearless(m, d, today) === date ? `${m}/${d}` : date
    case 'kor':
      return resolveYearless(m, d, today) === date ? `${m}월 ${d}일` : date
  }
}

/** Display text with the token removed and whitespace collapsed. */
export function stripToken(text: string, tok: DateToken): string {
  return (text.slice(0, tok.index) + ' ' + text.slice(tok.index + tok.length))
    .replace(RE_DV_FIELD, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// blocks → tasks
// ---------------------------------------------------------------------------

interface InlineLike {
  type?: string
  text?: unknown
  content?: unknown
}

function inlineText(inl: InlineLike): string {
  if (!inl || typeof inl !== 'object') return ''
  if (inl.type === 'link' && Array.isArray(inl.content)) {
    return (inl.content as InlineLike[]).map(inlineText).join('')
  }
  return typeof inl.text === 'string' ? inl.text : ''
}

export interface ExtractedTask {
  blockId: string
  text: string
  due: string
  checked: boolean
}

/** Extract only dated checklist items from a block tree (children included). Pure — never mutates input. */
export function extractTasks(blocks: AnyBlock[], today: string = todayYmd()): ExtractedTask[] {
  const out: ExtractedTask[] = []
  const walk = (list: AnyBlock[]): void => {
    for (const b of list) {
      if (out.length >= MAX_TASKS_PER_PAGE) return
      if (b.type === 'checkListItem' && typeof b.id === 'string' && Array.isArray(b.content)) {
        const raw = (b.content as InlineLike[]).map(inlineText).join('')
        const tok = findDateToken(raw, today)
        if (tok) {
          out.push({
            blockId: b.id,
            text: stripToken(raw, tok).slice(0, MAX_TEXT_LEN),
            due: tok.date,
            checked: b.props?.checked === true,
          })
        }
      }
      if (Array.isArray(b.children)) walk(b.children)
    }
  }
  walk(blocks)
  return out
}

// ---------------------------------------------------------------------------
// reindex / backfill
// ---------------------------------------------------------------------------

async function workspaceOf(pageId: string): Promise<string | null> {
  const row = (
    await db
      .select({ workspaceId: pages.workspaceId })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1)
  )[0]
  return row?.workspaceId ?? null
}

/**
 * Resync page_tasks from blocks (delete the page's rows then reinsert, in one transaction).
 * Swallows every error internally (logs only) so callers (store/import) never fail.
 */
export async function reindexPageTasks(pageId: string, blocks: AnyBlock[]): Promise<void> {
  try {
    const workspaceId = await workspaceOf(pageId)
    if (!workspaceId) return
    const tasks = extractTasks(blocks)
    await db.transaction(async (tx) => {
      // Overlapping reindexes of the same page (store hook + immediate reindex) could duplicate rows, so serialize per page.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'page_tasks:' + pageId}))`)
      await tx.delete(pageTasks).where(eq(pageTasks.pageId, pageId))
      if (tasks.length > 0) {
        await tx.insert(pageTasks).values(tasks.map((t) => ({ ...t, pageId, workspaceId })))
      }
      await tx
        .insert(pageTaskIndex)
        .values({ pageId })
        .onConflictDoUpdate({ target: pageTaskIndex.pageId, set: { indexedAt: new Date() } })
    })
    bumpIndexEpoch()
  } catch (err) {
    console.error('[inkling] page_tasks reindex failed', pageId, err)
  }
}

/** Reindex from Yjs state (when blocks are not at hand, e.g. duplicates/template instances). */
export async function reindexPageTasksFromState(pageId: string, state: Uint8Array): Promise<void> {
  try {
    await reindexPageTasks(pageId, stateToBlocks(state))
  } catch (err) {
    console.error('[inkling] page_tasks reindex (from state) failed', pageId, err)
  }
}

/**
 * Boot backfill: scan live doc pages never task-indexed (no page_task_index marker) in small
 * pageId-keyset batches. Yields to the event loop between batches (low priority) and isolates
 * per-page errors. A processed page gets a marker, so the next boot skips it.
 */
export async function backfillPageTasks(log: (msg: string) => void = console.log): Promise<void> {
  const BATCH = 25
  let cursor: string | null = null
  let scanned = 0
  let withTasks = 0
  try {
    for (;;) {
      const rows = await db
        .select({ pageId: pageDocs.pageId, state: pageDocs.state })
        .from(pageDocs)
        .innerJoin(pages, eq(pages.id, pageDocs.pageId))
        .leftJoin(pageTaskIndex, eq(pageTaskIndex.pageId, pageDocs.pageId))
        .where(
          and(
            isNull(pageTaskIndex.pageId),
            eq(pages.kind, 'doc'),
            isNull(pages.deletedAt),
            cursor ? gt(pageDocs.pageId, cursor) : undefined,
          ),
        )
        .orderBy(asc(pageDocs.pageId))
        .limit(BATCH)
      if (rows.length === 0) break

      for (const row of rows) {
        cursor = row.pageId
        try {
          const blocks = stateToBlocks(row.state)
          await reindexPageTasks(row.pageId, blocks)
          if (extractTasks(blocks).length > 0) withTasks++
        } catch (err) {
          console.error('[inkling] page_tasks backfill failed for page', row.pageId, err)
        }
        scanned++
      }

      if (rows.length < BATCH) break
      // Low priority: pause briefly between batches so requests are served first.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (scanned > 0) {
      log(`[inkling] page_tasks backfill done — ${scanned} docs scanned, ${withTasks} with dated tasks`)
    }
  } catch (err) {
    console.error('[inkling] page_tasks backfill failed', err)
  }
}

/**
 * Read several pages from page_docs and reindex them (right after duplicate/template instance). Callers
 * fire it with `void` so the response is not delayed. Non-doc pages (canvas etc.) are skipped. All errors are isolated.
 */
export async function reindexPageTasksForPages(pageIds: string[]): Promise<void> {
  for (const pageId of pageIds) {
    try {
      const row = (
        await db
          .select({ state: pageDocs.state, kind: pages.kind })
          .from(pageDocs)
          .innerJoin(pages, eq(pages.id, pageDocs.pageId))
          .where(eq(pageDocs.pageId, pageId))
          .limit(1)
      )[0]
      if (!row || row.kind !== 'doc') continue
      await reindexPageTasksFromState(pageId, row.state)
    } catch (err) {
      console.error('[inkling] page_tasks bulk reindex failed', pageId, err)
    }
  }
}
