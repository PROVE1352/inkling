import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { RevertChangeDTO, RevertConflictDTO, RevertPageDTO, RevertResultDTO, RevertUnsupported } from '@inkling/shared'
import { pageAccess } from './aclVersion'
import type { AuthUser } from './auth'
import { hocuspocus } from './collab'
import { actorOf, withEditActor } from './context/attribution'
import { drainChangeLog, reserveCursor } from './context/changeLog'
import { blocksToLightMarkdown, splitSections } from './context/chunker'
import type { Section } from './context/chunker'
import { buildMerge, planMerge } from './context/merge3'
import { applySectionBatch } from './context/sectionBatch'
import type { BatchEdit, BatchOutcome } from './context/sectionBatch'
import { resolveMovedSection } from './context/sectionMoves'
import { buildEchoIndex } from './context/sectionPatch'
import { currentBlocks } from './context/sectionSource'
import { db } from './db/index'
import { pageEditGate } from './docWriteGate'
import { assertPageEditable } from './editLock'
import { AppError, notFound } from './errors'
import type { Locale } from './i18n'
import { gatedTransact } from './md/docWrite'
import { markdownToBlocks } from './md/convert'
import type { AnyBlock, ResolveTitle } from './md/convert'
import { buildTitleResolver } from './md/importer'
import { findVisiblePage } from './pageDto'
import { createSnapshot, currentSnapshotSource, snapshotBlocks } from './snapshotStore'
import { assertPerson } from './suggestions'
import { pageInRangeSql } from './tokenRange'
import { recordAudit } from './workspaceAdmin'

/**
 * Reverting logged changes (docs/adr/1620-* .. 1624-*): one change of the page history, or every
 * change one agent made on a page or in a workspace in a period.
 *
 * Basis (ADR 1620): page_changes keeps each changed section's text before and after, as light
 * Markdown (marks, links, colors and embed details flattened), capped and merged per actor within
 * 10 minutes. That is enough to know WHAT changed and to detect later edits, not to rebuild what
 * was removed. So the inverse is a 3-way merge in light-text units (one unit per top-level block):
 * base = the change's after text, theirs = its before text, ours = the section now. Units are then
 * written as BLOCKS: every unit kept from the section now is its live block (untouched by the
 * minimal section edit: ids, colors, marks, concurrent typing), and every unit brought back comes
 * from the richest source that renders to exactly that text — a block still in the page, then a
 * block of a stored version (the "Before AI edit" snapshot an agent's replace/delete leaves),
 * then, for plain paragraphs/list items/quotes/headings only, the text itself (counted as
 * `plainText`). A unit no source can rebuild (an image, a table, an embed) is not guessed: its hunk
 * is reported as a conflict with reason no_source.
 *
 * A hunk that overlaps a later edit (by anyone) is not applied; the result lists it with what is
 * there now. Each page is written in ONE batch (all sections or none, ADR 1542 machinery), as the
 * person, under the write gate, after a "Before revert" version. The writes are ordinary change-log
 * rows of that person (so a revert can itself be reverted); an audit event links the reverted
 * changes and the revert's own rows (ADR 1623). People only — agents get no revert tool (ADR 1624).
 */

export const REVERT_MAX_CHANGES = 300
const SNAPSHOT_SOURCES = 6
const BODY_KINDS = new Set(['modified', 'renamed', 'added'])
const PAGE_KINDS = new Set(['page_added', 'page_renamed', 'page_moved', 'page_trashed', 'page_restored', 'page_visibility'])
const REVERT_LABEL: Record<Locale, string> = { en: 'Before revert', ko: '되돌리기 전' }

interface ChangeRow {
  seq: string
  pageId: string
  anchor: string | null
  headingPath: string
  kind: string
  before: string | null
  after: string | null
  large: boolean
  via: string | null
  actorName: string | null
  changedAt: Date | string
}

export interface RevertFilter {
  workspaceId: string
  pageId?: string
  seqs?: string[]
  via?: string
  actorId?: string
  since?: string
  until?: string
}

// ---------------------------------------------------------------------------
// light-text units
// ---------------------------------------------------------------------------

interface LUnit {
  key: string
  /** The blocks of the unit (live, from a version, or rebuilt from text); null = no source yet. */
  blocks: AnyBlock[] | null
  plain?: boolean
}

