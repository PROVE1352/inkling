// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/motion.test.ts
// Exit timing and the toast store's exit state (docs/adr/1281-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EXIT_MS, exitDelay, prefersReducedMotion } from './motion'
import { dismissToast, getToasts, toast } from './toast'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('motion', () => {
  it('exit delay is 0 under reduced motion and EXIT_MS otherwise', () => {
    assert.equal(exitDelay(true), 0)
    assert.equal(exitDelay(false), EXIT_MS)
    assert.equal(exitDelay(false, -5), 0)
  })
  it('no window means no reduced-motion preference', () => {
    assert.equal(prefersReducedMotion(), false)
  })
})

describe('toast exit', () => {
  it('a dismissed toast stays as leaving for the exit, then goes', async () => {
    const id = toast({ message: 'a', duration: 0 })
    dismissToast(id, 20)
    const t = getToasts().find((x) => x.id === id)
    assert.equal(t?.leaving, true)
    dismissToast(id, 20) // a second dismiss while leaving is ignored
    assert.equal(getToasts().filter((x) => x.id === id).length, 1)
    await wait(40)
    assert.equal(getToasts().some((x) => x.id === id), false)
  })
  it('without an exit the toast is removed at once', () => {
    const id = toast({ message: 'b', duration: 0 })
    dismissToast(id, 0)
    assert.equal(getToasts().some((x) => x.id === id), false)
  })
  it('the list reference changes on every state change (useSyncExternalStore)', () => {
    const id = toast({ message: 'c', duration: 0 })
    const before = getToasts()
    dismissToast(id, 10)
    assert.notEqual(getToasts(), before)
  })
})
