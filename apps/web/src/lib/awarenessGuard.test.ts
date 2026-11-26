// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/awarenessGuard.test.ts
// Other people's awareness user cleaned in the tab before the cursor plugin draws it (sec26 E-1).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanAwarenessState, FALLBACK_CURSOR_COLOR, guardAwareness, safeCursorColor } from './awarenessGuard'

/** Enough of y-protocols' Awareness: states, and 'change' listeners in the order they were added. */
function fakeAwareness(clientID = 1) {
  const states = new Map<number, unknown>()
  const listeners: ((e: unknown) => void)[] = []
  return {
    clientID,
    getStates: () => states,
    on: (_: string, fn: (e: unknown) => void) => void listeners.push(fn),
    off: (_: string, fn: (e: unknown) => void) => void listeners.splice(listeners.indexOf(fn), 1),
    apply(id: number, state: unknown) {
      const added = !states.has(id)
      states.set(id, state)
      for (const l of [...listeners]) l({ added: added ? [id] : [], updated: added ? [] : [id], removed: [] })
    },
    listeners,
  }
}

describe('awareness guard (sec26 E-1)', () => {
  it('safeCursorColor keeps #rgb and #rrggbb only', () => {
    for (const ok of ['#abc', '#ABCDEF', '#0b6e99']) assert.equal(safeCursorColor(ok), ok)
    for (const bad of ['#000; position: fixed', 5, null, undefined, 'red', 'rgb(0,0,0)', '#abcd', '#aabbcc\n', { a: 1 }])
      assert.equal(safeCursorColor(bad), FALLBACK_CURSOR_COLOR, String(bad))
  })

  it('cleanAwarenessState: colour, name, user', () => {
    const a = { user: { name: 'x', color: '#000; inset: 0', id: 'u' }, cursor: null }
    assert.equal(cleanAwarenessState(a), true)
    assert.deepEqual(a, { user: { name: 'x', color: FALLBACK_CURSOR_COLOR, id: 'u' }, cursor: null })
    const b = { user: { name: 5, color: 5 } }
    assert.equal(cleanAwarenessState(b), true)
    assert.deepEqual(b, { user: { color: FALLBACK_CURSOR_COLOR } })
    const c = { user: 'str' }
    assert.equal(cleanAwarenessState(c), true)
    assert.deepEqual(c, {})
    const d = { user: { name: 'ok', color: '#e03e3e' } }
    assert.equal(cleanAwarenessState(d), false)
    assert.deepEqual(d, { user: { name: 'ok', color: '#e03e3e' } })
    for (const e of [null, undefined, {}, { user: null }, 5]) assert.equal(cleanAwarenessState(e), false)
  })

  it('guardAwareness cleans states already there and every remote state before a later listener sees it', () => {
    const aw = fakeAwareness(1)
    aw.getStates().set(2, { user: { name: 'early', color: 'url(x)' } })
    guardAwareness(aw)
    assert.equal((aw.getStates().get(2) as { user: { color: string } }).user.color, FALLBACK_CURSOR_COLOR)
    const seen: string[] = []
    // the cursor plugin, added after
    aw.on('change', () => seen.push(String((aw.getStates().get(3) as { user?: { color?: unknown } })?.user?.color)))
    aw.apply(3, { user: { name: 'n', color: '#000; position: fixed' } })
    aw.apply(3, { user: { name: 'n', color: 7 } })
    assert.deepEqual(seen, [FALLBACK_CURSOR_COLOR, FALLBACK_CURSOR_COLOR])
    // its own state is not touched
    const mine = { user: { name: 'me', color: 'whatever' } }
    aw.apply(1, mine)
    assert.equal(mine.user.color, 'whatever')
  })
})
