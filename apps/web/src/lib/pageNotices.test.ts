// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/pageNotices.test.ts
// Stateless notices by document name and the coalesced refresh they trigger (docs/adr/2557-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNoticeRefresher, emitPageNotice, noticeKind, onPageNotice } from './pageNotices'

/** Manual timers: `run()` fires what is pending. */
function fakeTimers() {
  let seq = 0
  const pending = new Map<number, () => void>()
  return {
    set: (fn: () => void) => {
      pending.set(++seq, fn)
      return seq
    },
    clear: (h: number) => void pending.delete(h),
    pending: () => pending.size,
    run() {
      const fns = [...pending.values()]
      pending.clear()
      for (const f of fns) f()
    },
  }
}

describe('page notices', () => {
  it('noticeKind reads t of an object payload, null for anything else', () => {
    assert.equal(noticeKind('{"t":"suggestions"}'), 'suggestions')
    assert.equal(noticeKind('{"t":"comments"}'), 'comments')
    assert.equal(noticeKind('{"gen":3}'), null)
    assert.equal(noticeKind('"suggestions"'), null)
    assert.equal(noticeKind('null'), null)
    assert.equal(noticeKind('{not json'), null)
  })

  it('delivers by document name only; a throwing listener does not stop the others; unsubscribe works', () => {
    const got: string[] = []
    const offA = onPageNotice('page-a', () => {
      throw new Error('boom')
    })
    const offB = onPageNotice('page-a', (p) => got.push(`a:${p}`))
    const offC = onPageNotice('page-b', (p) => got.push(`b:${p}`))
    emitPageNotice('page-a', 'x')
    emitPageNotice('page-c', 'y')
    offB()
    emitPageNotice('page-a', 'z')
    emitPageNotice('page-b', 'w')
    offA()
    offC()
    assert.deepEqual(got, ['a:x', 'b:w'])
  })

  it('coalesces a burst into one refresh per page, ignores other kinds, shares one watch between callers', () => {
    const t = fakeTimers()
    const refreshed: string[] = []
    const watch = createNoticeRefresher('suggestions', (id) => refreshed.push(id), 200, t)
    const un1 = watch('p1')
    const un2 = watch('p1') // a second component on the same page
    const un3 = watch('p2')
    for (let i = 0; i < 5; i++) emitPageNotice('p1', '{"t":"suggestions"}')
    emitPageNotice('p1', '{"t":"comments"}')
    emitPageNotice('p1', 'garbage')
    emitPageNotice('p2', '{"t":"suggestions"}')
    assert.equal(t.pending(), 2) // one trailing timer per page
    t.run()
    assert.deepEqual(refreshed.sort(), ['p1', 'p2'])
    un1()
    emitPageNotice('p1', '{"t":"suggestions"}')
    t.run()
    assert.deepEqual(refreshed.sort(), ['p1', 'p1', 'p2']) // still watched by the second caller
    un2()
    un2() // twice is harmless
    emitPageNotice('p1', '{"t":"suggestions"}')
    assert.equal(t.pending(), 0) // nobody watches p1 any more
    // unwatching drops a pending refresh
    emitPageNotice('p2', '{"t":"suggestions"}')
    assert.equal(t.pending(), 1)
    un3()
    assert.equal(t.pending(), 0)
    assert.deepEqual(refreshed.sort(), ['p1', 'p1', 'p2'])
  })
})
