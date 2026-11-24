// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/web && node ../../scripts/run-tests.mjs --test-name-pattern="agentView"
// "What an agent reads" helpers (docs/adr/2389-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { INTRO_ANCHOR, contextSummary, outlineRows, sampleQuestion, shortAnchors } from './agentView'

const sec = (anchor: string, tokens: number, version = 'v1', level = 2) => ({
  anchor,
  headingPath: anchor === INTRO_ANCHOR ? '' : anchor,
  level: anchor === INTRO_ANCHOR ? 0 : level,
  tokens,
  version,
})

describe('agentView outlineRows', () => {
  it('a page with no tokens gives 0 % everywhere and keeps every row', () => {
    const rows = outlineRows({ sections: [sec(INTRO_ANCHOR, 0), sec('a', 0)], tokens: 0 })
    assert.deepEqual(rows.map((r) => r.pct), [0, 0])
    assert.equal(rows.length, 2)
    assert.deepEqual(outlineRows({ sections: [], tokens: 0 }), [])
  })

  it('rounded percentages add up to 100 (largest remainder)', () => {
    const rows = outlineRows({ sections: [sec('a', 1), sec('b', 1), sec('c', 1)], tokens: 3 })
    assert.deepEqual(rows.map((r) => r.pct), [34, 33, 33])
    const uneven = outlineRows({ sections: [sec('a', 155), sec('b', 230), sec('c', 615)], tokens: 1000 })
    assert.deepEqual(uneven.map((r) => r.pct), [16, 23, 61])
    assert.equal(uneven.reduce((n, r) => n + r.pct, 0), 100)
  })

  it('tiny sections may round to 0 (shown as <1%); the total stays 100', () => {
    const rows = outlineRows({ sections: [sec('big', 995), sec('tiny', 2), sec('empty', 0), sec('small', 3)], tokens: 1000 })
    assert.deepEqual(rows.map((r) => r.pct), [100, 0, 0, 0])
    assert.equal(rows.reduce((n, r) => n + r.pct, 0), 100)
  })

  it('the untitled first section (anchor _intro) keeps its anchor, version and level', () => {
    const [intro, h] = outlineRows({ sections: [sec(INTRO_ANCHOR, 40, 'v7'), sec('1-blocks', 60, 'v9')], tokens: 100 })
    assert.equal(intro.anchor, '_intro')
    assert.equal(intro.headingPath, '')
    assert.equal(intro.level, 0)
    assert.equal(intro.version, 'v7')
    assert.equal(intro.pct, 40)
    assert.equal(h.pct, 60)
  })

  it('hundreds of sections: still adds up to 100', () => {
    const many = Array.from({ length: 600 }, (_, i) => sec(`s-${i}`, 5 + (i % 7)))
    const rows = outlineRows({ sections: many, tokens: many.reduce((n, s) => n + s.tokens, 0) })
    assert.equal(rows.length, 600)
    assert.equal(rows.reduce((n, r) => n + r.pct, 0), 100)
  })
})

describe('agentView shortAnchors', () => {
  it('top-level anchors stay; a nested one keeps the fewest trailing segments that are unique', () => {
    const m = shortAnchors(['_intro', '5-ai-agents', 'setup/notes', 'usage/notes', 'usage/tips', 'a/b/c'])
    assert.equal(m.get('_intro'), '_intro')
    assert.equal(m.get('5-ai-agents'), '5-ai-agents')
    assert.equal(m.get('setup/notes'), 'setup/notes')
    assert.equal(m.get('usage/notes'), 'usage/notes')
    assert.equal(m.get('usage/tips'), 'tips')
    assert.equal(m.get('a/b/c'), 'c')
  })

  it('a suffix equal to another top-level anchor is not used', () => {
    const m = shortAnchors(['notes', 'setup/notes'])
    assert.equal(m.get('notes'), 'notes')
    assert.equal(m.get('setup/notes'), 'setup/notes')
  })
})

describe('agentView contextSummary', () => {
  const page = 'p-1'
  const result = {
    fragments: [
      {
        pageId: page,
        title: 'Getting started',
        anchor: '5-ai-agents',
        sections: [{ anchor: '5-ai-agents', short: '5-ai-agents' }, { anchor: 'a-few-shortcuts', short: 'a-few-shortcuts' }],
        tokens: 120,
      },
      { pageId: 'p-2', title: 'Other', anchor: 'guide/setup', sections: [{ anchor: 'guide/setup', short: 'setup' }], tokens: 80 },
    ],
    more: [],
    titleOnly: [],
    budget: 3500,
    usedTokens: 205,
    candidates: 4,
  }

  it('one row per fragment, merged sections counted one by one', () => {
    const s = contextSummary(result, page)
    assert.equal(s.rows.length, 2)
    assert.equal(s.sections, 3)
    assert.deepEqual(s.rows[0].anchors, ['5-ai-agents', 'a-few-shortcuts'])
    assert.equal(s.rows[0].anchor, '5-ai-agents')
    assert.equal(s.rows[0].tokens, 120)
    assert.equal(s.rows[1].short, 'setup')
  })

  it('marks the rows of this page', () => {
    const s = contextSummary(result, page)
    assert.deepEqual(s.rows.map((r) => r.onThisPage), [true, false])
    assert.deepEqual(contextSummary(result, 'p-2').rows.map((r) => r.onThisPage), [false, true])
  })

  it('used is the server usedTokens as given, not a sum of the rows', () => {
    const s = contextSummary(result, page)
    assert.equal(s.used, 205)
    assert.equal(s.budget, 3500)
  })

  it('an empty result', () => {
    const s = contextSummary({ fragments: [], more: [], titleOnly: [], budget: 3500, usedTokens: 0, candidates: 0 }, page)
    assert.deepEqual(s, { rows: [], used: 0, budget: 3500, sections: 0 })
  })

  it('a fragment without a sections list counts its own anchor', () => {
    const s = contextSummary({ fragments: [{ pageId: page, title: 'T', anchor: 'x', sections: [], tokens: 9 }], budget: 100, usedTokens: 9 }, page)
    assert.equal(s.sections, 1)
    assert.deepEqual(s.rows[0].anchors, ['x'])
    assert.equal(s.rows[0].short, 'x')
  })
})

describe('agentView sampleQuestion', () => {
  // Words of the sample page's "AI agents" section (server onboarding/sample.ts). Kept as constants on
  // purpose: if the sample's wording changes, this is where the question has to follow.
  it('en uses words from the sample text', () => {
    const q = sampleQuestion('en')
    for (const w of ['MCP', 'client', 'agent']) assert.ok(q.includes(w), `"${q}" should contain "${w}"`)
  })

  it('ko uses words from the sample text', () => {
    const q = sampleQuestion('ko')
    for (const w of ['MCP', '클라이언트', '에이전트']) assert.ok(q.includes(w), `"${q}" should contain "${w}"`)
  })

  it('fits the server limit for one query', () => {
    for (const l of ['en', 'ko']) assert.ok(sampleQuestion(l).length <= 300)
  })
})
