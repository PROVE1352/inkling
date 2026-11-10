import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { placeCaretMenu, shiftIntoView } from './caretMenu'

// A 700 px window; the slash menu's full list is about 1,600 px tall.
const win = { viewTop: 0, viewBottom: 700 }
const caretAt = (top: number) => ({ refTop: top, refBottom: top + 20 })

describe('caret menus: side and height (0.18 integration)', () => {
  it('a line at the bottom of the window: opens above, as tall as the room there', () => {
    const p = placeCaretMenu({ ...win, ...caretAt(660), natural: 1600 })
    assert.equal(p.side, 'top')
    assert.equal(p.maxHeight, 660 - 10 - 10)
    assert.equal(p.height, 640)
  })

  it('room enough below (middle of the page): stays below, as before', () => {
    const p = placeCaretMenu({ ...win, ...caretAt(300), natural: 1600 })
    assert.equal(p.side, 'bottom')
    assert.equal(p.maxHeight, 700 - 10 - (320 + 10))
  })

  it('a little room below (the reported case): above, even while the menu is still empty', () => {
    // the line 90 px above the bottom: 70 px below would hold a menu that has not loaded its items yet
    for (const natural of [0, 40, 1600]) {
      const p = placeCaretMenu({ ...win, ...caretAt(590), natural })
      assert.equal(p.side, 'top', `natural ${natural}`)
      assert.equal(p.maxHeight, 590 - 20)
    }
  })

  it('a short menu takes only its own height', () => {
    const p = placeCaretMenu({ ...win, ...caretAt(100), natural: 90 })
    assert.equal(p.side, 'bottom')
    assert.equal(p.height, 90)
  })

  it('a little room below and less above: the larger side, shrunk to it', () => {
    const p = placeCaretMenu({ viewTop: 0, viewBottom: 260, ...caretAt(60), natural: 1600 })
    assert.equal(p.side, 'bottom')
    assert.equal(p.maxHeight, 260 - 10 - 90)
  })

  it('a phone keyboard: the visual viewport ends above the caret line, the menu goes above', () => {
    // layout viewport 800 px, keyboard leaves 0..420 visible; caret at 380
    const p = placeCaretMenu({ viewTop: 0, viewBottom: 420, ...caretAt(380), natural: 1600 })
    assert.equal(p.side, 'top')
    assert.ok(p.maxHeight <= 380 - 20 && p.maxHeight > 300)
  })

  it('never negative, even with the caret outside the view', () => {
    const p = placeCaretMenu({ ...win, ...caretAt(900), natural: 400 })
    assert.equal(p.side, 'top')
    assert.ok(p.maxHeight >= 0)
    const q = placeCaretMenu({ ...win, refTop: -50, refBottom: -30, natural: 400 })
    assert.ok(q.maxHeight >= 0)
  })

  it('horizontal: a menu that would run past the right edge moves left, never past the left edge', () => {
    assert.equal(shiftIntoView(100, 300, 0, 1280), 0)
    assert.equal(shiftIntoView(1100, 300, 0, 1280), 1280 - 10 - 300 - 1100)
    assert.equal(shiftIntoView(-5, 300, 0, 1280), 15)
    assert.equal(shiftIntoView(50, 500, 0, 390), 10 - 50)
  })
})
