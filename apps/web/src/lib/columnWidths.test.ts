// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Table column widths stored on the view (docs/adr/1351-*) on top of the track minimums of ADR 1322.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ADD_COL,
  FIELD_MIN,
  TITLE_MIN,
  clampColumnWidth,
  columnTracks,
  columnWidthForKey,
  withColumnWidth,
} from './columnWidths'

const cols = [{ id: 'status' }, { id: 'owner' }, { id: 'due' }]

describe('columnTracks', () => {
  it('without stored widths: the ADR 1322 tracks and the sum of the minimums', () => {
    const t = columnTracks(cols, {})
    assert.deepEqual(t.tracks, [
      'minmax(240px, 1.6fr)',
      'minmax(150px, 1fr)',
      'minmax(150px, 1fr)',
      'minmax(150px, 1fr)',
      '44px',
    ])
    assert.equal(t.minWidth, TITLE_MIN + 3 * FIELD_MIN + ADD_COL)
  })

  it('a stored width is a fixed track and counts in the minimum width', () => {
    const t = columnTracks(cols, { columnWidths: { owner: 320 }, titleWidth: 300 })
    assert.deepEqual(t.tracks, ['300px', 'minmax(150px, 1fr)', '320px', 'minmax(150px, 1fr)', '44px'])
    assert.equal(t.minWidth, 300 + 150 + 320 + 150 + ADD_COL)
  })

  it('when every column is fixed the trailing column takes the rest of a wide pane', () => {
    const t = columnTracks([{ id: 'a' }], { columnWidths: { a: 200 }, titleWidth: 260 })
    assert.deepEqual(t.tracks, ['260px', '200px', `minmax(${ADD_COL}px, 1fr)`])
    assert.equal(t.minWidth, 260 + 200 + ADD_COL)
  })

  it('widths of hidden or deleted fields are ignored, out-of-range values clamped', () => {
    const t = columnTracks([{ id: 'a' }], { columnWidths: { a: 20, gone: 900 } })
    assert.deepEqual(t.tracks, ['minmax(240px, 1.6fr)', `${FIELD_MIN}px`, '44px'])
  })

  it('each track can be overridden by a CSS variable while a column is dragged', () => {
    const t = columnTracks(cols, { columnWidths: { owner: 320 } })
    assert.equal(t.template.split('var(--tc-').length - 1, 4)
    assert.match(t.template, /^var\(--tc-0, minmax\(240px, 1\.6fr\)\) /)
    assert.match(t.template, /var\(--tc-2, 320px\)/)
    assert.match(t.template, / 44px$/)
  })
})

describe('withColumnWidth', () => {
  it('sets, replaces and removes one width and keeps the rest of the config', () => {
    const base = { sorts: [{ fieldId: 'due', dir: 'asc' }], columnWidths: { a: 200 } }
    assert.deepEqual(withColumnWidth(base, 'b', 300), { ...base, columnWidths: { a: 200, b: 300 } })
    assert.deepEqual(withColumnWidth(base, 'a', null), { sorts: base.sorts })
    assert.deepEqual(withColumnWidth(base, null, 500), { ...base, titleWidth: 500 })
    assert.deepEqual(withColumnWidth({ titleWidth: 500 }, null, null), {})
  })

  it('clamps to the column minimum (title 240, fields 150)', () => {
    assert.deepEqual(withColumnWidth({}, 'a', 10), { columnWidths: { a: FIELD_MIN } })
    assert.deepEqual(withColumnWidth({}, null, 10), { titleWidth: TITLE_MIN })
    assert.equal(clampColumnWidth(99999, false), 1600)
  })
})

describe('columnWidthForKey', () => {
  it('arrows step 16 px (Shift 64), Home = minimum', () => {
    assert.equal(columnWidthForKey('ArrowRight', 200, false, false), 216)
    assert.equal(columnWidthForKey('ArrowLeft', 200, true, false), FIELD_MIN)
    assert.equal(columnWidthForKey('Home', 500, false, true), TITLE_MIN)
    assert.equal(columnWidthForKey('x', 500, false, false), null)
  })
})
