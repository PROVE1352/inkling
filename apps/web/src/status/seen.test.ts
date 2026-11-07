// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Admin status banner: the same problem at most once a day (docs/adr/1233-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { freshProblems, markShown, problemId, SEEN_TTL_MS } from './seen'

const NOW = Date.parse('2026-11-08T09:00:00Z')
const A = { key: 'backup.lastRun', level: 'warn' }
const B = { key: 'security.secretKey', level: 'warn' }

describe('admin status banner: once a day', () => {
  it('a problem shown less than 24 h ago stays quiet; a new one or a worse level shows', () => {
    const seen = markShown([A], {}, NOW - 3600_000)
    assert.deepEqual(freshProblems([A], seen, NOW), [])
    assert.deepEqual(freshProblems([A, B], seen, NOW), [B])
    const worse = { ...A, level: 'error' }
    assert.deepEqual(freshProblems([worse], seen, NOW), [worse])
    assert.deepEqual(freshProblems([A], seen, NOW - 3600_000 + SEEN_TTL_MS), [A])
  })

  it('drops expired entries, ignores stamps from the future and stays bounded', () => {
    const old = { [problemId(B)]: NOW - 2 * SEEN_TTL_MS }
    assert.deepEqual(Object.keys(markShown([A], old, NOW)), [problemId(A)])
    assert.deepEqual(freshProblems([A], { [problemId(A)]: NOW + 60_000 }, NOW), [A])
    const many = Array.from({ length: 150 }, (_, i) => ({ key: `k${i}`, level: 'warn' }))
    assert.equal(Object.keys(markShown(many, {}, NOW)).length, 100)
  })
})
