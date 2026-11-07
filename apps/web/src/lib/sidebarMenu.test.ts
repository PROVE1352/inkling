// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/sidebarMenu.test.ts
// Sidebar menu customization: stored { order, hidden } + this build's menus → what the sidebar shows (docs/adr/1020-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SIDEBAR_MENU_IDS } from '@inkling/shared'
import { moveEntry, resolveSidebarMenu, setEntryHidden, toSidebarPrefs, visibleSidebarMenu } from './sidebarMenu'

const KNOWN = ['search', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today']

describe('visibleSidebarMenu', () => {
  it('the shared default list is the current sidebar order', () => {
    assert.deepEqual([...SIDEBAR_MENU_IDS], KNOWN)
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
