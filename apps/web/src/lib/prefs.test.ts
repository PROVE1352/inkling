// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Line width setting and the migration from the old on/off "readable line length" (docs/adr/1090-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LINE_WIDTH_DEFAULT,
  LINE_WIDTH_FULL,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  normalizeLineWidth,
} from './prefs'

describe('normalizeLineWidth', () => {
  it('migrates the old readableLineLength switch: on → default, off → full, missing → default', () => {
    assert.equal(normalizeLineWidth(undefined, true), LINE_WIDTH_DEFAULT)
    assert.equal(normalizeLineWidth(undefined, false), LINE_WIDTH_FULL)
    assert.equal(normalizeLineWidth(undefined, undefined), LINE_WIDTH_DEFAULT)
  })

  it('a stored width wins over the old switch', () => {
    assert.equal(normalizeLineWidth(900, false), 900)
    assert.equal(normalizeLineWidth(LINE_WIDTH_FULL, true), LINE_WIDTH_FULL)
  })

  it('clamps to the slider range and treats 0 / negatives as full', () => {
    assert.equal(normalizeLineWidth(100), LINE_WIDTH_MIN)
    assert.equal(normalizeLineWidth(5000), LINE_WIDTH_MAX)
    assert.equal(normalizeLineWidth(-1), LINE_WIDTH_FULL)
    assert.equal(normalizeLineWidth(Number.NaN), LINE_WIDTH_DEFAULT)
    assert.equal(normalizeLineWidth('800'), LINE_WIDTH_DEFAULT)
  })

  it('default is about Obsidian’s readable line length', () => {
    assert.equal(LINE_WIDTH_DEFAULT, 700)
  })
})