const lightKey = (b: AnyBlock) => blocksToLightMarkdown([b])

/** Live blocks as units (an empty block is glued to the one before it). */
function liveUnits(blocks: AnyBlock[]): LUnit[] {
  const out: LUnit[] = []
  const lead: AnyBlock[] = []
  for (const b of blocks) {
    const key = lightKey(b)
    if (!key) {
      if (out.length) out[out.length - 1].blocks!.push(b)
      else lead.push(b)
      continue
    }
    out.push({ key, blocks: [...lead.splice(0), b] })
  }
  if (lead.length) out.push({ key: '', blocks: lead })
  return out
}

/** Known blocks by their light text: segments logged text into the same units the live blocks make. */
class UnitDict {
  private byFirst = new Map<string, { lines: string[]; blocks: AnyBlock[] }[]>()
  private seen = new Set<string>()

  add(blocks: AnyBlock[]): void {
    for (const b of blocks) {
      const key = lightKey(b)
      if (!key || this.seen.has(key)) continue
      this.seen.add(key)
      const lines = key.split('\n')
      const list = this.byFirst.get(lines[0]) ?? []
      list.push({ lines, blocks: [b] })
      list.sort((x, y) => y.lines.length - x.lines.length)
      this.byFirst.set(lines[0], list)
    }
  }

  segment(text: string): LUnit[] {
    const lines = text === '' ? [] : text.split('\n')
    const out: LUnit[] = []
    let i = 0
    while (i < lines.length) {
      const hit = (this.byFirst.get(lines[i]) ?? []).find((c) => c.lines.every((l, k) => lines[i + k] === l))
      if (hit) {
        out.push({ key: hit.lines.join('\n'), blocks: hit.blocks })
        i += hit.lines.length
      } else {
        out.push({ key: lines[i], blocks: null })
        i++
      }
    }
    return out
  }
}

/**
 * Copies of blocks taken from somewhere else (a version, another place in the page) without their
 * ids: the editor gives them new ones, so a block never appears twice under one id.
 */
export function freshBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const strip = (b: AnyBlock): AnyBlock => {
    const { id: _id, ...rest } = b
    return { ...rest, children: (b.children ?? []).map(strip) }
  }
  return structuredClone(blocks).map(strip)
}

const PLAIN_TYPES = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote'])

