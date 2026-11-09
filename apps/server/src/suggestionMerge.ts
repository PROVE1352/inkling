import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SuggestionMergeDTO } from '@inkling/shared'
import { planMerge, buildMerge } from './context/merge3'
import type { MergePlan } from './context/merge3'
import { pageMentionKeys, readSectionBlocks } from './context/sectionSource'
import type { OutlineSection } from './context/sectionSource'
import { db } from './db/index'
import type { Exec } from './outbox'
import { blocksToMarkdown, markdownToBlocks, stripFrontmatter } from './md/convert'
import type { AnyBlock, ResolveTitle } from './md/convert'
import type { ParseNotationOptions } from './md/notation'
import { buildTitleResolver } from './md/importer'

/**
 * Per-hunk acceptance of a `replace` suggestion (docs/adr/1621-*, 1622-*).
 *
 * The base — the section as the agent read it — is captured when the suggestion is made (only when
 * the agent's baseVersion is the section's version then, so it really is what the agent saw) and
 * kept in plugin_storage under the reserved id `inkling:suggestion_base`, keyed by the author and
 * the suggestion id: no schema change this wave (the same route ADR 1522 took). After the decision
 * the entry is replaced by the decision record ({applied, total}) for `accepted_partial`, or removed.
 *
 * Units are top-level blocks (an empty block is glued to the one before it), compared by their
 * Markdown in the agent notation (ADR 1500): a hunk never cuts a code fence, a table or a token.
 * base = the stored section, ours = the section now (live blocks), theirs = base with the
 * suggestion applied. The merged section is written as blocks — the live ones for every unit the
 * person kept — through the same minimal section edit as an accept (echo index: untouched blocks
 * stay untouched, colors and marks included).
 */

export const SUGGESTION_BASE_STORE = 'inkling:suggestion_base'
/** Bases larger than this are not kept (the suggestion is then accepted whole, as before). */
export const MAX_BASE_BYTES = 512 * 1024

interface StoredBase {
  v: string
  md: string
}

export interface PartialRecord {
  applied: number
  total: number
}

export async function storeSuggestionBase(exec: Exec, authorId: string, id: string, version: string, markdown: string): Promise<void> {
  const value = JSON.stringify({ v: version, md: markdown } satisfies StoredBase)
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_BASE_BYTES) return
  await exec.execute(sql`
    INSERT INTO plugin_storage (plugin_id, user_id, key, value, bytes, updated_at)
    VALUES (${SUGGESTION_BASE_STORE}, ${authorId}, ${id}, ${value}, ${bytes}, now())
    ON CONFLICT (plugin_id, user_id, key) DO UPDATE SET value = EXCLUDED.value, bytes = EXCLUDED.bytes, updated_at = now()
  `)
}

async function loadBase(authorId: string, id: string): Promise<StoredBase | null> {
  const [r] = (await db.execute(sql`
    SELECT value FROM plugin_storage WHERE plugin_id = ${SUGGESTION_BASE_STORE} AND user_id = ${authorId} AND key = ${id}
  `)) as unknown as { value: string }[]
  if (!r) return null
  try {
    const v = JSON.parse(r.value) as Partial<StoredBase>
    return typeof v.v === 'string' && typeof v.md === 'string' ? { v: v.v, md: v.md } : null
  } catch {
    return null
  }
}

/** Drops the stored base of decided suggestions (accepted whole, rejected, withdrawn, superseded). */
export async function dropSuggestionBases(exec: Exec, ids: string[]): Promise<void> {
  if (!ids.length) return
  await exec.execute(sql`
    DELETE FROM plugin_storage
     WHERE plugin_id = ${SUGGESTION_BASE_STORE}
       AND key IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
  `)
}

