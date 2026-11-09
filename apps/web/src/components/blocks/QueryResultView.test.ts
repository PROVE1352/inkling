// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Query block result rendering: TABLE column alignment and the truncation footer.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocaleChoice } from '../../i18n'
import { ResultView, resultFooterText } from './QueryResultView'

setLocaleChoice('en') // Node's navigator.language follows the host; pin the dictionary

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    pageId: `p${i}`,
    title: i === 0 ? 'A rather long page title that makes the first column wide' : `P${i}`,
    cells: ['Folder', '#tag'],
  }))

const table = (n: number, truncated: boolean) => ({
  type: 'TABLE',
  withoutId: false,
  columns: ['Folder', 'Tags'],
  rows: rows(n),
  truncated,
  elapsedMs: 1.5,
})

describe('query block TABLE layout', () => {
  it('defines the column tracks once on the table and lays every row on them with subgrid', () => {
    const html = renderToStaticMarkup(createElement(ResultView, { data: table(3, false), wsId: 'w' }))
    // exactly one track definition (the table), not one per row
    assert.equal(html.match(/grid-template-columns:repeat\(/g)?.length, 1)
    assert.match(html, /role="table" style="display:grid;grid-template-columns:repeat\(3, minmax\(6rem, auto\)\)"/)
    // header row + 3 data rows, all subgrid rows spanning every column
    const rowStyles = [...html.matchAll(/role="row" style="([^"]*)"/g)].map((m) => m[1])
    assert.equal(rowStyles.length, 4)
    for (const s of rowStyles) assert.equal(s, 'display:grid;grid-template-columns:subgrid;grid-column:1 / -1')
    // still an ARIA table, not a <table> element (BlockNote's table handles would grab it)
    assert.doesNotMatch(html, /<table/)
    assert.equal(html.match(/role="columnheader"/g)?.length, 3)
  })
})

describe('query block footer', () => {
  it('a result that exactly fills LIMIT is not reported as truncated', () => {
    // the server fetched LIMIT + 1 and got LIMIT back → truncated=false
    const text = resultFooterText({ rows: rows(12), truncated: false, elapsedMs: 2.7 })
    assert.equal(text, '12 results · 2.7 ms')
    assert.doesNotMatch(text, /first/i)
  })
  it('only the server flag turns on "Showing the first N"', () => {
    assert.equal(resultFooterText({ rows: rows(12), truncated: true, elapsedMs: 2.7 }), 'Showing the first 12 results · 2.7 ms')
  })
})

describe('query block person and relation cells (docs/adr/1320-*)', () => {
  const ref = (pageId: string, title: string) => ({ ref: 'page', pageId, title })
  const data = (type: 'TABLE' | 'LIST', cells: unknown[]) => ({
    type,
    withoutId: false,
    columns: type === 'TABLE' ? ['Owner', 'Blocked by'] : ['value'],
    rows: [{ pageId: 'r1', title: 'Row', cells }],
    truncated: false,
    elapsedMs: 1,
  })
  it('shows relation refs as links to the linked pages, the person as text', () => {
    const html = renderToStaticMarkup(
      createElement(ResultView, { data: data('TABLE', ['Priya Nair', [ref('a1', 'Search'), ref('b2', '')]]), wsId: 'w' }),
    )
    assert.match(html, />Priya Nair</)
    assert.match(html, /<a href="\/w\/w\/p\/a1"[^>]*>Search<\/a>/)
    // an untitled linked row reads "Untitled", never an id
    assert.match(html, /<a href="\/w\/w\/p\/b2"[^>]*>Untitled<\/a>/)
    assert.match(html, /<\/a><\/span><span>, <a/)
    assert.doesNotMatch(html, /pageId|&quot;/)
  })
  it('LIST uses the same cell rendering', () => {
    const html = renderToStaticMarkup(createElement(ResultView, { data: data('LIST', [[ref('a1', 'Search')]]), wsId: 'w' }))
    assert.match(html, /<a href="\/w\/w\/p\/a1"[^>]*>Search<\/a>/)
  })
  it('an empty relation and a null person render empty', () => {
    const html = renderToStaticMarkup(createElement(ResultView, { data: data('TABLE', [null, []]), wsId: 'w' }))
    assert.equal(html.match(/role="cell"[^>]*><\/div>/g)?.length, 2)
  })
})