/** A unit rebuilt from its light text — only when that is lossless in structure (one plain block). */
async function plainBlocks(key: string, resolveTitle: ResolveTitle): Promise<AnyBlock[] | null> {
  if (key.includes('\n') || /^\[(embedded page|embed: |plugin block: |image: |file: |video: |audio: )/.test(key)) return null
  const blocks = await markdownToBlocks(key, resolveTitle)
  if (blocks.length !== 1 || !PLAIN_TYPES.has(blocks[0].type ?? '') || (blocks[0].children?.length ?? 0) > 0) return null
  return lightKey(blocks[0]) === key ? blocks : null
}

// ---------------------------------------------------------------------------
// one page
// ---------------------------------------------------------------------------

interface SimSection {
  sec: Section
  units: LUnit[]
  original: LUnit[]
  deleted: boolean
}

interface PagePlan {
  changes: RevertChangeDTO[]
  edits: BatchEdit[]
}

class PageReverter {
  private dict = new UnitDict()
  private snapshotsLoaded = false
  private snapshotDocs: AnyBlock[][] = []
  private sims = new Map<string, SimSection>()
  private inserts: { afterBlockId: string | null; afterAnchor: string; blocks: AnyBlock[] }[] = []
  private blocks: AnyBlock[] = []
  private sections: Section[] = []

  constructor(
    private pageId: string,
    private resolveTitle: ResolveTitle,
    private newestAt: Date,
  ) {}

  async load(): Promise<void> {
    this.blocks = await currentBlocks(this.pageId)
    this.sections = splitSections(this.blocks)
    this.dict.add(this.blocks)
    this.sims.clear()
    this.inserts = []
  }

  private async loadSnapshots(): Promise<void> {
    if (this.snapshotsLoaded) return
    this.snapshotsLoaded = true
    const ids = (await db.execute(sql`
      SELECT id FROM page_snapshots WHERE page_id = ${this.pageId} AND created_at <= ${this.newestAt.toISOString()}::timestamptz + interval '2 seconds'
       -- versions from before the change first: a burst of AI steps (docs/adr/2180-*) written within the
       -- 2-second slack after it must not push the page as it was out of the window
       ORDER BY (created_at <= ${this.newestAt.toISOString()}::timestamptz) DESC, created_at DESC LIMIT ${SNAPSHOT_SOURCES}
    `)) as unknown as { id: string }[]
    for (const { id } of ids) {
      const bs = await snapshotBlocks(this.pageId, id).catch(() => null)
      if (!bs) continue
      this.snapshotDocs.push(bs)
      this.dict.add(bs)
    }
  }

  private async findSection(anchor: string): Promise<Section | null> {
    const direct = this.sections.find((s) => s.anchor === anchor)
    if (direct) return direct
    const moved = await resolveMovedSection(this.pageId, anchor, this.sections.map((s) => s.anchor)).catch(() => null)
    return moved?.status === 'moved' ? (this.sections.find((s) => s.anchor === moved.anchor) ?? null) : null
  }

  private sim(sec: Section): SimSection {
    let s = this.sims.get(sec.anchor)
    if (!s) {
      const body = this.blocks.slice(sec.level === 0 ? sec.start : sec.start + 1, sec.end)
      const units = liveUnits(body)
      s = { sec, units, original: units, deleted: false }
      this.sims.set(sec.anchor, s)
    }
    return s
  }

  /** The inverse of one logged change on the simulated page (newest changes first). */
  async revert(row: ChangeRow): Promise<RevertChangeDTO> {
    const dto: RevertChangeDTO = {
      seq: row.seq,
      kind: row.kind,
      anchor: row.anchor,
      headingPath: row.headingPath,
      via: row.via,
      actor: row.actorName,
      changedAt: new Date(row.changedAt).toISOString(),
      outcome: 'unsupported',
      applied: 0,
      conflicts: [],
      plainText: 0,
    }
    const unsupported = (reason: RevertUnsupported) => ({ ...dto, outcome: 'unsupported' as const, reason })
    if (PAGE_KINDS.has(row.kind) || row.anchor === null) return unsupported('page_event')
    if (row.kind === 'moved') return unsupported('moved')
    if (row.large) return unsupported('large')
    if (row.kind === 'removed') return this.revertRemoved(row, dto)
    if (!BODY_KINDS.has(row.kind)) return unsupported('page_event')
    if (row.after === null || (row.kind !== 'added' && row.before === null)) return unsupported('large')
    if (row.kind === 'renamed' && row.before === row.after) return unsupported('heading_only')
    const sec = await this.findSection(row.anchor)
    if (!sec) return row.kind === 'added' ? { ...dto, outcome: 'noop' } : unsupported('section_gone')
    const sim = this.sim(sec)
    if (sim.deleted) return { ...dto, outcome: 'noop' }

    let base = this.dict.segment(row.after)
    let theirs = this.dict.segment(row.before ?? '')
    if (theirs.some((u) => !u.blocks)) {
      await this.loadSnapshots()
      base = this.dict.segment(row.after)
      theirs = this.dict.segment(row.before ?? '')
    }
    const ours = sim.units
    const plan = planMerge(
      base.map((u) => u.key),
      ours.map((u) => u.key),
      theirs.map((u) => u.key),
    )
    if (!plan) return unsupported('too_complex')
    const chosen = new Set<number>()
    const conflicts: RevertConflictDTO[] = []
    let effective = 0
    let plain = 0
    const join = (us: LUnit[], s: number, e: number) => us.slice(s, e).map((u) => u.key).join('\n')
    for (const h of plan.hunks) {
      if (h.same) continue
      effective++
      const wanted = join(theirs, h.theirs.start, h.theirs.end)
      if (h.conflict) {
        conflicts.push({ wanted, now: h.ours ? join(ours, h.ours.start, h.ours.end) : '', reason: 'overlap' })
        continue
      }
      let ok = true
      let p = 0
      for (let k = h.theirs.start; k < h.theirs.end; k++) {
        const u = theirs[k]
        if (u.blocks) continue
        const rebuilt = await plainBlocks(u.key, this.resolveTitle)
        if (!rebuilt) {
          ok = false
          break
        }
        theirs[k] = { key: u.key, blocks: rebuilt, plain: true }
        p++
      }
      if (!ok) {
        conflicts.push({ wanted, now: join(base, h.base.start, h.base.end), reason: 'no_source' })
        continue
      }
      plain += p
      chosen.add(h.id)
    }
    if (effective === 0) return { ...dto, outcome: 'noop' }
    if (chosen.size) {
      const next: LUnit[] = []
      for (const piece of buildMerge(plan, chosen)) {
        if (piece.from === 'ours') next.push(ours[piece.index])
        else {
          const u = piece.from === 'theirs' ? theirs[piece.index] : base[piece.index]
          next.push(u.plain || !u.blocks ? u : { ...u, blocks: freshBlocks(u.blocks) })
        }
      }
      sim.units = next
      if (row.kind === 'added' && next.length === 0 && conflicts.length === 0) sim.deleted = true
    }
    return {
      ...dto,
      outcome: chosen.size === effective ? 'applied' : chosen.size ? 'partial' : 'conflict',
      applied: chosen.size,
      conflicts,
      plainText: plain,
    }
  }

  /** An agent removed a whole section: put it back from the version that had it, after its old neighbour. */
  private async revertRemoved(row: ChangeRow, dto: RevertChangeDTO): Promise<RevertChangeDTO> {
    if (row.before === null) return { ...dto, outcome: 'unsupported', reason: 'large' }
    if (this.sections.some((s) => s.anchor === row.anchor)) return { ...dto, outcome: 'unsupported', reason: 'section_exists' }
    await this.loadSnapshots()
    for (const bs of this.snapshotDocs) {
      const secs = splitSections(bs)
      const i = secs.findIndex((s) => s.anchor === row.anchor && s.text === row.before)
      if (i < 0) continue
      const s = secs[i]
      const prev = i > 0 ? secs[i - 1] : null
      const target = (prev && this.sections.find((x) => (prev.blockId && x.blockId === prev.blockId) || x.anchor === prev.anchor)) ?? this.sections[this.sections.length - 1]
      if (!target) break
      this.inserts.push({ afterBlockId: target.blockId, afterAnchor: target.anchor, blocks: freshBlocks(bs.slice(s.start, s.end)) })
      return { ...dto, outcome: 'applied', applied: 1 }
    }
    return { ...dto, outcome: 'unsupported', reason: 'no_source' }
  }

  /** The batch for the page: one edit per touched section, inserts last. */
  async edits(): Promise<BatchEdit[]> {
    const out: BatchEdit[] = []
    for (const s of this.sims.values()) {
      if (s.deleted) {
        out.push({ blockId: s.sec.blockId, anchor: s.sec.anchor, incoming: [], mode: 'delete', baseVersion: s.sec.version, echo: null })
        continue
      }
      if (s.units.length === s.original.length && s.units.every((u, i) => u === s.original[i])) continue
      const body = this.blocks.slice(s.sec.level === 0 ? s.sec.start : s.sec.start + 1, s.sec.end)
      const incoming = s.units.flatMap((u) => u.blocks ?? [])
      const next = incoming.length ? incoming : [{ type: 'paragraph', content: [] } as AnyBlock]
      const echo = await buildEchoIndex(body, this.resolveTitle, {}, next)
      out.push({ blockId: s.sec.blockId, anchor: s.sec.anchor, incoming: next, mode: 'replace', baseVersion: s.sec.version, echo })
    }
    for (const ins of this.inserts) {
      out.push({ blockId: ins.afterBlockId, anchor: ins.afterAnchor, incoming: ins.blocks, mode: 'insert_after', echo: null })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// selecting changes
// ---------------------------------------------------------------------------

async function selectRows(user: AuthUser, f: RevertFilter): Promise<ChangeRow[]> {
  const conds: SQL[] = [sql`c.workspace_id = ${f.workspaceId}`, sql`(c.scope = 'shared' OR c.owner_id = ${user.id})`]
  if (f.pageId) conds.push(sql`c.page_id = ${f.pageId}`)
  if (f.seqs?.length) conds.push(sql`c.seq IN (SELECT jsonb_array_elements_text(${JSON.stringify(f.seqs)}::jsonb)::bigint)`)
  if (f.via) conds.push(sql`c.via_client = ${f.via}`)
  if (f.actorId) conds.push(sql`c.actor_id = ${f.actorId}`)
  if (f.since) conds.push(sql`c.changed_at >= ${f.since}::timestamptz`)
  if (f.until) conds.push(sql`c.changed_at < ${f.until}::timestamptz`)
  return (await db.execute(sql`
    SELECT c.seq::text AS seq, c.page_id AS "pageId", c.anchor, c.heading_path AS "headingPath", c.kind,
           c.before_text AS before, c.after_text AS after, c.large, c.via_client AS via, u.name AS "actorName",
           c.changed_at AS "changedAt"
      FROM page_changes c
      JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL AND p.kind = 'doc'
       AND (p.scope = 'shared' OR p.created_by = ${user.id})
       AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, user.id)}
      LEFT JOIN users u ON u.id = c.actor_id
     WHERE ${sql.join(conds, sql` AND `)}
     ORDER BY c.seq DESC
     LIMIT ${REVERT_MAX_CHANGES + 1}
  `)) as unknown as ChangeRow[]
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

async function planPage(pageId: string, rows: ChangeRow[], resolveTitle: ResolveTitle): Promise<PagePlan> {
  const newest = new Date(Math.max(...rows.map((r) => new Date(r.changedAt).getTime())))
  const r = new PageReverter(pageId, resolveTitle, newest)
  await r.load()
  const changes: RevertChangeDTO[] = []
  for (const row of rows) changes.push(await r.revert(row))
  return { changes, edits: await r.edits() }
}

export async function revertChanges(
  user: AuthUser,
  filter: RevertFilter,
  opts: { dryRun: boolean; locale: () => Promise<Locale> },
): Promise<RevertResultDTO> {
  assertPerson()
  // Every committed change is in the log. A real run also seals it (the high-water mark,
  // docs/adr/1080-*), so no later edit merges into the rows it reverts; a preview only drains, so
  // opening the dialog does not stop the 10-minute merge for everyone.
  const start = opts.dryRun ? null : await reserveCursor()
  if (!start) await drainChangeLog()
  const all = await selectRows(user, filter)
  const truncated = all.length > REVERT_MAX_CHANGES
  const rows = all.slice(0, REVERT_MAX_CHANGES)
  if (filter.seqs?.length && rows.length === 0) throw notFound()
  const byPage = new Map<string, ChangeRow[]>()
  for (const row of rows) {
    const list = byPage.get(row.pageId)
    if (list) list.push(row)
    else byPage.set(row.pageId, [row])
  }
  const resolveTitle = await buildTitleResolver(filter.workspaceId, new Map(), user.id)
  const pages: RevertPageDTO[] = []
  const written: { page: RevertPageDTO; seqs: string[] }[] = []
  for (const [pageId, list] of byPage) {
    const page = await findVisiblePage(pageId, user.id)
    const out: RevertPageDTO = { pageId, title: page?.title ?? '', changes: [], written: false }
    pages.push(out)
    try {
      if (!page) throw notFound()
      const access = await pageAccess(db, pageId, user.id)
      if (!access) throw notFound()
      await assertPageEditable(pageId, user.id, { role: access.role, acl: access.acl })
      let plan = await planPage(pageId, list, resolveTitle)
      out.changes = plan.changes
      if (opts.dryRun || plan.edits.length === 0) continue
      const label = REVERT_LABEL[await opts.locale()] ?? REVERT_LABEL.en
      const src = await currentSnapshotSource(pageId)
      if (src) await createSnapshot(pageId, src, label, user.id, null)
      // Typing between the plan and the write moves a section's version: plan again once.
      for (let attempt = 0; ; attempt++) {
        let outcome: BatchOutcome | null = null
        const edits = plan.edits
        await withEditActor([pageId], actorOf(user), async () => {
          const conn = await hocuspocus.openDirectConnection(pageId)
          try {
            const gate = pageEditGate(pageId, page.workspaceId, user.id, access)
            await gatedTransact(conn, (doc) => {
              outcome = applySectionBatch(doc, edits)
            }, gate)
          } finally {
            await conn.disconnect()
          }
        })
        const res = outcome as BatchOutcome | null
        if (res?.status === 'ok') break
        if (attempt >= 1 || res?.failures.some((f) => f.reason !== 'version')) {
          throw new AppError(409, 'REVERT_CHANGED', 'The page changed while the revert was being written; nothing was changed. Try again.')
        }
        plan = await planPage(pageId, list, resolveTitle)
        out.changes = plan.changes
        if (!plan.edits.length) break
      }
      out.written = plan.edits.length > 0
      if (out.written) written.push({ page: out, seqs: list.map((r) => r.seq) })
    } catch (err) {
      const e = err instanceof AppError ? err : null
      if (!e) console.error('[inkling] revert failed', pageId, err)
      out.error = { code: e?.code ?? 'INTERNAL', message: e?.message ?? 'The revert failed' }
      out.changes = out.changes.length ? out.changes : list.map((r) => unsupportedRow(r))
    }
  }

  if (written.length) {
    // The revert's own rows (this person, no client, after the start mark): sealed so later typing
    // does not merge into them, and named in the audit event so the history can mark them.
    await reserveCursor()
    for (const w of written) {
      const own = (await db.execute(sql`
        SELECT seq::text AS seq FROM page_changes
         WHERE page_id = ${w.page.pageId} AND seq > ${start!.seq} AND actor_id = ${user.id} AND via_client IS NULL
         ORDER BY page_changes.seq
      `)) as unknown as { seq: string }[]
      const applied = w.page.changes.filter((c) => c.outcome === 'applied' || c.outcome === 'partial')
      await recordAudit(db, {
        workspaceId: filter.workspaceId,
        actor: { id: user.id, name: user.name },
        action: 'page.changes_reverted',
        target: { type: 'page', id: w.page.pageId, label: w.page.title },
        before: { seqs: applied.map((c) => c.seq), via: [...new Set(applied.map((c) => c.via).filter((v): v is string => !!v))] },
        after: { seqs: own.map((r) => r.seq), conflicts: w.page.changes.reduce((n, c) => n + c.conflicts.length, 0) },
      })
    }
  }

  const changes = pages.flatMap((p) => p.changes)
  const count = (o: string) => changes.filter((c) => c.outcome === o).length
  return {
    dryRun: opts.dryRun,
    pages,
    totals: {
      pages: pages.length,
      changes: changes.length,
      applied: count('applied'),
      partial: count('partial'),
      conflicts: count('conflict'),
      unsupported: count('unsupported'),
      noop: count('noop'),
    },
    truncated,
  }
}

function unsupportedRow(r: ChangeRow): RevertChangeDTO {
  return {
    seq: r.seq,
    kind: r.kind,
    anchor: r.anchor,
    headingPath: r.headingPath,
    via: r.via,
    actor: r.actorName,
    changedAt: new Date(r.changedAt).toISOString(),
    outcome: 'conflict',
    applied: 0,
    conflicts: [],
    plainText: 0,
  }
}

// ---------------------------------------------------------------------------
// history marks
// ---------------------------------------------------------------------------

const REVERTABLE_KINDS = new Set(['modified', 'renamed', 'added', 'removed'])

/** Revert facts of logged changes (history and activity lists): from the revert audit events of their pages. */
export async function revertInfo(
  workspaceId: string,
  items: { seq: string; pageId: string; kind: string; large: boolean; hasText: boolean }[],
): Promise<Map<string, { revertable: boolean; revertedBy: { name: string; at: string } | null; isRevert: boolean }>> {
  const out = new Map<string, { revertable: boolean; revertedBy: { name: string; at: string } | null; isRevert: boolean }>()
  if (!items.length) return out
  const pageIds = [...new Set(items.map((i) => i.pageId))]
  const events = (await db.execute(sql`
    SELECT actor_name AS "actorName", created_at AS "createdAt", before, after
      FROM workspace_audit_events
     WHERE workspace_id = ${workspaceId} AND action = 'page.changes_reverted'
       AND target_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(pageIds)}::jsonb))
     ORDER BY id
  `)) as unknown as { actorName: string; createdAt: Date | string; before: { seqs?: string[] } | null; after: { seqs?: string[] } | null }[]
  const reverted = new Map<string, { name: string; at: string }>()
  const own = new Set<string>()
  for (const e of events) {
    for (const s of e.before?.seqs ?? []) reverted.set(String(s), { name: e.actorName, at: new Date(e.createdAt).toISOString() })
    for (const s of e.after?.seqs ?? []) own.add(String(s))
  }
  for (const i of items) {
    out.set(i.seq, {
      revertable: REVERTABLE_KINDS.has(i.kind) && i.hasText && !i.large,
      revertedBy: reverted.get(i.seq) ?? null,
      isRevert: own.has(i.seq),
    })
  }
  return out
}