/** Replaces the base by the decision record of an `accepted_partial` suggestion. */
export async function recordPartial(exec: Exec, authorId: string, id: string, rec: PartialRecord): Promise<void> {
  const value = JSON.stringify(rec)
  await exec.execute(sql`
    INSERT INTO plugin_storage (plugin_id, user_id, key, value, bytes, updated_at)
    VALUES (${SUGGESTION_BASE_STORE}, ${authorId}, ${id}, ${value}, ${Buffer.byteLength(value, 'utf8')}, now())
    ON CONFLICT (plugin_id, user_id, key) DO UPDATE SET value = EXCLUDED.value, bytes = EXCLUDED.bytes, updated_at = now()
  `)
}

/**
 * Housekeeping: entries whose suggestion is gone (page deleted) or decided without a record to
 * keep (accepted by a rule, superseded inside another path). Bounded per run.
 */
export async function purgeStaleSuggestionBases(): Promise<number> {
  const rows = (await db.execute(sql`
    DELETE FROM plugin_storage ps
     WHERE ps.plugin_id = ${SUGGESTION_BASE_STORE}
       AND ps.key IN (
         SELECT p.key FROM plugin_storage p
          WHERE p.plugin_id = ${SUGGESTION_BASE_STORE}
            AND NOT EXISTS (SELECT 1 FROM section_suggestions s WHERE s.id::text = p.key AND s.status IN ('open', 'accepted_partial'))
          LIMIT 5000)
    RETURNING 1 AS x
  `)) as unknown as unknown[]
  return rows.length
}

export function parsePartial(value: string | null): PartialRecord | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<PartialRecord>
    return typeof v.applied === 'number' && typeof v.total === 'number' ? { applied: v.applied, total: v.total } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

export interface Unit {
  key: string
  /** The block and the empty blocks glued after it. */
  blocks: AnyBlock[]
}

async function render(blocks: AnyBlock[]): Promise<string> {
  const { markdown } = await blocksToMarkdown(blocks, { assetMode: 'absolute', notation: 'agent' })
  return markdown.trim()
}

/**
 * Top-level blocks as units keyed by their agent Markdown. `normalize` runs the key once more
 * through parse → render, so the live blocks (ours) compare equal to blocks that were themselves
 * parsed from that Markdown (base, theirs).
 */
export async function blockUnits(blocks: AnyBlock[], normalize: null | { resolveTitle: ResolveTitle; notation: ParseNotationOptions }): Promise<Unit[]> {
  const out: Unit[] = []
  const pendingEmpty: AnyBlock[] = []
  for (const b of blocks) {
    let key = await render([b])
    if (key && normalize) {
      const again = await markdownToBlocks(key, normalize.resolveTitle, undefined, normalize.notation)
      key = await render(again)
    }
    if (!key) {
      if (out.length) out[out.length - 1].blocks.push(b)
      else pendingEmpty.push(b)
      continue
    }
    out.push({ key, blocks: [...pendingEmpty.splice(0), b] })
  }
  if (pendingEmpty.length) out.push({ key: '', blocks: pendingEmpty })
  return out
}

// ---------------------------------------------------------------------------
// the merge of one suggestion
// ---------------------------------------------------------------------------

export interface SuggestionLike {
  id: string
  workspaceId: string
  pageId: string
  anchor: string
  blockId: string | null
  baseVersion: string | null
  markdown: string
  mode: string
  authorId: string
}

export interface SuggestionMerge {
  dto: SuggestionMergeDTO
  plan: MergePlan
  section: OutlineSection
  base: Unit[]
  ours: Unit[]
  theirs: Unit[]
}

/**
 * The 3-way plan of a `replace` suggestion on its section now; null when it does not apply (other
 * modes, the whole page, the section is gone) or the section is over the diff caps.
 */
