import { myers } from './diff'

/**
 * Three-way merge over units (docs/adr/1621-*). Pure. Units are opaque strings compared for
 * equality — the callers use one top-level block per unit (its Markdown, or its light text for the
 * change feed), so a hunk never cuts through a code fence, a table or a notation token (ADR 1500).
 *
 *   base   the text both sides started from
 *   ours   what the document holds now (people's edits since)
 *   theirs the change to bring in (an agent's suggestion; the inverse of a logged change)
 *
 * `planMerge` lists the hunks of base→theirs and marks each one that overlaps an edit of
 * base→ours as a conflict. `buildMerge` returns the merged sequence for a chosen set of hunks:
 * every edit of ours is kept, chosen clean hunks are added, and a chosen conflicting hunk takes its
 * side over the overlapping edit of ours (the person decided that explicitly).
 *
 * Overlap, in base positions [start, end): two ranges overlap when they share a unit; an insertion
 * (start = end) overlaps a range only strictly inside it, and another insertion at the same point.
 * An insertion at the edge of the other side's range is placed before or after it, unambiguously.
 */

export interface Region {
  /** [aStart, aEnd) in base, replaced by [bStart, bEnd) of the other sequence. */
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

export interface MergeHunk {
  id: number
  /** Base units [start, end) the hunk replaces. */
  base: { start: number; end: number }
  /** Theirs units [start, end) it brings in. */
  theirs: { start: number; end: number }
  /** Overlaps an edit people made since the base. */
  conflict: boolean
  /** The overlapping edit already made exactly this change (nothing left to apply). */
  same: boolean
  /** Ours units [start, end) of the overlapping edits (conflicts only): what the person has there now. */
  ours: { start: number; end: number } | null
}

export interface MergePlan {
  baseLen: number
  hunks: MergeHunk[]
  oursRegions: Region[]
  /** base index → ours index for units ours left unchanged, else -1. */
  baseToOurs: Int32Array
}

export type MergePiece = { from: 'ours' | 'theirs' | 'base'; index: number }

export const MERGE_LIMITS = { maxD: 400, maxWork: 4_000_000 }

/** Edit regions of a → b (runs of non-equal ops), or null over the caps. */
export function editRegions(a: string[], b: string[], limits = MERGE_LIMITS): Region[] | null {
  const ops = myers(a, b, limits.maxD, { left: limits.maxWork })
  if (!ops) return null
  const out: Region[] = []
  let i = 0
  let j = 0
  let cur: Region | null = null
  for (const op of ops) {
    if (op.t === '=') {
      if (cur) out.push(cur)
      cur = null
      i++
      j++
      continue
    }
    if (!cur) cur = { aStart: i, aEnd: i, bStart: j, bEnd: j }
    if (op.t === '-') cur.aEnd = ++i
    else cur.bEnd = ++j
  }
  if (cur) out.push(cur)
  return out
}

function overlaps(x: { aStart: number; aEnd: number }, y: { aStart: number; aEnd: number }): boolean {
  const xIns = x.aStart === x.aEnd
  const yIns = y.aStart === y.aEnd
  if (xIns && yIns) return x.aStart === y.aStart
  if (xIns) return y.aStart < x.aStart && x.aStart < y.aEnd
  if (yIns) return x.aStart < y.aStart && y.aStart < x.aEnd
  return x.aStart < y.aEnd && y.aStart < x.aEnd
}

function sameSeq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * A run that replaces k units by k units is k one-to-one edits (block i became block i'): split,
 * so each can be chosen on its own and only the edited block can overlap a person's edit.
 */
function splitPairs(regions: Region[]): Region[] {
  const out: Region[] = []
  for (const r of regions) {
    const k = r.aEnd - r.aStart
    if (k > 1 && k === r.bEnd - r.bStart) {
      for (let i = 0; i < k; i++) out.push({ aStart: r.aStart + i, aEnd: r.aStart + i + 1, bStart: r.bStart + i, bEnd: r.bStart + i + 1 })
    } else out.push(r)
  }
  return out
}

export function planMerge(base: string[], ours: string[], theirs: string[], limits: Partial<typeof MERGE_LIMITS> = {}): MergePlan | null {
  const lim = { ...MERGE_LIMITS, ...limits }
  const oursRaw = editRegions(base, ours, lim)
  const theirsRaw = editRegions(base, theirs, lim)
  if (!oursRaw || !theirsRaw) return null
  const oursRegions = splitPairs(oursRaw)
  const theirRegions = splitPairs(theirsRaw)
  const baseToOurs = new Int32Array(base.length).fill(-1)
  {
    let i = 0
    let j = 0
    for (const r of oursRegions) {
      while (i < r.aStart) baseToOurs[i++] = j++
      i = r.aEnd
      j = r.bEnd
    }
    while (i < base.length) baseToOurs[i++] = j++
  }
  const hunks: MergeHunk[] = theirRegions.map((t, id) => {
    const hit = oursRegions.filter((o) => overlaps(o, t))
    const same =
      hit.length === 1 &&
      hit[0].aStart === t.aStart &&
      hit[0].aEnd === t.aEnd &&
      sameSeq(ours.slice(hit[0].bStart, hit[0].bEnd), theirs.slice(t.bStart, t.bEnd))
    return {
      id,
      base: { start: t.aStart, end: t.aEnd },
      theirs: { start: t.bStart, end: t.bEnd },
      conflict: hit.length > 0 && !same,
      same,
      ours: hit.length ? { start: Math.min(...hit.map((o) => o.bStart)), end: Math.max(...hit.map((o) => o.bEnd)) } : null,
    }
  })
  return { baseLen: base.length, hunks, oursRegions, baseToOurs }
}

interface Edit {
  aStart: number
  aEnd: number
  side: 'ours' | 'theirs'
  region: Region
}

/** The merged sequence with the hunks in `chosen` applied (by id) on top of ours. */
export function buildMerge(plan: MergePlan, chosen: ReadonlySet<number>): MergePiece[] {
  const edits: Edit[] = [
    ...plan.oursRegions.map((r): Edit => ({ aStart: r.aStart, aEnd: r.aEnd, side: 'ours', region: r })),
    ...plan.hunks
      .filter((h) => chosen.has(h.id) && !h.same)
      .map((h): Edit => ({
        aStart: h.base.start,
        aEnd: h.base.end,
        side: 'theirs',
        region: { aStart: h.base.start, aEnd: h.base.end, bStart: h.theirs.start, bEnd: h.theirs.end },
      })),
  ]
  // Clusters of transitively overlapping edits (sections are small: pairwise is fine).
  const parent = edits.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) if (overlaps(edits[i], edits[j])) parent[find(i)] = find(j)
  }
  const groups = new Map<number, Edit[]>()
  edits.forEach((e, i) => {
    const k = find(i)
    const g = groups.get(k)
    if (g) g.push(e)
    else groups.set(k, [e])
  })
  const clusters = [...groups.values()]
    .map((es) => ({ es, start: Math.min(...es.map((e) => e.aStart)), end: Math.max(...es.map((e) => e.aEnd)) }))
    .sort((x, y) => x.start - y.start || x.end - y.end)

