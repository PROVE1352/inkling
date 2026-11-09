// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/web && node ../../scripts/run-tests.mjs --test-name-pattern=table
// Typing a table quickly (docs/adr/1642-*): the pipe row, the "/표 3x4" size and the IME guard.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  isImeEnter,
  parsePipeRow,
  tableSizeFromQuery,
} from './tableInput'

describe('parsePipeRow', () => {
  it('cells of a row that starts and ends with a pipe, trimmed', () => {
    assert.deepEqual(parsePipeRow('| 이름 | 역할 | 마감 |'), ['이름', '역할', '마감'])
    assert.deepEqual(parsePipeRow('|a|b|'), ['a', 'b'])
    assert.deepEqual(parsePipeRow('   | a |  b  |  '), ['a', 'b'])
  })

  it('keeps empty cells in the middle', () => {
    assert.deepEqual(parsePipeRow('| a |  | c |'), ['a', '', 'c'])
  })

  it('\\| is a pipe inside a cell', () => {
    assert.deepEqual(parsePipeRow('| a \\| b | c |'), ['a | b', 'c'])
  })

  it('a backslash before anything else stays', () => {
    assert.deepEqual(parsePipeRow('| C:\\temp | x |'), ['C:\\temp', 'x'])
  })

  it('one cell is not a table', () => {
    assert.equal(parsePipeRow('|a|'), null)
    assert.equal(parsePipeRow('| only one |'), null)
    assert.equal(parsePipeRow('||'), null)
    assert.equal(parsePipeRow('|'), null)
  })

  it('both ends need a pipe, and the last one must not be escaped', () => {
    assert.equal(parsePipeRow('| a | b'), null)
    assert.equal(parsePipeRow('a | b |'), null)
    assert.equal(parsePipeRow('| a | b \\|'), null)
    assert.equal(parsePipeRow('plain text'), null)
    assert.equal(parsePipeRow(''), null)
  })

  it('a separator row alone is not a header', () => {
    assert.equal(parsePipeRow('|---|---|'), null)
    assert.equal(parsePipeRow('| :--- | ---: |'), null)
  })

  it('no line breaks', () => {
    assert.equal(parsePipeRow('| a | b |\n| c | d |'), null)
  })

  it('caps the column count', () => {
    const wide = '|' + Array.from({ length: MAX_TABLE_COLS + 5 }, (_, i) => ` c${i} `).join('|') + '|'
    assert.equal(parsePipeRow(wide), null)
  })
})

describe('tableSizeFromQuery', () => {
  it('columns x rows after 표 / table / 테이블', () => {
    assert.deepEqual(tableSizeFromQuery('표 3x4'), { cols: 3, rows: 4 })
    assert.deepEqual(tableSizeFromQuery('table 3x4'), { cols: 3, rows: 4 })
    assert.deepEqual(tableSizeFromQuery('Table 2*5'), { cols: 2, rows: 5 })
    assert.deepEqual(tableSizeFromQuery('표3×4'), { cols: 3, rows: 4 })
    assert.deepEqual(tableSizeFromQuery('테이블 4 x 2'), { cols: 4, rows: 2 })
  })

  it('a size that is not finished yet is a partial match', () => {
    assert.deepEqual(tableSizeFromQuery('표 3'), { cols: 3, rows: null })
    assert.deepEqual(tableSizeFromQuery('표 3x'), { cols: 3, rows: null })
    assert.deepEqual(tableSizeFromQuery('table 12'), { cols: 12, rows: null })
  })

  it('no digits, other words, zero or too large → null', () => {
    assert.equal(tableSizeFromQuery('표'), null)
    assert.equal(tableSizeFromQuery('table'), null)
    assert.equal(tableSizeFromQuery('callout 3x4'), null)
    assert.equal(tableSizeFromQuery('표 0x4'), null)
    assert.equal(tableSizeFromQuery('표 3x0'), null)
    assert.equal(tableSizeFromQuery(`표 ${MAX_TABLE_COLS + 1}x2`), null)
    assert.equal(tableSizeFromQuery(`표 2x${MAX_TABLE_ROWS + 1}`), null)
  })
})

describe('isImeEnter', () => {
  it('an Enter that ends a composition (Korean IME) is not ours', () => {
    assert.equal(isImeEnter({ isComposing: true, keyCode: 13 }), true)
    assert.equal(isImeEnter({ isComposing: false, keyCode: 229 }), true)
    assert.equal(isImeEnter({ isComposing: false, keyCode: 13 }), false)
  })
})