export async function suggestionMerge(r: SuggestionLike, viewerId: string, ref: string): Promise<SuggestionMerge | null> {
  if (r.mode !== 'replace' || r.anchor === '') return null
  const cur = await readSectionBlocks(r.pageId, ref)
  if (!cur.found) return null
  const resolveTitle = await buildTitleResolver(r.workspaceId, new Map(), viewerId)
  const stored = await loadBase(r.authorId, r.id)
  // Without a stored base the section is its own base only while it is unchanged.
  const unchanged = r.baseVersion === cur.section.version
  const baseKnown = !!stored || unchanged
  const curMd = await render(cur.blocks)
  const notation: ParseNotationOptions = { mentions: await pageMentionKeys(r.pageId, `${stored?.md ?? ''}\n${r.markdown}\n${curMd}`) }
  const parse = (md: string) => markdownToBlocks(stripFrontmatter(md), resolveTitle, undefined, notation)
  const ours = await blockUnits(cur.blocks, { resolveTitle, notation })
  const base = stored && !unchanged ? await blockUnits(await parse(stored.md), null) : ours
  const incoming = await parse(r.markdown)
  const level = cur.section.level
  const headingUnit = level > 0 ? base[0] : undefined
  const theirBlocks = level > 0 && incoming[0]?.type !== 'heading' && headingUnit ? [...headingUnit.blocks, ...incoming] : incoming
  const theirs = await blockUnits(theirBlocks, null)
  const plan = planMerge(
    base.map((u) => u.key),
    ours.map((u) => u.key),
    theirs.map((u) => u.key),
  )
  if (!plan) return null
  const join = (us: Unit[], s: number, e: number) => us.slice(s, e).map((u) => u.key).join('\n\n')
  const key = createHash('sha1')
    .update(JSON.stringify([base.map((u) => u.key), ours.map((u) => u.key), theirs.map((u) => u.key)]))
    .digest('hex')
    .slice(0, 16)
  const dto: SuggestionMergeDTO = {
    baseKnown,
    key,
    hunks: plan.hunks.map((h) => ({
      id: h.id,
      // Without the base every hunk may undo a person's edit: none is applied unasked.
      conflict: h.conflict || (!baseKnown && !h.same),
      same: h.same,
      before: join(base, h.base.start, h.base.end),
      after: join(theirs, h.theirs.start, h.theirs.end),
      ours: h.ours ? join(ours, h.ours.start, h.ours.end) : null,
      context: h.base.start > 0 ? firstLine(base[h.base.start - 1].key) : null,
    })),
  }
  return { dto, plan, section: cur.section, base, ours, theirs }
}

function firstLine(s: string): string {
  const l = s.split('\n')[0]
  return l.length > 80 ? `${l.slice(0, 80)}…` : l
}

/**
 * The merged section as blocks for the chosen hunks: live blocks for every unit taken from the
 * section now, the suggestion's blocks for applied hunks, the base's (or an equal live block) for
 * units a chosen conflicting hunk brought back.
 */
export function mergedBlocks(m: SuggestionMerge, chosen: ReadonlySet<number>): AnyBlock[] {
  const byKey = new Map<string, Unit>()
  for (const u of m.ours) if (!byKey.has(u.key)) byKey.set(u.key, u)
  const out: AnyBlock[] = []
  const used = new Set<string>()
  const push = (bs: AnyBlock[]) => {
    for (const b of bs) {
      // A block already placed (a live block brought back twice) goes in again as a copy.
      if (typeof b.id === 'string' && used.has(b.id)) out.push(...freshBlocks([b]))
      else {
        if (typeof b.id === 'string') used.add(b.id)
        out.push(b)
      }
    }
  }
  for (const p of buildMerge(m.plan, chosen)) {
    if (p.from === 'ours') push(m.ours[p.index].blocks)
    else if (p.from === 'theirs') push(m.theirs[p.index].blocks)
    else push((byKey.get(m.base[p.index].key) ?? m.base[p.index]).blocks)
  }
  return out
}

function freshBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const strip = (b: AnyBlock): AnyBlock => {
    const { id: _id, ...rest } = b
    return { ...rest, children: (b.children ?? []).map(strip) }
  }
  return structuredClone(blocks).map(strip)
}
