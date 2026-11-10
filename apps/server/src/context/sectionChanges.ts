/**
 * Section-level change detection for the change feed (docs/adr/0932-*). Pure.
 *
 * Input: a page's sections before and after a reindex (anchor, heading path, body, version,
 * position). Output: one change per affected section:
 *   - modified: same anchor, different version (body or heading text changed)
 *   - renamed:  a removed and an added section that are the same section under a new anchor —
 *               same heading block id, or (no id match) an identical body. A renamed section whose
 *               body also changed carries both texts, so the reader can still show the diff.
 *   - added / removed: the rest
 *   - moved:    sections present on both sides whose relative order changed. The kept order is the
 *               longest increasing subsequence of old positions taken in new order (O(n log n));
 *               every matched section outside it moved. Inserting or deleting sections never
 *               makes the others "moved".
 * Everything is linear apart from the LIS, so a page with thousands of sections stays cheap.
 */

export interface SectionLike {
  anchor: string
  headingPath: string
  blockId: string | null
  text: string
  version: string
  order: number
}

export type SectionChangeKind = 'added' | 'modified' | 'removed' | 'renamed' | 'moved'

export interface SectionChange {
  kind: SectionChangeKind
  anchor: string
  prevAnchor: string | null
  headingPath: string
  /** Body before (null for added). For moved: the old position as a decimal string. */
  before: string | null
  /** Body after (null for removed). For moved: the new position as a decimal string. */
  after: string | null
}

/**
 * Indices (into `seq`) of one longest strictly increasing subsequence. Patience sorting with
 * binary search and predecessor links: O(n log n) time, O(n) memory.
 */
export function longestIncreasingSubsequence(seq: number[]): number[] {
  const tailIdx: number[] = [] // tailIdx[l] = index of the smallest tail of an increasing run of length l+1
  const prev = new Int32Array(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    const x = seq[i]
    let lo = 0
    let hi = tailIdx.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tailIdx[mid]] < x) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tailIdx[lo - 1]
    tailIdx[lo] = i
  }
  const out: number[] = []
  let k = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1
  while (k >= 0) {
    out.push(k)
    k = prev[k]
  }
  return out.reverse()
}

export function computeSectionChanges(before: SectionLike[], after: SectionLike[]): SectionChange[] {
  const beforeBy = new Map(before.map((s) => [s.anchor, s]))
  const afterBy = new Map(after.map((s) => [s.anchor, s]))
  const changes: SectionChange[] = []

  // An anchor that passed from one heading to another (a second "Decided" inserted above the first
  // takes `decided` and pushes the old one to `decided~2`; deleting the first hands `decided` to the
  // second) is not a modification of one section: when the heading block that held the anchor, or
  // the one that holds it now, lives on under another anchor, both sides take part in the rename
  // pairing below instead (docs/adr/1960-*). A heading retyped as a new block stays "modified".
  const beforeBlocks = new Set(before.map((s) => s.blockId).filter((b): b is string => !!b))
  const afterBlocks = new Set(after.map((s) => s.blockId).filter((b): b is string => !!b))
  const passed = new Set<string>()
  for (const s of after) {
    const old = beforeBy.get(s.anchor)
    if (old?.blockId && s.blockId && old.blockId !== s.blockId && (afterBlocks.has(old.blockId) || beforeBlocks.has(s.blockId))) passed.add(s.anchor)
  }

  // after-anchor → matched before section (same anchor or rename pair)
  const match = new Map<string, SectionLike>()
  for (const s of after) {
    const old = beforeBy.get(s.anchor)
    if (!old || passed.has(s.anchor)) continue
    match.set(s.anchor, old)
    if (old.version === s.version) continue
    if (old.text === s.text) {
      // Same anchor and body, heading text changed without changing its slug (e.g. letter case).
      changes.push({ kind: 'renamed', anchor: s.anchor, prevAnchor: s.anchor, headingPath: s.headingPath, before: old.text, after: s.text })
    } else {
      changes.push({ kind: 'modified', anchor: s.anchor, prevAnchor: null, headingPath: s.headingPath, before: old.text, after: s.text })
    }
  }

  const removed = before.filter((s) => !afterBy.has(s.anchor) || passed.has(s.anchor))
  const added = after.filter((s) => !beforeBy.has(s.anchor) || passed.has(s.anchor))
  const pairedOld = new Set<string>()
  const pairedNew = new Set<string>()
  if (removed.length && added.length) {
    // 1) same heading block id
    const byBlock = new Map<string, SectionLike>()
    for (const r of removed) if (r.blockId) byBlock.set(r.blockId, r)
    for (const a of added) {
      const r = a.blockId ? byBlock.get(a.blockId) : undefined
      if (!r || pairedOld.has(r.anchor)) continue
      pairedOld.add(r.anchor)
      pairedNew.add(a.anchor)
      match.set(a.anchor, r)
    }
    // 2) identical body, first unpaired candidate in document order
    const byText = new Map<string, SectionLike[]>()
    for (const r of removed) {
      if (pairedOld.has(r.anchor)) continue
      const list = byText.get(r.text)
      if (list) list.push(r)
      else byText.set(r.text, [r])
    }
    const cursor = new Map<string, number>()
    for (const a of added) {
      if (pairedNew.has(a.anchor)) continue
      const list = byText.get(a.text)
      if (!list) continue
      const i = cursor.get(a.text) ?? 0
      if (i >= list.length) continue
      cursor.set(a.text, i + 1)
      pairedOld.add(list[i].anchor)
      pairedNew.add(a.anchor)
      match.set(a.anchor, list[i])
    }
  }
  for (const a of added) {
    if (pairedNew.has(a.anchor)) {
      const r = match.get(a.anchor)!
      changes.push({ kind: 'renamed', anchor: a.anchor, prevAnchor: r.anchor, headingPath: a.headingPath, before: r.text, after: a.text })
    } else {
      changes.push({ kind: 'added', anchor: a.anchor, prevAnchor: null, headingPath: a.headingPath, before: null, after: a.text })
    }
  }
  for (const r of removed) {
    if (pairedOld.has(r.anchor)) continue
    changes.push({ kind: 'removed', anchor: r.anchor, prevAnchor: null, headingPath: r.headingPath, before: r.text, after: null })
  }

  // Moves: old positions of matched sections, in new order; outside the LIS = moved.
  const matched: { s: SectionLike; old: SectionLike }[] = []
  for (const s of after) {
    const old = match.get(s.anchor)
    if (old) matched.push({ s, old })
  }
  if (matched.length > 1) {
    const keep = new Set(longestIncreasingSubsequence(matched.map((m) => m.old.order)))
    for (let i = 0; i < matched.length; i++) {
      if (keep.has(i)) continue
      const { s, old } = matched[i]
      changes.push({ kind: 'moved', anchor: s.anchor, prevAnchor: null, headingPath: s.headingPath, before: String(old.order), after: String(s.order) })
    }
  }
  return changes
}
