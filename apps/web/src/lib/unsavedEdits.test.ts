// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Unsaved-edit tracking for the leave guards and the indicator (docs/adr/1926-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUnsavedTracker, showUnsaved, UNSAVED_SHOW_AFTER_MS } from './unsavedEdits'

describe('unsaved edits', () => {
  it('a (re)sync alone is not an unsaved edit: unsyncedChanges is reset to 1 on every sync', () => {
    const t = createUnsavedTracker()
    const p = {}
    t.track(p)
    t.unsynced(p, 1)
    assert.equal(t.anyUnsaved(), false)
  })

  it('a local edit is unsaved until the provider is back at 0', () => {
    const t = createUnsavedTracker()
    const p = {}
    t.track(p)
    t.localEdit(p)
    t.unsynced(p, 1)
    assert.equal(t.isUnsaved(p), true)
    t.unsynced(p, 2)
    t.unsynced(p, 1)
    assert.equal(t.anyUnsaved(), true, 'still one update out')
    t.unsynced(p, 0)
    assert.equal(t.anyUnsaved(), false)
  })

  it('offline: edits stay unsaved across the reconnect reset until acknowledged', () => {
    const t = createUnsavedTracker()
    const p = {}
    t.track(p)
    t.localEdit(p) // typed while disconnected: nothing is sent, the count only grows
    t.unsynced(p, 3)
    t.unsynced(p, 1) // reconnect: startSync resets to 1
    assert.equal(t.anyUnsaved(), true)
    t.unsynced(p, 0)
    assert.equal(t.anyUnsaved(), false)
  })

  it('read-only and denied documents never hold the tab', () => {
    const t = createUnsavedTracker()
    const p = {}
    t.track(p)
    t.localEdit(p)
    t.unsynced(p, 1)
    t.inert(p, true)
    assert.equal(t.anyUnsaved(), false)
  })

  it('any of several documents; untracking a released one', () => {
    const t = createUnsavedTracker()
    const a = {}
    const b = {}
    t.track(a)
    t.track(b)
    t.localEdit(b)
    assert.equal(t.anyUnsaved(), true)
    t.untrack(b)
    assert.equal(t.anyUnsaved(), false)
  })

  it('the indicator waits so normal typing never flashes it', () => {
    let now = 1_000
    const t = createUnsavedTracker(() => now)
    const p = {}
    t.track(p)
    let calls = 0
    t.subscribe(() => calls++)
    t.localEdit(p)
    assert.equal(t.unsavedSince(), 1_000)
    assert.equal(showUnsaved(t.unsavedSince(), 1_000 + UNSAVED_SHOW_AFTER_MS - 1), false)
    assert.equal(showUnsaved(t.unsavedSince(), 1_000 + UNSAVED_SHOW_AFTER_MS), true)
    now = 5_000
    t.unsynced(p, 0)
    assert.equal(t.unsavedSince(), null)
    assert.ok(calls >= 2)
  })

  it('edits stored on the device copy are unsent but not at risk: the leave guard does not ask (docs/adr/2204-*)', () => {
    const t = createUnsavedTracker()
    const p = {}
    t.track(p)
    t.localEdit(p)
    t.unsynced(p, 1)
    assert.equal(t.anyAtRisk(), true)
    t.durable(p, true)
    assert.equal(t.anyUnsaved(), true, 'still not on the server: the indicator stays')
    assert.equal(t.anyAtRisk(), false)
    t.durable(p, false) // a later write to the device failed
    assert.equal(t.anyAtRisk(), true)
    t.unsynced(p, 0)
    assert.equal(t.anyAtRisk(), false)
  })
})
