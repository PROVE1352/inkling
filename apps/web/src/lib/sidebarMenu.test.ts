// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/sidebarMenu.test.ts
// Sidebar menu customization: stored { order, hidden } + this build's menus → what the sidebar shows (docs/adr/1020-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SIDEBAR_MENU_DEFAULT_HIDDEN, SIDEBAR_MENU_IDS } from '@inkling/shared'
import {
  compactSidebarFooter,
  expandedMenusLayout,
  expandedTreeMinHeight,
  menusThatFit,
  moveEntry,
  resolveSidebarMenu,
  rowsOutOfView,
  setEntryHidden,
  sidebarTreeMinHeight,
  toSidebarPrefs,
  visibleSidebarMenu,
} from './sidebarMenu'

const KNOWN = ['search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today']
// 0.11 adds Later and Threads right after search (docs/adr/1410-*, 1412-*).
const CURRENT = ['search', 'later', 'threads', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today']

describe('visibleSidebarMenu', () => {
  it('the shared default list is the current sidebar order', () => {
    assert.deepEqual([...SIDEBAR_MENU_IDS], CURRENT)
  })

  it('a list saved before 0.11 shows Later and Threads after search, wherever search is', () => {
    const prefs = { order: ['today', 'graph', 'search', 'tags', 'shared', 'due', 'calendar', 'activity'], hidden: ['tags'] }
    assert.deepEqual(visibleSidebarMenu(prefs, CURRENT), ['today', 'graph', 'search', 'later', 'threads', 'shared', 'due', 'calendar', 'activity'])
  })

  it('nothing stored, or empty lists → every menu in the default order', () => {
    assert.deepEqual(visibleSidebarMenu(null, KNOWN), KNOWN)
    assert.deepEqual(visibleSidebarMenu(undefined, KNOWN), KNOWN)
    assert.deepEqual(visibleSidebarMenu({ order: [], hidden: [] }, KNOWN), KNOWN)
  })

  it('applies the saved order and removes hidden menus', () => {
    const prefs = { order: ['today', 'calendar', 'search', 'graph', 'tags', 'shared', 'due', 'activity'], hidden: ['tags', 'due'] }
    assert.deepEqual(visibleSidebarMenu(prefs, KNOWN), ['today', 'calendar', 'search', 'graph', 'shared', 'activity'])
  })

  it('ignores ids this build does not know, in both lists', () => {
    const prefs = { order: ['inbox', 'graph', 'search', 'old-thing'], hidden: ['inbox', 'nope'] }
    const out = visibleSidebarMenu(prefs, KNOWN)
    assert.ok(!out.includes('inbox') && !out.includes('old-thing') && !out.includes('nope'))
    assert.ok(out.indexOf('graph') < out.indexOf('search'))
    assert.equal(out.length, KNOWN.length)
  })

  it('a menu added later shows at its default slot: after its default predecessor', () => {
    // Saved before "activity" existed: the person moved today to the top.
    const prefs = { order: ['today', 'search', 'graph', 'tags', 'shared', 'due', 'calendar'], hidden: [] }
    assert.deepEqual(visibleSidebarMenu(prefs, KNOWN), ['today', 'search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity'])
    // Predecessor moved: the new menu follows it wherever it is now.
    const moved = { order: ['calendar', 'today', 'search', 'graph', 'tags', 'shared', 'due'], hidden: [] }
    assert.deepEqual(visibleSidebarMenu(moved, KNOWN), ['calendar', 'activity', 'today', 'search', 'graph', 'tags', 'shared', 'due'])
    // A new first menu (no predecessor) goes to the front.
    const first = { order: ['graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today'], hidden: [] }
    assert.deepEqual(visibleSidebarMenu(first, KNOWN)[0], 'search')
  })

  it('a new menu is visible even when its default predecessor is hidden', () => {
    const prefs = { order: ['search', 'graph', 'tags', 'shared', 'due', 'calendar', 'today'], hidden: ['calendar'] }
    assert.deepEqual(visibleSidebarMenu(prefs, KNOWN), ['search', 'graph', 'tags', 'shared', 'due', 'activity', 'today'])
  })

  it('duplicates in a stored order count once', () => {
    const prefs = { order: ['graph', 'graph', 'search'], hidden: [] }
    const out = visibleSidebarMenu(prefs, KNOWN)
    assert.equal(out.filter((id) => id === 'graph').length, 1)
    assert.equal(out.length, KNOWN.length)
  })

  it('everything hidden → an empty list (the settings link lives outside this block)', () => {
    assert.deepEqual(visibleSidebarMenu({ order: [], hidden: [...KNOWN] }, KNOWN), [])
  })
})

describe('resolveSidebarMenu / toSidebarPrefs', () => {
  it('round-trips an edit', () => {
    let list = resolveSidebarMenu(null, KNOWN)
    list = moveEntry(list, 7, 0) // today to the top
    list = setEntryHidden(list, 'tags', true)
    const prefs = toSidebarPrefs(list, KNOWN, null)
    assert.deepEqual(prefs, { order: ['today', 'search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity'], hidden: ['tags'] })
    assert.deepEqual(resolveSidebarMenu(prefs, KNOWN), list)
  })

  it('collapses back to the default value when the edit undoes itself', () => {
    let list = moveEntry(resolveSidebarMenu(null, KNOWN), 0, 3)
    list = moveEntry(list, 3, 0)
    assert.deepEqual(toSidebarPrefs(list, KNOWN, null), { order: [], hidden: [] })
  })

  it('keeps ids from a newer device in place when an older build saves', () => {
    const prev = { order: ['inbox', 'today', 'search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity'], hidden: ['inbox', 'graph'] }
    const list = setEntryHidden(resolveSidebarMenu(prev, KNOWN), 'graph', false)
    const saved = toSidebarPrefs(list, KNOWN, prev)
    assert.deepEqual(saved.order, prev.order)
    assert.deepEqual(saved.hidden, ['inbox'])
  })

  it('moveEntry ignores out-of-range moves', () => {
    const list = resolveSidebarMenu(null, KNOWN)
    assert.deepEqual(moveEntry(list, 0, -1), list)
    assert.deepEqual(moveEntry(list, 7, 8), list)
  })
})

// 0.13 (docs/adr/1641-*): a person who never arranged the sidebar starts with four menus; whatever
// someone saved keeps meaning what it meant (every menu not in `hidden` shows).
describe('default-hidden menus (0.13)', () => {
  const DH = SIDEBAR_MENU_DEFAULT_HIDDEN

  it('new default: search, later, due, calendar', () => {
    assert.deepEqual(visibleSidebarMenu(null, CURRENT, DH), ['search', 'later', 'due', 'calendar'])
    assert.deepEqual(visibleSidebarMenu({ order: [], hidden: [] }, CURRENT, DH), ['search', 'later', 'due', 'calendar'])
  })

  it('a saved value is read as before: only its own hidden ids are hidden', () => {
    assert.deepEqual(visibleSidebarMenu({ order: [], hidden: ['graph'] }, CURRENT, DH), CURRENT.filter((id) => id !== 'graph'))
    const order = ['today', 'search', 'later', 'threads', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity']
    assert.deepEqual(visibleSidebarMenu({ order, hidden: [] }, CURRENT, DH), order)
  })

  it('the new default saves as the empty value', () => {
    assert.deepEqual(toSidebarPrefs(resolveSidebarMenu(null, CURRENT, DH), CURRENT, null, DH), { order: [], hidden: [] })
  })

  it('showing every menu in the default order is stored explicitly, so it does not read back as the new default', () => {
    let list = resolveSidebarMenu(null, CURRENT, DH)
    for (const id of DH) list = setEntryHidden(list, id, false)
    const saved = toSidebarPrefs(list, CURRENT, null, DH)
    assert.deepEqual(saved, { order: CURRENT, hidden: [] })
    assert.deepEqual(visibleSidebarMenu(saved, CURRENT, DH), CURRENT)
  })

  it('hiding one more menu from the new default keeps the others hidden', () => {
    const list = setEntryHidden(resolveSidebarMenu(null, CURRENT, DH), 'later', true)
    const saved = toSidebarPrefs(list, CURRENT, null, DH)
    assert.deepEqual(visibleSidebarMenu(saved, CURRENT, DH), ['search', 'due', 'calendar'])
  })
})

describe('fitting the menus above the page tree (docs/adr/1640-*)', () => {
  it('tree minimum: 40 % of the sidebar height, between 200 and 280 px', () => {
    assert.equal(sidebarTreeMinHeight(480), 200)
    assert.equal(sidebarTreeMinHeight(600), 240)
    assert.equal(sidebarTreeMinHeight(900), 280)
    assert.equal(sidebarTreeMinHeight(1280), 280)
  })

  it('every menu when they fit', () => {
    assert.equal(menusThatFit({ count: 4, available: 200, rowHeight: 32 }), 4)
    assert.equal(menusThatFit({ count: 10, available: 320, rowHeight: 32 }), 10)
  })

  it('otherwise as many as fit with one row left for "more"', () => {
    assert.equal(menusThatFit({ count: 10, available: 319, rowHeight: 32 }), 8)
    assert.equal(menusThatFit({ count: 10, available: 152, rowHeight: 32 }), 3)
  })

  it('never negative; no room → only the "more" row', () => {
    assert.equal(menusThatFit({ count: 10, available: 20, rowHeight: 32 }), 0)
    assert.equal(menusThatFit({ count: 10, available: -50, rowHeight: 32 }), 0)
  })

  it('a bad row height shows everything (measurement not ready)', () => {
    assert.equal(menusThatFit({ count: 10, available: 100, rowHeight: 0 }), 10)
  })

  it('the footer turns into one row of icons below 720 px', () => {
    assert.equal(compactSidebarFooter(480), true)
    assert.equal(compactSidebarFooter(719), true)
    assert.equal(compactSidebarFooter(720), false)
    assert.equal(compactSidebarFooter(0), false) // not measured yet
  })
})

describe('"More" opened: every folded menu shows (docs/adr/1643-*)', () => {
  it('the tree gives way down to 120 px, never more than its folded minimum', () => {
    assert.equal(expandedTreeMinHeight(280), 120)
    assert.equal(expandedTreeMinHeight(200), 120)
    assert.equal(expandedTreeMinHeight(90), 90)
  })

  it('1280×620, ten menus: "More (4)" folded, all ten when opened, no scroll', () => {
    // sidebar 620, other rows 129 → tree minimum 248, available 243
    const available = 243
    const treeMin = 248
    const shown = menusThatFit({ count: 10, available, rowHeight: 32 })
    assert.equal(shown, 6)
    assert.deepEqual(expandedMenusLayout({ count: 10, available, treeMin, rowHeight: 32 }), { treeMin: 120, maxHeight: null })
  })

  it('opened rows + "Show less" + the smaller tree never exceed the folded budget', () => {
    for (const asideH of [420, 480, 560, 620, 700, 800, 900]) {
      const treeMin = sidebarTreeMinHeight(asideH)
      const available = asideH - 129 - treeMin
      for (let count = 1; count <= 10; count++) {
        const { treeMin: floor, maxHeight } = expandedMenusLayout({ count, available, treeMin, rowHeight: 32 })
        const listH = maxHeight == null ? count * 32 : maxHeight + 24
        if (menusThatFit({ count, available, rowHeight: 32 }) < count) {
          assert.ok(listH + 32 + floor <= asideH - 129 || maxHeight === 32, `${asideH} px, ${count} menus`)
        }
      }
    }
  })

  it('a very short sidebar (1280×420): the list scrolls in whole rows above a "k more below" row', () => {
    // sidebar 420, other rows 129 → tree minimum 200, available 91: one menu and "More (9)"
    assert.equal(menusThatFit({ count: 10, available: 91, rowHeight: 32 }), 1)
    assert.deepEqual(expandedMenusLayout({ count: 10, available: 91, treeMin: 200, rowHeight: 32 }), { treeMin: 120, maxHeight: 96 })
  })

  it('at least one row even with no room; an unmeasured row height shows everything', () => {
    assert.deepEqual(expandedMenusLayout({ count: 10, available: -200, treeMin: 200, rowHeight: 32 }), { treeMin: 120, maxHeight: 32 })
    assert.deepEqual(expandedMenusLayout({ count: 10, available: 50, treeMin: 200, rowHeight: 0 }), { treeMin: 120, maxHeight: null })
  })

  it('rows out of view: a row cut by an edge counts as hidden', () => {
    const rows = (scrollTop: number) => rowsOutOfView({ count: 10, rowHeight: 32, scrollTop, clientHeight: 96 })
    assert.deepEqual(rows(0), { above: 0, below: 7 })
    assert.deepEqual(rows(0.5), { above: 0, below: 7 }) // fractional scroll position
    assert.deepEqual(rows(16), { above: 1, below: 7 })
    assert.deepEqual(rows(96), { above: 3, below: 4 })
    assert.deepEqual(rows(224), { above: 7, below: 0 }) // scrolled to the end
    assert.deepEqual(rowsOutOfView({ count: 4, rowHeight: 32, scrollTop: 0, clientHeight: 200 }), { above: 0, below: 0 })
    assert.deepEqual(rowsOutOfView({ count: 4, rowHeight: 0, scrollTop: 0, clientHeight: 0 }), { above: 0, below: 0 })
  })
})
