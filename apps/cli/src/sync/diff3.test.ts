// Run: cd apps/cli && npx tsx --test src/sync/diff3.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { joinLines, matchLines, merge3 } from './diff3'

const base = 'a\nb\nc\nd\ne\n'

describe('merge3', () => {
  it('merges edits on different lines', () => {
    const r = merge3(base, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')
    assert.equal(r.conflicts.length, 0)
    assert.equal(joinLines(r.lines), 'a\nB\nc\nD\ne\n')
  })
  it('accepts identical changes on both sides', () => {
    assert.equal(joinLines(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\n').lines), 'a\nX\nc\nd\ne\n')
  })
  it('reports a conflict for the same line', () => {
    const r = merge3(base, 'a\nX\nc\nd\ne\n', 'a\nY\nc\nd\ne\n')
    assert.equal(r.conflicts.length, 1)
    assert.equal(r.conflicts[0].baseStart, 2)
    assert.deepEqual(r.lines, ['a', '<<<<<<< local', 'X', '=======', 'Y', '>>>>>>> server', 'c', 'd', 'e'])
  })
  it('merges inserts at both ends and deletes', () => {
    assert.equal(joinLines(merge3(base, 'z\na\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\nw\n').lines), 'z\na\nb\nc\nd\ne\nw\n')
    assert.equal(joinLines(merge3(base, 'a\nc\nd\ne\n', 'a\nb\nc\nd\n').lines), 'a\nc\nd\n')
  })
  it('an empty base with different sides is a conflict', () => {
    assert.equal(merge3('', 'x\n', 'y\n').conflicts.length, 1)
  })
  it('merges large files quickly', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const l = [...big]
    l[100] = 'local'
    const s = [...big]
    s[19_000] = 'server'
    const t0 = performance.now()
    const r = merge3(joinLines(big), joinLines(l), joinLines(s))
    assert.ok(performance.now() - t0 < 500)
    assert.equal(r.conflicts.length, 0)
    assert.equal(r.lines[100], 'local')
    assert.equal(r.lines[19_000], 'server')
  })
})

describe('matchLines (Myers)', () => {
  it('finds a longest common subsequence', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let t = 0; t < 500; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => 'abcd'[Math.floor(rnd() * 4)])
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => 'abcd'[Math.floor(rnd() * 4)])
      const m = matchLines(a, b)!
      let last = -1
      let count = 0
      for (let i = 0; i < a.length; i++) {
        if (m[i] < 0) continue
        assert.ok(m[i] > last && a[i] === b[m[i]])
        last = m[i]
        count++
      }
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      assert.equal(count, dp[0][0])
    }
  })
})