  const out: MergePiece[] = []
  const baseUnit = (k: number) => {
    const o = plan.baseToOurs[k]
    out.push(o >= 0 ? { from: 'ours', index: o } : { from: 'base', index: k })
  }
  const emit = (from: 'ours' | 'theirs', s: number, e: number) => {
    for (let k = s; k < e; k++) out.push({ from, index: k })
  }
  let pos = 0
  for (const c of clusters) {
    for (let k = pos; k < c.start; k++) baseUnit(k)
    const ours = c.es.filter((e) => e.side === 'ours').sort((x, y) => x.aStart - y.aStart)
    const theirs = c.es.filter((e) => e.side === 'theirs').sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd)
    if (!theirs.length) {
      for (const e of ours) emit('ours', e.region.bStart, e.region.bEnd)
    } else if (!ours.length) {
      for (const e of theirs) emit('theirs', e.region.bStart, e.region.bEnd)
    } else if (c.es.every((e) => e.aStart === e.aEnd)) {
      // Insertions at one point on both sides: keep both, the person's first.
      for (const e of ours) emit('ours', e.region.bStart, e.region.bEnd)
      for (const e of theirs) emit('theirs', e.region.bStart, e.region.bEnd)
    } else {
      // A chosen conflicting hunk: the agent's side over the span, base units elsewhere in it.
      let k = c.start
      for (const e of theirs) {
        for (; k < e.aStart; k++) baseUnit(k)
        emit('theirs', e.region.bStart, e.region.bEnd)
        k = Math.max(k, e.aEnd)
      }
      for (; k < c.end; k++) baseUnit(k)
    }
    pos = Math.max(pos, c.end)
  }
  for (let k = pos; k < plan.baseLen; k++) baseUnit(k)
  return out
}
