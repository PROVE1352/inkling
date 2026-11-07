// Review priority model and the MCP review note (docs/adr/0951-*, 0953-*). No database needed.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addLocalDays,
  dueOnFor,
  estimateLambda,
  estMinutes,
  isArchiveCandidate,
  isLiving,
  localDaysBetween,
  priorityScore,
  pStale,
} from './review'
import { renderFindContext, reviewNote } from './mcpTools/contextTools'

const near = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

describe('review priority model', () => {
  it('with no change signals, p is exactly 0.5 at the workspace interval', () => {
    const λ = estimateLambda({ intervalDays: 90, selfChangeDays: 0, neighborChangeDays: 0, windowDays: 90 })
    near(λ, Math.LN2 / 90) // 0.0077 per day
    near(pStale(λ, 90), 0.5)
    near(pStale(λ, 0), 0)
    near(pStale(λ, -5), 0) // clock skew never goes negative
  })

  it('linked pages that change raise λ (small numbers)', () => {
    // neighbours changed on 9 of 90 days: + 0.1 × 0.1 = +0.01 per day
    const λ = estimateLambda({ intervalDays: 90, selfChangeDays: 0, neighborChangeDays: 9, windowDays: 90 })
    near(λ, 0.0077 + 0.01, 1e-4)
    // after 30 days: 1 − e^(−0.531) ≈ 0.412 (vs 0.207 without the neighbours)
    near(pStale(λ, 30), 0.412, 1e-3)
    // own edits weigh half as much: 18 of 90 days → + 0.05 × 0.2 = +0.01
    const λself = estimateLambda({ intervalDays: 90, selfChangeDays: 18, neighborChangeDays: 0, windowDays: 90 })
    near(λself, λ)
  })

  it('score = max(reads, 0.5) × p, rounded', () => {
    assert.equal(priorityScore(0, 0.5), 0.25) // unread still ranks, below anything read
    assert.equal(priorityScore(10, 0.412), 4.12)
    assert.equal(priorityScore(5, 0.8995), 4.5)
  })

  it('living documents: edited on ≥ 40 % of the last 30 days, unless set by hand', () => {
    assert.equal(isLiving(null, 12), true)
    assert.equal(isLiving(null, 11), false)
    assert.equal(isLiving(false, 30), false)
    assert.equal(isLiving(true, 0), true)
  })

  it('archive candidates: unread for 90 days and 180+ days since the baseline', () => {
    assert.equal(isArchiveCandidate(0, 180), true)
    assert.equal(isArchiveCandidate(0, 179), false)
    assert.equal(isArchiveCandidate(1, 400), false)
  })

  it('review time and due date', () => {
    assert.equal(estMinutes(0), 1)
    assert.equal(estMinutes(6000), 5)
    assert.equal(dueOnFor(new Date(2026, 0, 1, 9), Math.LN2 / 90), '2026-04-01')
    assert.equal(addLocalDays(new Date(2026, 0, 31, 23, 30), 30), '2026-03-02')
    assert.equal(localDaysBetween(new Date(2026, 0, 31, 23, 59), new Date(2026, 1, 1, 0, 1)), 1)
  })
})

describe('find_context review note', () => {
  const result = {
    fragments: [
      { pageId: 'p1', title: 'Runbook', headingPath: 'Deploy', sections: [{ anchor: 'deploy', version: 'abc' }], truncated: false, text: 'x' },
    ],
    more: [],
    titleOnly: [],
    budget: 3500,
    usedTokens: 10,
    candidates: 1,
  } as unknown as Parameters<typeof renderFindContext>[1]

  it('pages without facts render byte-identical (prompt-cache friendly, docs/adr/0937-*)', () => {
    assert.equal(renderFindContext('q', result, new Map()), renderFindContext('q', result))
  })

  it('adds owner, review date and the rounded p; document dates only', () => {
    const facts = new Map([['p1', { owner: 'Alice', reviewedOn: '2026-10-01', dueOn: '2026-10-31', stale: true, p: 0.6234, living: false }]])
    assert.match(renderFindContext('q', result, facts), /\(page p1; §deploy v=abc; owner Alice, reviewed 2026-10-01, stale p=0\.62\)/)
    assert.equal(reviewNote({ owner: null, reviewedOn: null, dueOn: null, stale: false, p: 0.1, living: false }), '')
    assert.equal(reviewNote({ owner: null, reviewedOn: null, dueOn: null, stale: false, p: 0.9, living: true }), '; living document')
  })
})
