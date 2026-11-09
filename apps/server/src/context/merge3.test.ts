// Three-way merge over units (docs/adr/1621-*): hunks of base→theirs, conflicts against base→ours,
// and the merged sequence for a chosen set of hunks.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildMerge, planMerge } from './merge3'
import type { MergePiece } from './merge3'

/** The merged units as text (ours/theirs/base pieces looked up in their sequences). */
function text(base: string[], ours: string[], theirs: string[], pieces: MergePiece[]): string[] {
  return pieces.map((p) => (p.from === 'ours' ? ours[p.index] : p.from === 'theirs' ? theirs[p.index] : base[p.index]))
}

function mergeAll(base: string[], ours: string[], theirs: string[], pick?: (h: { conflict: boolean }) => boolean) {
  const plan = planMerge(base, ours, theirs)
  assert.ok(plan)
  const chosen = new Set(plan.hunks.filter((h) => (pick ? pick(h) : !h.conflict)).map((h) => h.id))
  return { plan, out: text(base, ours, theirs, buildMerge(plan, chosen)) }
}

describe('merge3', () => {
  it('unchanged ours: every hunk is clean and applying all gives theirs exactly', () => {
    const base = ['# H', 'a', 'b', 'c', 'd']
    const theirs = ['# H', 'a', 'B', 'c', 'd', 'e']
    const { plan, out } = mergeAll(base, base, theirs)
    assert.equal(plan.hunks.length, 2)
    assert.ok(plan.hunks.every((h) => !h.conflict))
    assert.deepEqual(out, theirs)
  })

  it('disjoint edits: the person keeps their line, the agent hunk applies', () => {
    const base = ['a', 'b', 'c', 'd']
    const ours = ['A', 'b', 'c', 'd'] // person edited line 1
    const theirs = ['a', 'b', 'c', 'D'] // agent edited line 4
    const { plan, out } = mergeAll(base, ours, theirs)
    assert.equal(plan.hunks.length, 1)
    assert.equal(plan.hunks[0].conflict, false)
    assert.deepEqual(out, ['A', 'b', 'c', 'D'])
  })

  it('adjacent edits (different units) do not conflict', () => {
    const base = ['a', 'b', 'c']
    const { plan, out } = mergeAll(base, ['a', 'B1', 'c'], ['a', 'b', 'C2'])
    assert.equal(plan.hunks[0].conflict, false)
    assert.deepEqual(out, ['a', 'B1', 'C2'])
  })

  it('overlapping edits conflict; unselected keeps the person, selected takes the agent there', () => {
    const base = ['a', 'b', 'c']
    const ours = ['a', 'b-person', 'c']
    const theirs = ['a', 'b-agent', 'c']
    const keep = mergeAll(base, ours, theirs)
    assert.equal(keep.plan.hunks.length, 1)
    assert.equal(keep.plan.hunks[0].conflict, true)
    assert.deepEqual(keep.plan.hunks[0].ours, { start: 1, end: 2 })
    assert.deepEqual(keep.out, ours)
    const take = mergeAll(base, ours, theirs, () => true)
    assert.deepEqual(take.out, theirs)
  })

  it('two insertions at the same point conflict; applying keeps both (person first)', () => {
    const base = ['a', 'b']
    const ours = ['a', 'b', 'p']
    const theirs = ['a', 'b', 't']
    const keep = mergeAll(base, ours, theirs)
    assert.equal(keep.plan.hunks[0].conflict, true)
    assert.deepEqual(keep.out, ['a', 'b', 'p'])
    const take = mergeAll(base, ours, theirs, () => true)
    assert.deepEqual(take.out, ['a', 'b', 'p', 't'])
  })

  it('agent deletes a unit the person edited: conflict', () => {
    const base = ['a', 'b', 'c']
    const { plan, out } = mergeAll(base, ['a', 'b2', 'c'], ['a', 'c'])
    assert.equal(plan.hunks[0].conflict, true)
    assert.deepEqual(out, ['a', 'b2', 'c'])
  })

  it('an insertion inside a range the other side replaced conflicts; at its edge it does not', () => {
    const base = ['a', 'b', 'c', 'd']
    // person replaced b,c; agent inserts between b and c → inside → conflict
    const inside = planMerge(base, ['a', 'X', 'd'], ['a', 'b', 'n', 'c', 'd'])!
    assert.equal(inside.hunks[0].conflict, true)
    // agent inserts right after c (edge of the person's range) → clean, placed after
    const edge = mergeAll(base, ['a', 'X', 'd'], ['a', 'b', 'c', 'n', 'd'])
    assert.equal(edge.plan.hunks[0].conflict, false)
    assert.deepEqual(edge.out, ['a', 'X', 'n', 'd'])
  })

  it('choosing a subset of clean hunks applies only those', () => {
    const base = ['h', 'a', 'b', 'c']
    const theirs = ['h2', 'a', 'B', 'c', 'z']
    const plan = planMerge(base, base, theirs)!
    assert.equal(plan.hunks.length, 3)
    const only = new Set([plan.hunks[1].id])
    assert.deepEqual(text(base, base, theirs, buildMerge(plan, only)), ['h', 'a', 'B', 'c'])
    assert.deepEqual(text(base, base, theirs, buildMerge(plan, new Set())), base)
  })

  it('person and agent made the same change: no hunk conflicts with itself, result has it once', () => {
    const base = ['a', 'b']
    const both = ['a', 'B']
    const { plan, out } = mergeAll(base, both, both)
    // the hunk overlaps the person's identical edit: reported as already there, not as a conflict
    assert.equal(plan.hunks[0].conflict, false)
    assert.equal(plan.hunks[0].same, true)
    assert.deepEqual(out, both)
  })

  it('unchanged units between clusters come from ours (so their blocks are the live ones)', () => {
    const base = ['a', 'b', 'c']
    const plan = planMerge(base, ['a', 'b', 'c', 'p'], ['A', 'b', 'c'])!
    const pieces = buildMerge(plan, new Set(plan.hunks.map((h) => h.id)))
    assert.deepEqual(pieces.map((p) => p.from), ['theirs', 'ours', 'ours', 'ours'])
  })

  it('k blocks replaced by k blocks are k hunks: only the edited one overlaps the person', () => {
    const base = ['a', 'b', 'c', 'd']
    const ours = ['a', 'b', 'C-person', 'd']
    const theirs = ['a', 'B-agent', 'C-agent', 'd']
    const plan = planMerge(base, ours, theirs)!
    assert.deepEqual(plan.hunks.map((h) => h.conflict), [false, true])
    assert.deepEqual(text(base, ours, theirs, buildMerge(plan, new Set([0]))), ['a', 'B-agent', 'C-person', 'd'])
  })

  it('over the caps → null (caller refuses instead of guessing)', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `x${i}`)
    const other = Array.from({ length: 1000 }, (_, i) => `y${i}`)
    assert.equal(planMerge(big, big, other, { maxD: 50 }), null)
  })
})
