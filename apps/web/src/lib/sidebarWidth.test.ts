// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Sidebar width: clamping, the stored value, keyboard steps (docs/adr/1350-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  normalizeSidebarWidth,
  sidebarWidthForKey,
} from './sidebarWidth'

describe('normalizeSidebarWidth', () => {
  it('keeps a stored width inside the range, rounded', () => {
    assert.equal(normalizeSidebarWidth(320), 320)
    assert.equal(normalizeSidebarWidth(320.6), 321)
    assert.equal(normalizeSidebarWidth(10), SIDEBAR_MIN)
    assert.equal(normalizeSidebarWidth(9000), SIDEBAR_MAX)
  })

  it('anything that is not a finite number is the default (old saves have no width)', () => {
    assert.equal(normalizeSidebarWidth(undefined), SIDEBAR_DEFAULT)
    assert.equal(normalizeSidebarWidth('300'), SIDEBAR_DEFAULT)
    assert.equal(normalizeSidebarWidth(Number.NaN), SIDEBAR_DEFAULT)
    assert.equal(normalizeSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_DEFAULT)
  })

  it('the default is the old fixed width and the range is 200–480', () => {
    assert.equal(SIDEBAR_DEFAULT, 260)
    assert.equal(SIDEBAR_MIN, 200)
    assert.equal(SIDEBAR_MAX, 480)
  })
})

describe('sidebarWidthForKey', () => {
  it('arrows step by 16 px, with Shift by 64 px, and stay in range', () => {
    assert.equal(sidebarWidthForKey('ArrowRight', 260, false), 276)
    assert.equal(sidebarWidthForKey('ArrowLeft', 260, false), 244)
    assert.equal(sidebarWidthForKey('ArrowRight', 260, true), 324)
    assert.equal(sidebarWidthForKey('ArrowLeft', 210, false), SIDEBAR_MIN)
    assert.equal(sidebarWidthForKey('ArrowRight', 470, true), SIDEBAR_MAX)
  })

  it('Home / End jump to the ends, Enter back to the default', () => {
    assert.equal(sidebarWidthForKey('Home', 300, false), SIDEBAR_MIN)
    assert.equal(sidebarWidthForKey('End', 300, false), SIDEBAR_MAX)
    assert.equal(sidebarWidthForKey('Enter', 300, false), SIDEBAR_DEFAULT)
  })

  it('other keys are not handled', () => {
    assert.equal(sidebarWidthForKey('a', 300, false), null)
    assert.equal(sidebarWidthForKey('ArrowUp', 300, false), null)
  })
})
