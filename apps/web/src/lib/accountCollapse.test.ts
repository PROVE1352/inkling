// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountCollapseKey, readAccountCollapsed, writeAccountCollapsed } from './accountCollapse'

const memory = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    size: () => m.size,
  }
}

test('account block: expanded by default, remembered per person, failures read as expanded', () => {
  const s = memory()
  assert.equal(readAccountCollapsed(s, 'u1'), false, 'default is expanded (as before 0.26)')
  writeAccountCollapsed(s, 'u1', true)
  assert.equal(readAccountCollapsed(s, 'u1'), true)
  assert.equal(readAccountCollapsed(s, 'u2'), false, 'another person on the same browser keeps their own')
  assert.equal(s.getItem(accountCollapseKey('u1')), '1')
  writeAccountCollapsed(s, 'u1', false)
  assert.equal(readAccountCollapsed(s, 'u1'), false)
  assert.equal(s.size(), 0, 'expanded removes the key')
  // no storage, no user, a throwing storage
  assert.equal(readAccountCollapsed(null, 'u1'), false)
  assert.equal(readAccountCollapsed(s, undefined), false)
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(readAccountCollapsed(broken, 'u1'), false)
  assert.doesNotThrow(() => writeAccountCollapsed(broken, 'u1', true))
})
