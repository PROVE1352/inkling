// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Run: cd apps/server && npx tsx --test ../web/src/lib/perf.test.ts
// Unit checks for the web performance changes (docs/adr/0700-*, 0701-*, 0704-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { codeBlockOptions as upstream } from '@blocknote/code-block'
import { sameUsers } from './collabSocket'
import { trimUndoStack } from './undoCap'
import { supportedLanguages } from './codeBlockOptions'

describe('sameUsers (0700)', () => {
  const a = [{ clientId: 1, name: 'A', color: '#111' }]
  it('equal lists compare equal', () => {
    assert.equal(sameUsers(a, [{ clientId: 1, name: 'A', color: '#111' }]), true)
  })
  it('any field change is a change', () => {
    assert.equal(sameUsers(a, [{ clientId: 2, name: 'A', color: '#111' }]), false)
    assert.equal(sameUsers(a, [{ clientId: 1, name: 'B', color: '#111' }]), false)
    assert.equal(sameUsers(a, [{ clientId: 1, name: 'A', color: '#222' }]), false)
    assert.equal(sameUsers(a, []), false)
  })
})

describe('trimUndoStack (0701)', () => {
  function setup(n) {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    const um = new Y.UndoManager(text, { captureTimeout: 0 })
    for (let i = 0; i < n; i++) {
      text.insert(text.length, `w${i} `)
      um.stopCapturing()
    }
    return { doc, text, um }
  }
  it('keeps the newest `limit` captures and undo still works', () => {
    const { text, um } = setup(120)
    assert.equal(um.undoStack.length, 120)
    assert.equal(trimUndoStack(um, 50), 70)
    assert.equal(um.undoStack.length, 50)
    const before = text.toString()
    um.undo()
    assert.ok(text.toString().length < before.length)
    assert.ok(!text.toString().includes('w119 '))
    // only the kept captures can be undone; the trimmed prefix stays
    for (let i = 0; i < 100; i++) um.undo()
    assert.equal(text.toString(), Array.from({ length: 70 }, (_, i) => `w${i} `).join(''))
  })
  it('un-keeps structs deleted by dropped captures', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    const um = new Y.UndoManager(text, { captureTimeout: 0 })
    text.insert(0, 'abcdef')
    um.stopCapturing()
    text.delete(0, 3) // capture #2 deletes "abc" → kept for undo
    um.stopCapturing()
    let kept = 0
    for (let it = text._start; it; it = it.right) if (it.deleted && it.keep) kept++
    assert.ok(kept > 0)
    trimUndoStack(um, 0)
    kept = 0
    for (let it = text._start; it; it = it.right) if (it.deleted && it.keep) kept++
    assert.equal(kept, 0)
    assert.equal(um.undoStack.length, 0)
  })
  it('no-op under the limit', () => {
    const { um } = setup(10)
    assert.equal(trimUndoStack(um, 50), 0)
    assert.equal(um.undoStack.length, 10)
  })
})

describe('codeBlockOptions language table (0704)', () => {
  it('matches @blocknote/code-block verbatim', () => {
    assert.deepEqual(supportedLanguages, upstream.supportedLanguages)
  })
})
